/**
 * @file Cast-free inbound dispatcher — #705 HALF-1.
 *
 * Drives one inbound `RequestFrame` through the kind's keyed
 * {@link ErasedSlotTable}. For each frame:
 *   1. Look up the slot by `frame.method` (a wire-dynamic string). An
 *      unknown method → wire `MethodNotFound` -32601.
 *   2. Call `slot.invoke(frame.params, ctx)`. The slot is built at its wrap
 *      site by {@link makeMiddlewareSlot}: `invoke` decodes params via the
 *      method's OWN validator, runs the pre-composed gated body that
 *      discharges THIS method's declared capabilities via a STATIC per-arm
 *      `provideServiceEffect` chain (#705 HALF-2 — no runtime fold), runs
 *      the handler, and returns the `Exit`. NO `eraseHandlerTable` /
 *      `eraseProviderTable` / `asNeverR` cascade — the per-frame caps are
 *      discharged INSIDE the slot; only the service `Env` rides out.
 *   3. Project the `Exit` into a wire `ResponseFrame` via
 *      `wireErrorFromInstance`.
 *
 * ```mermaid
 * flowchart TD
 *   A[RequestFrame] --> B{slots[method]?}
 *   B -- undefined --> Bx[MethodNotFound -32601]
 *   B -- ErasedSlot --> C[slot.invoke params ctx]
 *   C --> D[slot decodes via own validator]
 *   D -- decode fail --> Dx[InvalidParams -32602]
 *   D -- ok --> E[slot discharges declared caps&lt;br&gt;from positional providers tuple]
 *   E --> F[handler runs under Env]
 *   F --> G[Exit]
 *   G -- success --> Gs[successResponse]
 *   G -- tagged failure --> Gt[knownWireErrorResponse]
 *   G -- untagged --> Gu[internalErrorResponse -32603]
 * ```
 *
 * The dispatcher's residual `R` is `Env` (the `FullLive` service-tag
 * union the surrounding `ManagedRuntime` resolves at request time), NOT
 * `never`: capabilities are discharged inside each slot; the runtime
 * provides `Env`.
 *
 * Outbound calls / notifications go through the internalized originator.
 */
import { Cause, Effect, Exit, type Scope } from "effect";

import {
  JSON_RPC_RESERVED_CODES,
  isRegisteredErrorInstance,
  type RpcErrorClass,
} from "./wire-errors.js";
import {
  responseFrame,
  type NotificationFrame,
  type RequestFrame,
  type ResponseFrame,
} from "./wire.js";
import { makeOriginator } from "./originator.js";
import type {
  ServerConnection,
  AgentClientConnection,
  AppClientConnection,
  ServerConnectionConfig,
  AgentClientConnectionConfig,
  AppClientConnectionConfig,
} from "./connection.js";
import type { ErasedSlotTable, SlotDispatchContext } from "./erased-slot.js";

/**
 * The JSON-RPC error envelope a handler/middleware failure encodes onto: the
 * coded `error` sub-object the client reconstructs the typed tagged error from
 * via `wire-errors.ts → errorClassFor`. The same shape `WireErrorSchema`
 * decodes to and the `PrincipalResolution` / per-method `AuthMiddleware`
 * `failure` channels carry.
 */
export type WireError = {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
};

/**
 * Build the server-side dispatcher. Wires the inbound slot-table
 * dispatch loop + the outbound originator (app-callback path) into a
 * single `ServerConnection` value. `Env` is the slot table's residual
 * service-tag union; `Conn` is the server's three-arm `Connection`.
 */
export function buildServerDispatcher<Env, Conn>(
  config: ServerConnectionConfig<Env, Conn>,
): Effect.Effect<ServerConnection<Env, Conn>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const originator = yield* makeOriginator({
      write: config.write,
      idPrefix: config.idPrefix,
    });
    const dispatch = makeInboundDispatch<Env, Conn>(config.slots);
    return {
      id: config.id,
      handle: (frame, ctx) => dispatch(frame, ctx),
      resolve: originator.resolve,
      call: originator.call,
      failAllPending: originator.failAllPending,
      notify: makeNotify(config.write),
    } satisfies ServerConnection<Env, Conn>;
  }).pipe(Effect.withSpan("buildServerDispatcher"));
}

/**
 * Build the agent-client dispatcher. Wires the originator only (no
 * inbound dispatch — the AgentClient kind's inbound catalog is empty,
 * so `config.slots` is the empty table `{}`). The empty `notify` shape
 * is `never`-typed at the type level (no call site can satisfy the
 * constraint).
 */
