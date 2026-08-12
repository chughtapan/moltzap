/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The official MCP client lifecycle is Promise-native and is converted to Effect at this private adapter edge. */
import {
  Client,
  fromJsonSchema,
  StreamableHTTPClientTransport,
  type JsonSchemaType,
  type McpSubscription,
  type SubscriptionFilter,
} from "@modelcontextprotocol/client";
import { Effect, Queue, Stream, Take, type Scope } from "effect";
import packageJson from "../../package.json" with { type: "json" };
import type { ConversationId } from "@moltzap/protocol/conversation";
import {
  decodeHarnessTurnEvent,
  HARNESS_EVENTS_EXTENSION,
  HARNESS_REPLY_TOOL,
  HARNESS_TURN_READY_FILTER,
  HARNESS_TURN_READY_NOTIFICATION,
  harnessReplyRequestMeta,
  harnessTurnConversationId,
  type HarnessTurnEvent,
} from "./runtime.js";

interface HarnessClientInternalOptions {
  readonly url: string;
}

/**
 * Decoded live observation and its private reply authority.
 * @internal
 */
export interface HarnessTurnInternal {
  readonly event: HarnessTurnEvent;
  readonly reply: (payload: string) => Effect.Effect<void, Error>;
}

/**
 * Package-owned MCP session consumed by the public domain projection.
 * @internal
 */
export interface HarnessClientInternalService {
  readonly callTool: (
    name: string,
    input: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, Error>;
  readonly turns: Stream.Stream<HarnessTurnInternal, Error>;
}

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const CLIENT_IMPLEMENTATION = {
  name: "moltzap-harness-client",
  version: packageJson.version,
} as const;

const TURN_READY_FILTER: SubscriptionFilter & {
  readonly [HARNESS_TURN_READY_FILTER]: true;
} = {
  [HARNESS_TURN_READY_FILTER]: true,
};

const unknownNotificationParams = fromJsonSchema({} satisfies JsonSchemaType);

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const closeQuietly = (close: () => Promise<void>): Effect.Effect<void> =>
  Effect.tryPromise({ try: close, catch: asError }).pipe(Effect.ignore);

const callStructuredTool = (
  client: Client,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Effect.Effect<unknown, Error> =>
  Effect.tryPromise({
    try: (signal) =>
      client.callTool({ name, arguments: { ...input } }, { signal }),
    catch: asError,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.isError === true) {
        // eslint-disable-next-line agent-code-guard/effect-error-erasure -- The private MCP adapter normalizes untyped tool failures to the public client's existing Error contract.
        return Effect.fail(new Error(`Harness MCP tool ${name} failed`));
      }
      if (result.structuredContent === undefined) {
        // eslint-disable-next-line agent-code-guard/effect-error-erasure -- Missing structured content is an incompatible MCP response at the public client's existing Error boundary.
        return Effect.fail(
          new Error(`Harness MCP tool ${name} returned no structured content`),
        );
      }
      return Effect.succeed(result.structuredContent);
    }),
  );

const turnPayload = (params: unknown): unknown => {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return params;
  }
  const payload: Record<string, unknown> = { ...params };
  Reflect.deleteProperty(payload, "_meta");
  return payload;
};

const callReply = (
  client: Client,
  originatingConversationId: ConversationId,
  payload: string,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: (signal) =>
      client.callTool(
        {
          name: HARNESS_REPLY_TOOL,
          arguments: { payload },
          _meta: harnessReplyRequestMeta(originatingConversationId),
        },
        { signal },
      ),
    catch: asError,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.isError === true) {
        // eslint-disable-next-line agent-code-guard/effect-error-erasure -- The raw MCP failure has no portable domain-error contract, so this boundary exposes an ordinary Error.
        return Effect.fail(new Error("Harness reply tool failed"));
      }
      return Effect.void;
    }),
    Effect.asVoid,
  );

