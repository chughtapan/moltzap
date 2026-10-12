/** @file Scoped MCP implementation of the public semantic HarnessEndpoint. */

import {
  Client,
  fromJsonSchema,
  type JsonSchemaType,
  ProtocolError,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  Data,
  Deferred,
  Effect,
  Redacted,
  Ref,
  type Scope,
  Stream,
} from "effect";
import type { DeliveryToken } from "../../store/index.js";
import {
  decodeHarnessReadInboxResult,
  decodeHarnessSendErrorData,
  decodeHarnessSendResult,
  eventIdOf,
} from "../../delivery/operations.js";
import {
  CollectiveError,
  type SendResult,
} from "../../transport/collectives/forms.js";
import {
  DeliveryAcknowledgeError,
  ListenError,
  SendError,
  sendFailureReasons,
} from "../../transport/messaging/errors.js";
import { packageVersion } from "../implementation.js";
import {
  HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
  HARNESS_CONSUMER_META_KEY,
  HARNESS_READ_INBOX_TOOL,
  HARNESS_SEND_META_KEY,
  HARNESS_SEND_TOOL,
  INBOX_ITEM_EVENT,
  INBOX_PENDING_EVENT,
} from "../mcp/names.js";
import {
  ConnectError,
  type HarnessEndpoint,
  type HarnessEndpointOptions,
  type InboundDelivery,
} from "./capability.js";
import { inboxWakeups } from "./events.js";
import { acknowledgeReason, isReason, listenFailure } from "./failures.js";
import { pollWakeups } from "./poll.js";
import { webhookMessages } from "./webhook.js";

/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The official MCP client lifecycle is Promise-native and is converted to Effect at this private edge. */

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const CLIENT_IMPLEMENTATION = {
  name: "moltzap-harness-endpoint",
  version: packageVersion,
} as const;
class CloseError extends Data.TaggedError("CloseError") {}

interface ConnectionOptions {
  readonly delivery: NonNullable<HarnessEndpointOptions["delivery"]>;
  readonly headers: Readonly<Record<string, string>>;
}

type ConsumerRevocation = Deferred.Deferred<never, DeliveryAcknowledgeError>;

interface ConsumerBinding {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly revoked: ConsumerRevocation;
}

/**
 * Acquire one real MCP-backed endpoint and its scoped connection.
 * @param endpoint Explicit MCP URL for the configured endpoint daemon.
 * @param options Redacted runtime grant and optional native receive mode.
 * @returns An endpoint whose resources remain live for the caller's scope.
 *
 * ```mermaid
 * flowchart TD
 *   Options[Runtime grant and receive preference] --> Connect[Scoped official MCP connection]
 *   Connect --> Catalog[Validate advertised Events mode]
 *   Catalog --> Endpoint[Semantic HarnessEndpoint]
 *   Endpoint --> Send[Explicit addressed send]
 *   Endpoint --> Messages[Canonical deliveries with acceptance receipts]
 *   Messages --> Close[Scope releases consumer and SDK connection]
 * ```
 */
