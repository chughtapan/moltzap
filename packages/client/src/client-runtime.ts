/** @file Scoped MCP implementation of the public semantic HarnessEndpoint. */

import {
  Client,
  fromJsonSchema,
  type JsonSchemaType,
  type McpSubscription,
  ProtocolError,
  StreamableHTTPClientTransport,
  type SubscriptionFilter,
} from "@modelcontextprotocol/client";
import { Data, Effect, Queue, Ref, type Scope, Stream, Take } from "effect";
import type { DeliveryToken } from "./endpoint/store.js";
import packageJson from "../package.json" with { type: "json" };
import {
  ConnectError,
  DeliveryAcknowledgeError,
  type HarnessEndpoint,
  type InboundDelivery,
  ListenError,
  SendError,
  type SendInput,
} from "./contract.js";
import {
  decodeHarnessEventsExtensionDeclaration,
  decodeHarnessMessageReadyEvent,
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_MESSAGE_READY_FILTER,
  HARNESS_MESSAGE_READY_NOTIFICATION,
  HARNESS_SEND_TOOL,
} from "./harness-mcp-contract.js";

/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The official MCP client lifecycle is Promise-native and is converted to Effect at this private edge. */

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const CLIENT_IMPLEMENTATION = {
  name: "moltzap-harness-endpoint",
  version: packageJson.version,
} as const;
class CloseError extends Data.TaggedError("CloseError") {}

const MESSAGE_READY_FILTER: SubscriptionFilter & {
  readonly [HARNESS_MESSAGE_READY_FILTER]: true;
} = {
  [HARNESS_MESSAGE_READY_FILTER]: true,
};

const unknownNotificationParams = fromJsonSchema({} satisfies JsonSchemaType);

const sendReasons: ReadonlyArray<SendError["reason"]> = [
  "invalid-address",
  "unknown-agent",
  "membership-invalid",
  "content-invalid",
  "not-registered",
  "version-mismatch",
  "certification-unavailable",
  "persistence-failed",
  "network-unavailable",
];
const acknowledgeReasons: ReadonlyArray<DeliveryAcknowledgeError["reason"]> = [
  "unknown-delivery",
  "delivery-conflict",
  "persistence-failed",
  "transport-failed",
];
const listenReasons: ReadonlyArray<ListenError["reason"]> = [
  "already-listening",
  "incompatible-daemon",
  "decode-failed",
  "transport-failed",
];

/**
 * Acquire one real MCP-backed endpoint and its scoped connection.
 * @param endpoint Loopback MCP URL for the configured endpoint daemon.
 * @returns An endpoint whose resources remain live for the caller's scope.
 */
export function acquireHarnessEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope> {
  return acquireEndpoint(endpoint).pipe(
    Effect.withSpan("acquireHarnessEndpoint"),
  );
}

function closeClient(client: Client): Effect.Effect<void> {
  return closeQuietly(() => client.close());
}

function closeSubscription(subscription: McpSubscription): Effect.Effect<void> {
  return closeQuietly(() => subscription.close());
}

function closeQuietly(close: () => Promise<void>): Effect.Effect<void> {
  return Effect.tryPromise({ try: close, catch: () => new CloseError() }).pipe(
    Effect.ignore,
  );
}

interface ReasonPayload {
  readonly reason: unknown;
}

function sendReason(cause: unknown): SendError["reason"] {
  const reason = operationReason(cause);
  return isReason(reason, sendReasons) ? reason : "network-unavailable";
}

function acknowledgeReason(cause: unknown): DeliveryAcknowledgeError["reason"] {
  const reason = operationReason(cause);
  return isReason(reason, acknowledgeReasons) ? reason : "transport-failed";
}

function listenReason(cause: unknown): ListenError["reason"] {
  const reason = operationReason(cause);
  return isReason(reason, listenReasons) ? reason : "transport-failed";
}

function operationReason(cause: unknown): unknown {
  if (hasReasonPayload(cause)) {
    return cause.reason;
  }
  const protocolData: unknown = ProtocolError.isInstance(cause)
    ? cause.data
    : undefined;
  return hasReasonPayload(protocolData) ? protocolData.reason : undefined;
}

function hasReasonPayload(value: unknown): value is ReasonPayload {
  return typeof value === "object" && value !== null && "reason" in value;
}

function isReason<Reason>(
  value: unknown,
  allowed: readonly Reason[],
): value is Reason {
  return allowed.some((candidate) => candidate === value);
}

