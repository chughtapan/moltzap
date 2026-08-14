/** @file Scoped MCP implementation of the public semantic HarnessClient. */

import type { Ed25519PublicKey } from "@moltzap/identity";
import {
  Client,
  fromJsonSchema,
  type JsonSchemaType,
  type McpSubscription,
  ProtocolError,
  StreamableHTTPClientTransport,
  type SubscriptionFilter,
} from "@modelcontextprotocol/client";
import { Data, Effect, Queue, type Scope, Stream, Take } from "effect";
import packageJson from "../package.json" with { type: "json" };
import {
  ConnectError,
  type Content,
  type HarnessClient,
  type HarnessTurn,
  ListenError,
  ReplyError,
  StartError,
  type StartInput,
} from "./contract.js";
import {
  decodeHarnessExtension,
  decodeHarnessTurnEvent,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_REPLY_TOOL,
  HARNESS_START_TOOL,
  HARNESS_TURN_READY_FILTER,
  HARNESS_TURN_READY_NOTIFICATION,
  harnessReplyRequestMeta,
  type ReplyGrant,
  verifyHarnessTurnEvent,
} from "./harness-runtime.js";

/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The official MCP client lifecycle is Promise-native and is converted to Effect at this private edge. */

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const CLIENT_IMPLEMENTATION = {
  name: "moltzap-harness-client",
  version: packageJson.version,
} as const;

class CloseError extends Data.TaggedError("CloseError") {}

const TURN_READY_FILTER: SubscriptionFilter & {
  readonly [HARNESS_TURN_READY_FILTER]: true;
} = { [HARNESS_TURN_READY_FILTER]: true };

const unknownNotificationParams = fromJsonSchema({} satisfies JsonSchemaType);

const closeQuietly = (close: () => Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({ try: close, catch: () => new CloseError() }).pipe(
    Effect.ignore,
  );

const turnPayload = (params: unknown): unknown => {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return params;
  }
  const payload: Record<string, unknown> = { ...params };
  Reflect.deleteProperty(payload, "_meta");
  return payload;
};

interface ReasonPayload {
  readonly reason: unknown;
}

const hasReasonPayload = (value: unknown): value is ReasonPayload =>
  typeof value === "object" && value !== null && "reason" in value;

const operationReason = (cause: unknown): unknown => {
  if (hasReasonPayload(cause)) {
    return cause.reason;
  }
  const protocolData: unknown = ProtocolError.isInstance(cause)
    ? cause.data
    : undefined;
  return hasReasonPayload(protocolData) ? protocolData.reason : undefined;
};

const startReason = (cause: unknown): StartError["reason"] => {
  const reason = operationReason(cause);
  switch (reason) {
    case "intent-conflict":
    case "not-registered":
    case "membership":
    case "persistence":
    case "durability":
    case "reanchor":
    case "representation":
      return reason;
    default:
      return "representation";
  }
};

const replyReason = (cause: unknown): ReplyError["reason"] => {
  const reason = operationReason(cause);
  switch (reason) {
    case "authority-unavailable":
    case "persistence":
    case "durability":
    case "reanchor":
    case "representation":
      return reason;
    default:
      return "authority-unavailable";
  }
};