export function acquireHarnessEndpoint(
  endpoint: URL,
  options: HarnessEndpointOptions = {},
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope> {
  const address = new URL(endpoint.href);
  if (!safeCredentialEndpoint(address, options.credential)) {
    return Effect.fail(new ConnectError({ reason: "transport-failed" }));
  }
  if (
    typeof options.delivery === "object" &&
    options.credential === undefined
  ) {
    return Effect.fail(new ConnectError({ reason: "incompatible-daemon" }));
  }
  return acquireEndpoint(address, {
    delivery:
      options.delivery ?? (options.credential === undefined ? "push" : "poll"),
    headers:
      options.credential === undefined
        ? {}
        : { Authorization: `Bearer ${Redacted.value(options.credential)}` },
  }).pipe(Effect.withSpan("acquireHarnessEndpoint"));
}

/**
 * A runtime grant travels over TLS except on literal loopback; URL userinfo and fragments are never credentials.
 * @param endpoint Caller-owned MCP address.
 * @param credential Presence requires a protected transport, without examining its value.
 * @returns Whether this URL can carry the configured credential.
 */
function safeCredentialEndpoint(
  endpoint: URL,
  credential?: Redacted.Redacted,
): boolean {
  if (credential === undefined) {
    return true;
  }
  const secure = endpoint.protocol === "https:";
  const loopback =
    endpoint.protocol === "http:" &&
    (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]");
  const plainAddress =
    !endpoint.username && !endpoint.password && !endpoint.hash;
  return (secure || loopback) && plainAddress;
}

function closeClient(client: Client): Effect.Effect<void> {
  return closeQuietly(() => client.close());
}

function closeQuietly(close: () => Promise<void>): Effect.Effect<void> {
  return Effect.tryPromise({ try: close, catch: () => new CloseError() }).pipe(
    Effect.ignore,
  );
}

/**
 * Rebuild the typed error of a refused send from its JSON-RPC error data: a
 * collective failure with its id and detail, or a closed send reason. A
 * rejection that is not the daemon's answer, such as a timeout or a dropped
 * connection, can follow the daemon queueing the post, so it is
 * `outcome-unknown` unless the request never reached the daemon.
 * @param cause Upstream rejection at the MCP tool boundary.
 * @returns A closed send failure without transport details.
 */
function sendFailure(cause: unknown): SendError | CollectiveError {
  if (!ProtocolError.isInstance(cause)) {
    return new SendError({
      reason: neverReachedDaemon(cause)
        ? "network-unavailable"
        : "outcome-unknown",
    });
  }
  return decodeHarnessSendErrorData(cause.data).pipe(
    Effect.map((decoded) =>
      "failure" in decoded
        ? new CollectiveError({ id: decoded.id, failure: decoded.failure })
        : new SendError({
            reason: isReason(decoded.reason, sendFailureReasons)
              ? decoded.reason
              : "network-unavailable",
            ...("detail" in decoded && decoded.detail !== undefined
              ? { detail: decoded.detail }
              : {}),
          }),
    ),
    Effect.orElseSucceed(
      () => new SendError({ reason: "network-unavailable" }),
    ),
    Effect.runSync,
  );
}

/**
 * HTTP statuses that the daemon's HTTP layer, or the MCP server SDK before it
 * dispatches a request, answers with. Any other status may follow a send that
 * ran: the SDK answers 499 for a call it closed mid-dispatch.
 */
const PRE_DISPATCH_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 405,
]);

/**
 * Whether a rejected request certainly ran no daemon tool: the daemon turned
 * it away before dispatch, or the connection was refused.
 * @param cause A rejection that is not a JSON-RPC error.
 * @returns Whether the daemon cannot have acted on the request.
 */
function neverReachedDaemon(cause: unknown): boolean {
  if (SdkHttpError.isInstance(cause)) {
    return PRE_DISPATCH_STATUSES.has(cause.status);
  }
  return (
    cause instanceof Error &&
    cause.cause instanceof Error &&
    "code" in cause.cause &&
    cause.cause.code === "ECONNREFUSED"
  );
}

function callSend(
  client: Client,
  ...[input, options]: Parameters<HarnessEndpoint["send"]>
): Effect.Effect<SendResult, SendError | CollectiveError> {
  return Effect.tryPromise({
    try: (signal) =>
      client.callTool(
        {
          name: HARNESS_SEND_TOOL,
          arguments: { input },
          ...(options === undefined
            ? {}
            : {
                _meta: {
                  [HARNESS_SEND_META_KEY]: {
                    ...(options.idempotencyKey === undefined
                      ? {}
                      : { idempotencyKey: options.idempotencyKey }),
                    ...(options.failureDelivery === undefined
                      ? {}
                      : { failureDelivery: options.failureDelivery }),
                  },
                },
              }),
        },
        { signal },
      ),
    catch: sendFailure,
  }).pipe(
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.fail(new SendError({ reason: "network-unavailable" }))
        : decodeHarnessSendResult(result.structuredContent).pipe(
            Effect.catchTag("ParseError", () =>
              Effect.fail(new SendError({ reason: "network-unavailable" })),
            ),
          ),
    ),
  );
}

