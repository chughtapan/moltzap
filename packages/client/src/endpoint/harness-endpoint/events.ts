/** @file Scoped draft Events reception through the official HTTP transport. */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  StreamableHTTPClientTransport,
  SUBSCRIPTION_ID_META_KEY,
} from "@modelcontextprotocol/client";
import {
  Deferred,
  Effect,
  type ParseResult,
  Queue,
  Schema,
  Stream,
  Take,
} from "effect";
import { randomUUID } from "node:crypto";
import { ListenError } from "../../transport/messaging/errors.js";
import { INBOX_PENDING_EVENT } from "../mcp/names.js";

const protocolVersion = "2026-07-28";
const metadataSchema = Schema.Struct({
  [SUBSCRIPTION_ID_META_KEY]: Schema.Union(Schema.String, Schema.Number),
});
const positionSchema = Schema.Struct({
  cursor: Schema.optionalWith(Schema.Null, { exact: true }),
  _meta: metadataSchema,
});
const eventSchema = Schema.Struct({
  eventId: Schema.NonEmptyString,
  name: Schema.Literal(INBOX_PENDING_EVENT),
  timestamp: Schema.String,
  data: Schema.Struct({ pendingCount: Schema.NonNegativeInt }),
  cursor: Schema.optionalWith(Schema.Null, { exact: true }),
  _meta: metadataSchema,
});
const activeSchema = Schema.Struct({
  ...positionSchema.fields,
  truncated: Schema.Boolean,
});
const errorSchema = Schema.Struct({
  _meta: metadataSchema,
  error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
});

type FrameKind = "active" | "event" | "heartbeat" | "error" | "terminated";
const decodeParams = (
  method: string,
  params: unknown,
): Effect.Effect<
  Pick<typeof positionSchema.Type, "_meta">,
  ParseResult.ParseError
> => {
  switch (method) {
    case "notifications/events/active":
      return Schema.decodeUnknown(activeSchema)(params);
    case "notifications/events/event":
      return Schema.decodeUnknown(eventSchema)(params);
    case "notifications/events/heartbeat":
      return Schema.decodeUnknown(positionSchema)(params);
    default:
      return Schema.decodeUnknown(errorSchema)(params);
  }
};
const frameKind = (method: string): Effect.Effect<FrameKind, ListenError> => {
  switch (method) {
    case "notifications/events/active":
      return Effect.succeed("active");
    case "notifications/events/event":
      return Effect.succeed("event");
    case "notifications/events/heartbeat":
      return Effect.succeed("heartbeat");
    case "notifications/events/error":
      return Effect.succeed("error");
    case "notifications/events/terminated":
      return Effect.succeed("terminated");
    default:
      return Effect.fail(new ListenError({ reason: "decode-failed" }));
  }
};
const decodeFrame = (method: string, params: unknown, id: string) =>
  decodeParams(method, params).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new ListenError({ reason: "decode-failed" })),
    ),
    Effect.flatMap((value) =>
      value._meta[SUBSCRIPTION_ID_META_KEY] === id
        ? frameKind(method)
        : Effect.fail(new ListenError({ reason: "decode-failed" })),
    ),
  );
interface Reception {
  readonly queue: Queue.Queue<Take.Take<boolean, ListenError>>;
  readonly active: Deferred.Deferred<undefined, ListenError>;
  readonly transport: StreamableHTTPClientTransport;
  readonly abort: AbortController;
  readonly id: string;
  stopped: boolean;
  failed: boolean;
  confirmed: boolean;
  queued: boolean;
  lastSeen: number;
}
const fail = (state: Reception, error: ListenError) =>
  Effect.gen(function* () {
    if (state.stopped || state.failed) {
      return;
    }
    state.failed = true;
    yield* Deferred.fail(state.active, error);
    yield* Queue.offer(state.queue, Take.fail(error));
    state.abort.abort();
  });
const wake = (state: Reception) =>
  Effect.suspend(() => {
    if (state.queued || state.stopped || state.failed) {
      return Effect.void;
    }
    state.queued = true;
    return Queue.offer(state.queue, Take.of(true)).pipe(Effect.asVoid);
  });
const receiveFrame = (state: Reception, kind: FrameKind) =>
  Effect.gen(function* () {
    state.lastSeen = Date.now();
    if (kind === "active") {
      state.confirmed = true;
      yield* Deferred.succeed(state.active, undefined);
      yield* wake(state);
    } else if (!state.confirmed) {
      yield* fail(state, new ListenError({ reason: "decode-failed" }));
    } else if (kind === "event") {
      yield* wake(state);
    } else if (kind === "terminated") {
      yield* fail(state, new ListenError({ reason: "transport-failed" }));
    }
  });