function callSend(
  client: Client,
  input: SendInput,
): Effect.Effect<void, SendError> {
  return Effect.tryPromise({
    try: (signal) =>
      client.callTool(
        { name: HARNESS_SEND_TOOL, arguments: { ...input } },
        { signal },
      ),
    catch: (cause) => new SendError({ reason: sendReason(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.fail(new SendError({ reason: "network-unavailable" }))
        : Effect.void,
    ),
  );
}

function callAcknowledgeDelivery(
  client: Client,
  deliveryToken: DeliveryToken,
): Effect.Effect<void, DeliveryAcknowledgeError> {
  return Effect.tryPromise({
    try: (signal) =>
      client.callTool(
        {
          name: HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
          arguments: { deliveryToken },
        },
        { signal },
      ),
    catch: (cause) =>
      new DeliveryAcknowledgeError({ reason: acknowledgeReason(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.fail(
            new DeliveryAcknowledgeError({ reason: "transport-failed" }),
          )
        : Effect.void,
    ),
  );
}

function hasExactEventsExtension(client: Client): boolean {
  const experimental = client.getServerCapabilities()?.experimental;
  const extension = experimental?.[HARNESS_EVENTS_EXTENSION];
  return Effect.runSync(
    decodeHarnessEventsExtensionDeclaration(extension).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    ),
  );
}

function acquireConnection(
  client: Client,
  endpoint: URL,
): Effect.Effect<Client, ConnectError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const connected = yield* restore(connect(client, endpoint));
      yield* Effect.addFinalizer(() => closeClient(client));
      return connected;
    }),
  );
}

function connect(
  client: Client,
  endpoint: URL,
): Effect.Effect<Client, ConnectError> {
  return Effect.tryPromise({
    try: (signal) =>
      client.connect(new StreamableHTTPClientTransport(endpoint), { signal }),
    catch: () => new ConnectError({ reason: "transport-failed" }),
  }).pipe(
    Effect.flatMap(() =>
      hasExactEventsExtension(client)
        ? Effect.succeed(client)
        : Effect.fail(new ConnectError({ reason: "incompatible-daemon" })),
    ),
    Effect.onError(() => closeClient(client)),
  );
}

function acquireSubscription(
  client: Client,
): Effect.Effect<McpSubscription, ListenError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const subscription = yield* restore(listen(client));
      yield* Effect.addFinalizer(() => closeSubscription(subscription));
      return subscription;
    }),
  );
}

function listen(client: Client): Effect.Effect<McpSubscription, ListenError> {
  return Effect.tryPromise({
    try: (signal) => client.listen(MESSAGE_READY_FILTER, { signal }),
    catch: (cause) => new ListenError({ reason: listenReason(cause) }),
  });
}

type DeliveryQueue = Queue.Queue<Take.Take<InboundDelivery, ListenError>>;

function observeSubscription(
  subscription: McpSubscription,
  queue: DeliveryQueue,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => subscription.closed,
    catch: () => new ListenError({ reason: "transport-failed" }),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => Queue.offer(queue, Take.fail(error)),
      onSuccess: (closure) =>
        Queue.offer(
          queue,
          closure === "local"
            ? Take.end
            : Take.fail(new ListenError({ reason: "transport-failed" })),
        ),
    }),
    Effect.asVoid,
  );
}

function enqueueDelivery(
  client: Client,
  queue: DeliveryQueue,
  params: unknown,
): Effect.Effect<void> {
  return readDelivery(client, params).pipe(
    Effect.matchEffect({
      onFailure: (error) => Queue.offer(queue, Take.fail(error)),
      onSuccess: (delivery) => Queue.offer(queue, Take.of(delivery)),
    }),
    Effect.asVoid,
  );
}

function readDelivery(
  client: Client,
  params: unknown,
): Effect.Effect<InboundDelivery, ListenError> {
  return decodeHarnessMessageReadyEvent(notificationPayload(params)).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new ListenError({ reason: "decode-failed" })),
    ),
    Effect.map((event) => ({
      message: event.message,
      acknowledge: callAcknowledgeDelivery(client, event.deliveryToken),
    })),
  );
}

function notificationPayload(params: unknown): unknown {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return params;
  }
  const payload: Record<string, unknown> = { ...params };
  Reflect.deleteProperty(payload, "_meta");
  return payload;
}

function registerMessageHandler(client: Client, queue: DeliveryQueue): void {
  client.setNotificationHandler(
    HARNESS_MESSAGE_READY_NOTIFICATION,
    { params: unknownNotificationParams },
    (params) => Effect.runPromise(enqueueDelivery(client, queue, params)),
  );
}

function acquireListenerSlot(
  active: Ref.Ref<boolean>,
): Effect.Effect<void, ListenError, Scope.Scope> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const acquired = yield* Ref.modify(active, (isActive) =>
        isActive
          ? ([false, true] satisfies [boolean, boolean])
          : ([true, true] satisfies [boolean, boolean]),
      ).pipe(
        Effect.filterOrFail(
          (slotAcquired) => slotAcquired,
          () => new ListenError({ reason: "already-listening" }),
        ),
      );
      yield* Effect.addFinalizer(() => Ref.set(active, false));
      return acquired;
    }).pipe(Effect.asVoid),
  );
}

function messages(
  client: Client,
  listenerActive: Ref.Ref<boolean>,
): Stream.Stream<InboundDelivery, ListenError> {
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      yield* acquireListenerSlot(listenerActive);
      const queue =
        yield* Queue.unbounded<Take.Take<InboundDelivery, ListenError>>();
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      registerMessageHandler(client, queue);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          client.removeNotificationHandler(HARNESS_MESSAGE_READY_NOTIFICATION);
        }),
      );
      const subscription = yield* acquireSubscription(client);
      yield* Effect.forkScoped(observeSubscription(subscription, queue));
      return Stream.fromQueue(queue).pipe(Stream.flattenTake);
    }),
  );
}

function makeMcpClient(): Client {
  return new Client(CLIENT_IMPLEMENTATION, {
    capabilities: {
      experimental: { [HARNESS_EVENTS_EXTENSION]: {} },
    },
    versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
  });
}

function acquireEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope> {
  return Effect.gen(function* () {
    const client = makeMcpClient();
    yield* acquireConnection(client, endpoint);
    const listenerActive = yield* Ref.make(false);
    return {
      send: (input) => callSend(client, input),
      messages: messages(client, listenerActive),
    } satisfies HarnessEndpoint;
  });
}

/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore strict defaults after the Promise-native MCP edge. */