function callAcknowledgeDelivery(
  client: Client,
  deliveryToken: DeliveryToken,
  metadata: Readonly<Record<string, unknown>>,
  revoked: ConsumerRevocation,
): Effect.Effect<void, DeliveryAcknowledgeError> {
  const acknowledge = Effect.tryPromise({
    try: (signal) =>
      client.callTool(
        {
          name: HARNESS_ACKNOWLEDGE_DELIVERY_TOOL,
          arguments: { deliveryToken },
          _meta: metadata,
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
  return Deferred.isDone(revoked).pipe(
    Effect.flatMap((closed) =>
      closed ? Deferred.await(revoked) : acknowledge,
    ),
    Effect.raceFirst(Deferred.await(revoked)),
  );
}

const eventsListOutput = fromJsonSchema<{
  events: ReadonlyArray<{ name: string; delivery: readonly string[] }>;
}>({
  type: "object",
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "delivery"],
        properties: {
          name: { type: "string" },
          delivery: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} satisfies JsonSchemaType);

function supportsInboxEvents(
  client: Client,
  delivery: "push" | "poll" | "webhook",
): Effect.Effect<boolean, ConnectError> {
  return Effect.tryPromise({
    try: (signal) =>
      client.request({ method: "events/list", params: {} }, eventsListOutput, {
        signal,
      }),
    catch: (cause) =>
      new ConnectError({
        reason:
          ProtocolError.isInstance(cause) && cause.code === -32601
            ? "incompatible-daemon"
            : "transport-failed",
      }),
  }).pipe(
    Effect.map((catalog) =>
      catalog.events.some(
        (event) =>
          event.name ===
            (delivery === "push" ? INBOX_PENDING_EVENT : INBOX_ITEM_EVENT) &&
          event.delivery.includes(delivery),
      ),
    ),
  );
}

function acquireConnection(
  client: Client,
  endpoint: URL,
  options: ConnectionOptions,
): Effect.Effect<Client, ConnectError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const connected = yield* restore(connect(client, endpoint, options));
      yield* Effect.addFinalizer(() => closeClient(client));
      return connected;
    }),
  );
}

function connect(
  client: Client,
  endpoint: URL,
  options: ConnectionOptions,
): Effect.Effect<Client, ConnectError> {
  return Effect.tryPromise({
    try: (signal) =>
      client.connect(
        new StreamableHTTPClientTransport(endpoint, {
          requestInit: { headers: options.headers },
        }),
        { signal },
      ),
    catch: () => new ConnectError({ reason: "transport-failed" }),
  }).pipe(
    Effect.flatMap(() =>
      supportsInboxEvents(
        client,
        typeof options.delivery === "object"
          ? options.delivery.mode
          : options.delivery,
      ).pipe(
        Effect.flatMap((supported) =>
          supported
            ? Effect.succeed(client)
            : Effect.fail(new ConnectError({ reason: "incompatible-daemon" })),
        ),
      ),
    ),
    Effect.onError(() => closeClient(client)),
  );
}

const decodeInbox = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  result.isError === true
    ? Effect.fail(new ListenError({ reason: "transport-failed" }))
    : decodeHarnessReadInboxResult(result.structuredContent).pipe(
        Effect.catchTag("ParseError", () =>
          Effect.fail(new ListenError({ reason: "decode-failed" })),
        ),
      );

const unseenDeliveries = (
  client: Client,
  seen: Set<DeliveryToken>,
  items: Effect.Effect.Success<
    ReturnType<typeof decodeHarnessReadInboxResult>
  >["items"],
  consumer: ConsumerBinding,
): InboundDelivery[] => {
  const deliveries: InboundDelivery[] = [];
  for (const entry of items) {
    if (seen.has(entry.deliveryToken)) {
      continue;
    }
    seen.add(entry.deliveryToken);
    const acknowledge = callAcknowledgeDelivery(
      client,
      entry.deliveryToken,
      consumer.metadata,
      consumer.revoked,
    );
    deliveries.push({
      eventId: eventIdOf(entry.deliveryToken),
      item: entry.item,
      acknowledge,
    });
  }
  return deliveries;
};