const protocolFailure = (data: unknown): ListenError => {
  if (typeof data !== "object" || data === null) {
    return new ListenError({ reason: "transport-failed" });
  }
  return new ListenError({
    reason:
      "reason" in data && data.reason === "already-listening"
        ? "already-listening"
        : "transport-failed",
  });
};
const onMessage =
  (state: Reception): NonNullable<StreamableHTTPClientTransport["onmessage"]> =>
  (message) => {
    if (state.stopped || state.failed) {
      return;
    }
    if ("error" in message) {
      const error =
        message.id === state.id
          ? protocolFailure(message.error.data)
          : new ListenError({ reason: "decode-failed" });
      Effect.runFork(fail(state, error));
    } else if ("method" in message) {
      if (!message.method.startsWith("notifications/events/")) {
        return;
      }
      Effect.runFork(
        decodeFrame(message.method, message.params, state.id).pipe(
          Effect.flatMap((kind) => receiveFrame(state, kind)),
          Effect.catchAll((error) => fail(state, error)),
        ),
      );
    } else {
      Effect.runFork(
        fail(state, new ListenError({ reason: "transport-failed" })),
      );
    }
  };
const close = (state: Reception) =>
  Effect.sync(() => {
    state.stopped = true;
    state.abort.abort();
  }).pipe(
    Effect.zipRight(
      Effect.tryPromise(() => state.transport.close()).pipe(Effect.ignore),
    ),
    Effect.zipRight(Queue.shutdown(state.queue)),
  );
const open = (state: Reception) =>
  Effect.gen(function* () {
    state.transport.onmessage = onMessage(state);
    state.transport.onerror = () => {
      Effect.runFork(
        fail(state, new ListenError({ reason: "transport-failed" })),
      );
    };
    state.transport.setProtocolVersion(protocolVersion);
    yield* Effect.tryPromise({
      try: () => state.transport.start(),
      catch: () => new ListenError({ reason: "transport-failed" }),
    });
    yield* Effect.tryPromise({
      try: () =>
        state.transport.send(
          {
            jsonrpc: "2.0",
            id: state.id,
            method: "events/stream",
            params: {
              name: INBOX_PENDING_EVENT,
              arguments: {},
              cursor: null,
              _meta: {
                [PROTOCOL_VERSION_META_KEY]: protocolVersion,
                [CLIENT_INFO_META_KEY]: { name: "moltzap-inbox", version: "1" },
                [CLIENT_CAPABILITIES_META_KEY]: {},
              },
            },
          },
          {
            requestSignal: state.abort.signal,
            onRequestStreamEnd: () => {
              Effect.runFork(
                fail(state, new ListenError({ reason: "transport-failed" })),
              );
            },
          },
        ),
      catch: () => new ListenError({ reason: "transport-failed" }),
    });
    yield* Deferred.await(state.active);
  }).pipe(
    Effect.timeoutFail({
      duration: "60 seconds",
      onTimeout: () => new ListenError({ reason: "transport-failed" }),
    }),
  );
const watchSilence = (state: Reception) =>
  Effect.sleep("30 seconds").pipe(
    Effect.zipRight(
      Effect.suspend(() =>
        Date.now() - state.lastSeen > 60_000
          ? fail(state, new ListenError({ reason: "transport-failed" }))
          : Effect.void,
      ),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

/**
 * Attach before reading the inbox so arrivals during catch-up remain visible.
 * The official transport supplies framing and cancellation without a request
 * timeout on the retained stream. Notifications contain no message content.
 * @param endpoint Explicit daemon MCP URL.
 * @returns Coalesced inbox wakeups until the owning host subscription ends.
 */
export const inboxWakeups = (
  endpoint: URL,
): Stream.Stream<boolean, ListenError> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Take.Take<boolean, ListenError>>();
      const active = yield* Deferred.make<undefined, ListenError>();
      const state: Reception = {
        queue,
        active,
        transport: new StreamableHTTPClientTransport(endpoint),
        abort: new AbortController(),
        id: randomUUID(),
        stopped: false,
        failed: false,
        confirmed: false,
        queued: false,
        lastSeen: Date.now(),
      };
      yield* Effect.addFinalizer(() => close(state));
      yield* open(state);
      yield* watchSilence(state);
      return Stream.fromQueue(queue).pipe(
        Stream.flattenTake,
        Stream.tap(() =>
          Effect.sync(() => {
            state.queued = false;
          }),
        ),
      );
    }).pipe(Effect.withSpan("inboxWakeups")),
  );