export function buildAgentClientDispatcher<Env, Conn>(
  config: AgentClientConnectionConfig<Env, Conn>,
): Effect.Effect<AgentClientConnection, never, Scope.Scope> {
  return Effect.gen(function* () {
    const originator = yield* makeOriginator({
      write: config.write,
      idPrefix: config.idPrefix,
    });
    return {
      id: config.id,
      resolve: originator.resolve,
      call: originator.call,
      failAllPending: originator.failAllPending,
      notify: () =>
        Effect.die(
          "AgentClientConnection.notify: AgentClient kind originates no notifications",
        ),
    } satisfies AgentClientConnection;
  }).pipe(Effect.withSpan("buildAgentClientDispatcher"));
}

/**
 * Build the app-client dispatcher. Wires both the inbound dispatch loop
 * (against `appCallbackMethods`) and the outbound originator (against
 * `serverRpcMethods`). Spec D3 R14b made every app-inbound slot
 * REQUIRED: callers must register a handler for each catalog method;
 * vacuous-deny moderators bind an explicit `ForbiddenError` handler.
 */
export function buildAppClientDispatcher<Env, Conn>(
  config: AppClientConnectionConfig<Env, Conn>,
): Effect.Effect<AppClientConnection<Env, Conn>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const originator = yield* makeOriginator({
      write: config.write,
      idPrefix: config.idPrefix,
    });
    const dispatch = makeInboundDispatch<Env, Conn>(config.slots);
    return {
      id: config.id,
      handle: (frame, ctx) => dispatch(frame, ctx),
      resolve: originator.resolve,
      call: originator.call,
      failAllPending: originator.failAllPending,
      notify: () =>
        Effect.die(
          "AppClientConnection.notify: app-client kind originates no notifications",
        ),
    } satisfies AppClientConnection<Env, Conn>;
  }).pipe(Effect.withSpan("buildAppClientDispatcher"));
}

// ── Notify (outbound notifications) ─────────────────────────────────

/**
 * Outbound notification — server kind only. Encodes the frame and
 * delegates to `write`; never correlates a response (per JSON-RPC 2.0
 * notification semantics). Write errors are swallowed and logged by
 * the surrounding transport; the public `notify` shape is
 * `Effect&lt;void&gt;`.
 */
type AnyNotifyDefinition = {
  readonly encode: (params: unknown) => NotificationFrame;
};
function makeNotify(write: (raw: string) => Effect.Effect<void, unknown>) {
  return ((definition: unknown, params: unknown) =>
    Effect.gen(function* () {
      const frame = (definition as AnyNotifyDefinition).encode(params);
      yield* write(JSON.stringify(frame)).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning("notification write failed", cause),
        ),
      );
    }).pipe(Effect.withSpan("ServerConnection.notify"))) as never;
}

// ── Inbound dispatch (slot-table loop) ──────────────────────────────

/**
 * Build the per-frame inbound dispatcher. Closes over the kind's
 * {@link ErasedSlotTable}; the returned function takes one frame +
 * `SlotDispatchContext&lt;Conn&gt;` and produces a wire-ready `ResponseFrame`.
 *
 * The slot owns its own param decode + capability discharge (see
 * {@link makeMiddlewareSlot}); the dispatcher only routes by `frame.method`
 * and projects the slot's `Exit` into a wire response. The slot's
 * `invoke` returns `Effect&lt;Exit&lt;unknown,unknown&gt;, never, Env&gt;`: a wire
 * `MethodNotFound` for an out-of-catalog method, otherwise the slot's
 * decoded-and-discharged outcome. The residual `R` is `Env`, resolved
 * by the surrounding `ManagedRuntime` at request time.
 */
function makeInboundDispatch<Env, Conn>(table: ErasedSlotTable<Env, Conn>) {
  return (
    frame: RequestFrame,
    ctx: SlotDispatchContext<Conn>,
  ): Effect.Effect<ResponseFrame, never, Env> =>
    Effect.gen(function* () {
      // `JsonRpcMethod` is `string & Brand`; widen to plain string for
      // record indexing. The lookup is wire-dynamic — a remote can name
      // any string — so an unknown method yields `undefined`.
      const method: string = frame.method;
      const slot = table[method];
      if (slot === undefined) {
        return methodNotFoundResponse(frame);
      }

      const startMs = Date.now();
      // The slot decodes params via its OWN validator and discharges its
      // declared capabilities INSIDE `invoke`; the residual `R` is `Env`.
      // `invoke` returns the inner `Exit` (NOT a failed effect) so a
      // params-decode failure surfaces as a success-typed `Exit.Failure`
      // we project to `InvalidParams`.
      const slotExit = yield* slot.invoke(frame.params, ctx);
      const durationMs = Date.now() - startMs;

      if (Exit.isSuccess(slotExit)) {
        return yield* successResponse(frame, durationMs, slotExit.value);
      }
      // A params-decode failure inside the slot surfaces as a tagged
      // `RpcParamsDecodeError` in the cause; map it to `InvalidParams`.
      // Everything else routes through the tagged-error / internal map.
      if (isParamsDecodeFailureCause(slotExit.cause)) {
        return invalidParamsResponse(frame);
      }
      return yield* failureResponse(frame, durationMs, slotExit.cause);
    }).pipe(Effect.withSpan("InboundDispatch"));
}