/**
 * Prune completed snapshots so acknowledged history cannot accumulate in a live listener.
 * @param client Scoped connection to the owning daemon.
 * @param seen Tokens already offered by this listener, retained through pending reads.
 * @param consumer Server-issued generation and local consumer lifetime.
 * @returns New deliveries from one complete bounded inbox snapshot.
 */
function pendingInbox(
  client: Client,
  seen: Set<DeliveryToken>,
  consumer: ConsumerBinding,
): Stream.Stream<InboundDelivery, ListenError> {
  const retained = new Set<DeliveryToken>();
  const page = (cursor?: string): Stream.Stream<InboundDelivery, ListenError> =>
    Stream.unwrap(
      Effect.tryPromise({
        try: (signal) =>
          client.callTool(
            {
              name: HARNESS_READ_INBOX_TOOL,
              arguments: cursor === undefined ? {} : { cursor },
              _meta: consumer.metadata,
            },
            { signal },
          ),
        catch: listenFailure,
      }).pipe(
        Effect.flatMap(decodeInbox),
        Effect.map((result) => {
          for (const entry of result.items) {
            retained.add(entry.deliveryToken);
          }
          const current = Stream.fromIterable(
            unseenDeliveries(client, seen, result.items, consumer),
          );
          return result.nextCursor === undefined
            ? current
            : Stream.concat(
                current,
                Stream.suspend(() => page(result.nextCursor)),
              );
        }),
      ),
    );
  return Stream.concat(
    page(),
    Stream.execute(
      Effect.sync(() => {
        for (const token of seen) {
          if (!retained.has(token)) {
            seen.delete(token);
          }
        }
      }),
    ),
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
  endpoint: URL,
  delivery: ConnectionOptions["delivery"],
): Stream.Stream<InboundDelivery, ListenError> {
  return Stream.unwrapScoped(
    Effect.gen(function* () {
      yield* acquireListenerSlot(listenerActive);
      if (typeof delivery === "object") {
        return webhookMessages(client, delivery);
      }
      const revoked = yield* Deferred.make<never, DeliveryAcknowledgeError>();
      const fence = Deferred.fail(
        revoked,
        new DeliveryAcknowledgeError({ reason: "consumer-revoked" }),
      ).pipe(Effect.asVoid);
      yield* Effect.addFinalizer(() => fence);
      const seen = new Set<DeliveryToken>();
      const wakeups: Stream.Stream<
        Readonly<Record<string, unknown>>,
        ListenError
      > =
        delivery === "poll"
          ? pollWakeups(client, fence).pipe(
              Stream.map((generation) => ({
                [HARNESS_CONSUMER_META_KEY]: { generation },
              })),
            )
          : inboxWakeups(endpoint).pipe(Stream.as({}));
      return wakeups.pipe(
        Stream.flatMap((metadata) =>
          pendingInbox(client, seen, { metadata, revoked }),
        ),
      );
    }),
  );
}

function makeMcpClient(): Client {
  return new Client(CLIENT_IMPLEMENTATION, {
    capabilities: {},
    versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
  });
}

function acquireEndpoint(
  endpoint: URL,
  options: ConnectionOptions,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope> {
  return Effect.gen(function* () {
    const client = makeMcpClient();
    yield* acquireConnection(client, endpoint, options);
    const listenerActive = yield* Ref.make(false);
    return {
      send: (input, options) => callSend(client, input, options),
      messages: messages(client, listenerActive, endpoint, options.delivery),
    } satisfies HarnessEndpoint;
  });
}

/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore strict defaults after the Promise-native MCP edge. */

/** The capability this module acquires, and its connect and delivery types. */
export {
  ConnectError,
  type HarnessEndpoint,
  type HarnessEndpointOptions,
  type InboundDelivery,
} from "./capability.js";