const makeTurn = (
  client: Client,
  event: HarnessTurnEvent,
): HarnessTurnInternal => {
  const originatingConversationId = harnessTurnConversationId(event);
  return {
    event,
    reply: (payload) => callReply(client, originatingConversationId, payload),
  };
};

const connect = (client: Client, url: string): Effect.Effect<Client, Error> =>
  Effect.tryPromise({
    try: (signal) =>
      client.connect(new StreamableHTTPClientTransport(new URL(url)), {
        signal,
      }),
    catch: asError,
  }).pipe(
    Effect.onError(() => closeQuietly(() => client.close())),
    Effect.as(client),
  );

const listen = (client: Client): Effect.Effect<McpSubscription, Error> =>
  Effect.tryPromise({
    try: (signal) => client.listen(TURN_READY_FILTER, { signal }),
    catch: asError,
  });

const verifyServerExtension = (client: Client): Effect.Effect<void, Error> => {
  const extensions = client.getServerCapabilities()?.extensions;
  if (
    extensions !== undefined &&
    Object.hasOwn(extensions, HARNESS_EVENTS_EXTENSION)
  ) {
    return Effect.void;
  }
  // eslint-disable-next-line agent-code-guard/effect-error-erasure -- An incompatible MCP peer is rejected at the public client boundary, whose existing error contract is Error.
  return Effect.fail(
    new Error(
      `Harness MCP server does not advertise ${HARNESS_EVENTS_EXTENSION}`,
    ),
  );
};

const observeSubscription = (
  subscription: McpSubscription,
  queue: Queue.Queue<Take.Take<HarnessTurnInternal, Error>>,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => subscription.closed,
    catch: asError,
  }).pipe(
    // The official MCP subscription contract states that `closed` never rejects.
    Effect.orDie,
    Effect.flatMap(() => Queue.offer(queue, Take.end)),
    Effect.asVoid,
  );

/**
 * Acquires the private official-SDK adapter behind the public HarnessClient.
 *
 * @internal
 * @param options Package-owned loopback endpoint options.
 * @returns The scoped structural service consumed by the public facade.
 */
export const acquireHarnessClientInternal = (
  options: HarnessClientInternalOptions,
): Effect.Effect<HarnessClientInternalService, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const queue =
      yield* Queue.unbounded<Take.Take<HarnessTurnInternal, Error>>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));

    const client = new Client(CLIENT_IMPLEMENTATION, {
      capabilities: {
        extensions: { [HARNESS_EVENTS_EXTENSION]: {} },
      },
      versionNegotiation: {
        mode: { pin: MODERN_PROTOCOL_VERSION },
      },
    });

    client.setNotificationHandler(
      HARNESS_TURN_READY_NOTIFICATION,
      { params: unknownNotificationParams },
      (params) =>
        Effect.runPromise(
          decodeHarnessTurnEvent(turnPayload(params)).pipe(
            Effect.matchEffect({
              onFailure: (cause) =>
                Queue.offer(queue, Take.fail(asError(cause))),
              onSuccess: (event) =>
                Queue.offer(queue, Take.of(makeTurn(client, event))),
            }),
            Effect.asVoid,
          ),
        ),
    );

    yield* (
      // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The internal acquisition retains Scope in its return type and the public facade supplies that enclosing scope.
      Effect.acquireRelease(connect(client, options.url), () =>
        closeQuietly(() => client.close()),
      )
    );
    yield* verifyServerExtension(client);
    const subscription = yield* (
      // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The internal acquisition retains Scope in its return type and the public facade supplies that enclosing scope.
      Effect.acquireRelease(listen(client), (subscription) =>
        closeQuietly(() => subscription.close()),
      )
    );
    yield* Effect.forkScoped(observeSubscription(subscription, queue));

    return {
      callTool: (name: string, input: Readonly<Record<string, unknown>>) =>
        callStructuredTool(client, name, input),
      turns: Stream.fromQueue(queue).pipe(Stream.flattenTake),
    };
  }).pipe(Effect.withSpan("acquireHarnessClient"));

/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore strict defaults after the Promise-native MCP adapter edge. */