const callStart = (
  client: Client,
  input: StartInput,
): Effect.Effect<void, StartError> =>
  Effect.tryPromise({
    try: (signal) =>
      client.callTool(
        { name: HARNESS_START_TOOL, arguments: { ...input } },
        { signal },
      ),
    catch: (cause) => new StartError({ reason: startReason(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.fail(new StartError({ reason: "representation" }))
        : Effect.void,
    ),
  );

const callReply = (
  client: Client,
  replyGrant: ReplyGrant,
  content: Content,
): Effect.Effect<void, ReplyError> =>
  Effect.tryPromise({
    try: (signal) =>
      client.callTool(
        {
          name: HARNESS_REPLY_TOOL,
          arguments: { content },
          _meta: harnessReplyRequestMeta(replyGrant),
        },
        { signal },
      ),
    catch: (cause) => new ReplyError({ reason: replyReason(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.isError === true
        ? Effect.fail(new ReplyError({ reason: "representation" }))
        : Effect.void,
    ),
  );

const connect = (
  client: Client,
  endpoint: URL,
): Effect.Effect<Client, ConnectError> =>
  Effect.tryPromise({
    try: (signal) =>
      client.connect(new StreamableHTTPClientTransport(endpoint), { signal }),
    catch: () => new ConnectError(),
  }).pipe(
    Effect.onError(() => closeQuietly(() => client.close())),
    Effect.as(client),
  );

const listen = (client: Client): Effect.Effect<McpSubscription, ConnectError> =>
  Effect.tryPromise({
    try: (signal) => client.listen(TURN_READY_FILTER, { signal }),
    catch: () => new ConnectError(),
  });

type TurnQueue = Queue.Queue<Take.Take<HarnessTurn, ListenError>>;

const observeSubscription = (
  subscription: McpSubscription,
  queue: TurnQueue,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => subscription.closed,
    catch: () => new ListenError({ reason: "connection" }),
  }).pipe(
    Effect.matchEffect({
      onFailure: (error) => Queue.offer(queue, Take.fail(error)),
      onSuccess: (closure) =>
        Queue.offer(
          queue,
          closure === "local"
            ? Take.end
            : Take.fail(new ListenError({ reason: "connection" })),
        ),
    }),
    Effect.asVoid,
  );

const readTurn = (
  client: Client,
  registrySignerPublicKey: Ed25519PublicKey,
  params: unknown,
): Effect.Effect<HarnessTurn, ListenError> =>
  decodeHarnessTurnEvent(turnPayload(params)).pipe(
    Effect.flatMap((event) =>
      verifyHarnessTurnEvent(event, registrySignerPublicKey),
    ),
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- The public stream intentionally closes all invalid wire and identity representations as ListenError.
    Effect.mapError(() => new ListenError({ reason: "representation" })),
    Effect.map((event) => ({
      conversationId: event.conversationId,
      peers: event.peers,
      author: event.author,
      content: event.content,
      reply: (content) => callReply(client, event.replyGrant, content),
    })),
  );

const enqueueTurn = (
  client: Client,
  registrySignerPublicKey: Ed25519PublicKey,
  queue: TurnQueue,
  params: unknown,
): Effect.Effect<void> =>
  readTurn(client, registrySignerPublicKey, params).pipe(
    Effect.matchEffect({
      onFailure: (error) => Queue.offer(queue, Take.fail(error)),
      onSuccess: (turn) => Queue.offer(queue, Take.of(turn)),
    }),
    Effect.asVoid,
  );

const registerTurnHandler = (
  client: Client,
  registrySignerPublicKey: Ed25519PublicKey,
  queue: TurnQueue,
): void => {
  client.setNotificationHandler(
    HARNESS_TURN_READY_NOTIFICATION,
    { params: unknownNotificationParams },
    (params) =>
      Effect.runPromise(
        enqueueTurn(client, registrySignerPublicKey, queue, params),
      ),
  );
};

const readRegistrySignerPublicKey = (
  client: Client,
): Effect.Effect<Ed25519PublicKey, ConnectError> =>
  decodeHarnessExtension(client.getServerCapabilities()?.extensions).pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- The public acquisition boundary intentionally exposes one closed compatibility failure.
    Effect.mapError(() => new ConnectError()),
    Effect.map((extension) => extension.registrySignerPublicKey),
  );

const acquireConnection = (
  client: Client,
  endpoint: URL,
): Effect.Effect<Client, ConnectError, Scope.Scope> =>
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned Scope requirement binds this connection to the public scoped acquisition.
  Effect.acquireRelease(connect(client, endpoint), () =>
    closeQuietly(() => client.close()),
  );

const acquireSubscription = (
  client: Client,
): Effect.Effect<McpSubscription, ConnectError, Scope.Scope> =>
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned Scope requirement binds this subscription to the public scoped acquisition.
  Effect.acquireRelease(listen(client), (active) =>
    closeQuietly(() => active.close()),
  );

const makeMcpClient = (): Client =>
  new Client(CLIENT_IMPLEMENTATION, {
    capabilities: { extensions: { [HARNESS_EVENTS_EXTENSION]: {} } },
    versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
  });

const acquireClient = (
  endpoint: URL,
): Effect.Effect<HarnessClient, ConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Take.Take<HarnessTurn, ListenError>>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));

    const client = makeMcpClient();
    yield* acquireConnection(client, endpoint);
    const registrySignerPublicKey = yield* readRegistrySignerPublicKey(client);
    registerTurnHandler(client, registrySignerPublicKey, queue);

    const subscription = yield* acquireSubscription(client);
    yield* Effect.forkScoped(observeSubscription(subscription, queue));

    return {
      start: (input) => callStart(client, input),
      turns: Stream.fromQueue(queue).pipe(Stream.flattenTake),
    } satisfies HarnessClient;
  });

/**
 * Acquire one real MCP-backed client and its sole inbound subscription.
 * @param endpoint Loopback MCP URL for the configured endpoint daemon.
 * @returns A client whose resources remain live for the caller's scope.
 */
export const acquireHarnessClient = (
  endpoint: URL,
): Effect.Effect<HarnessClient, ConnectError, Scope.Scope> =>
  acquireClient(endpoint).pipe(Effect.withSpan("acquireHarnessClient"));

/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore strict defaults after the Promise-native MCP edge. */