/**
 * Recognise a params-decode failure surfaced by a slot's `invoke`
 * (`decodeRpcParams` fails with an `RpcParamsDecodeError`-tagged value;
 * see `method.ts`). The slot returns the inner `Exit`, so the decode
 * failure rides the cause's failure channel; map it to the wire
 * `InvalidParams -32602` rather than the generic internal error.
 */
const isParamsDecodeFailureCause = (cause: Cause.Cause<unknown>): boolean => {
  const failure = Cause.failureOption(cause);
  return (
    failure._tag === "Some" &&
    isRecord(failure.value) &&
    failure.value._tag === "RpcParamsDecodeError"
  );
};

// ── Response shape helpers (mirrored from json-rpc-server.ts) ───────

const methodNotFoundResponse = (frame: RequestFrame): ResponseFrame =>
  responseFrame(frame.id, {
    error: {
      code: JSON_RPC_RESERVED_CODES.MethodNotFound,
      message: `Method not found: ${frame.method}`,
    },
  });

const invalidParamsResponse = (frame: RequestFrame): ResponseFrame =>
  responseFrame(frame.id, {
    error: {
      code: JSON_RPC_RESERVED_CODES.InvalidParams,
      message: `Invalid params for method: ${frame.method}`,
    },
  });

const successResponse = (
  frame: RequestFrame,
  durationMs: number,
  result: unknown,
): Effect.Effect<ResponseFrame> =>
  Effect.logInfo("RPC request completed").pipe(
    Effect.annotateLogs({
      requestId: frame.id,
      method: frame.method,
      durationMs,
    }),
    Effect.as(responseFrame(frame.id, { result })),
  );

const failureResponse = (
  frame: RequestFrame,
  durationMs: number,
  cause: Cause.Cause<unknown>,
): Effect.Effect<ResponseFrame> => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some") {
    const wireError = wireErrorFromInstance(failure.value);
    if (wireError !== null) {
      return knownWireErrorResponse(frame, durationMs, wireError);
    }
  }
  return internalErrorResponse(frame, durationMs, cause);
};

const knownWireErrorResponse = (
  frame: RequestFrame,
  durationMs: number,
  wireError: WireError,
): Effect.Effect<ResponseFrame> =>
  Effect.logWarning(wireError.message).pipe(
    Effect.annotateLogs({
      requestId: frame.id,
      method: frame.method,
      errorCode: wireError.code,
      durationMs,
    }),
    Effect.as(responseFrame(frame.id, { error: wireError })),
  );

const internalErrorResponse = (
  frame: RequestFrame,
  durationMs: number,
  cause: Cause.Cause<unknown>,
): Effect.Effect<ResponseFrame> =>
  Effect.logError("RPC handler error").pipe(
    Effect.annotateLogs({
      requestId: frame.id,
      method: frame.method,
      cause: Cause.pretty(cause),
      durationMs,
    }),
    Effect.as(
      responseFrame(frame.id, {
        error: {
          code: JSON_RPC_RESERVED_CODES.InternalError,
          message: "Internal error",
        },
      }),
    ),
  );

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  value !== null && typeof value === "object";

const stringProperty = (
  value: Record<PropertyKey, unknown>,
  key: PropertyKey,
): string | undefined => {
  const property = value[key];
  return typeof property === "string" ? property : undefined;
};

const wireErrorPayload = (
  cls: RpcErrorClass,
  message: string,
  data: unknown,
): WireError => {
  if (data === undefined) {
    return {
      code: cls.code,
      message,
    };
  }
  return {
    code: cls.code,
    message,
    data,
  };
};

/**
 * Reads wire metadata (code/message/data) off an `RpcErrorClass` instance.
 * Returns `null` when the failure isn't a registered wire-error class
 * (caller routes to InternalError).
 */
export function wireErrorFromInstance(value: unknown): WireError | null {
  if (!isRecord(value) || !isRegisteredErrorInstance(value)) {
    return null;
  }
  const cls = value.constructor as RpcErrorClass;
  // `Data.TaggedError` instances inherit `message: ""` from `Error`, so a
  // nullish-only fallback (`?? cls.message`) would ship the empty string for
  // any error constructed without an explicit message. Treat an empty
  // instance message as absent so the class's static default reaches the wire.
  const instanceMessage = stringProperty(value, "message");
  const message =
    instanceMessage !== undefined && instanceMessage.length > 0
      ? instanceMessage
      : cls.message;
  return wireErrorPayload(cls, message, value.data);
}
