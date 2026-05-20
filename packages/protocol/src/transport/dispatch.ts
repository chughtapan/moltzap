/**
 * @file Auto-provision dispatcher — Spec F G6.
 *
 * Drives one inbound `RequestFrame` through the kind's static handler
 * table. For each frame:
 *   1. Look up the slot by `frame.method`. If the catalog member exists
 *      and the slot is REQUIRED but unbound at construction, the
 *      type system has already rejected the factory call (Spec F I2 —
 *      TS2741) so runtime cannot reach a "required missing" state.
 *      Method not in the kind's catalog → wire `MethodNotFound` -32601.
 *   2. If the slot value is one of the fail-CLOSED sentinels
 *      (`forbidden` / `noOpNotification`), synthesize the wire response
 *      directly from the sentinel's `_tag` (per `defaults.ts`).
 *   3. If the slot is present, read `slot.definition.capabilities`
 *      (Shape B). For each `{ tag, argsOf }` in declaration order:
 *      look up `CapabilityProviderTable[tag.key]`, call it with
 *      `argsOf(decodedParams, ctx)`, and thread
 *      `Effect.provideServiceEffect(tag, providerEffect)` over the
 *      handler effect. Providers execute sequentially with first-failure
 *      short-circuit (Spec F §5.1 step 3).
 *   4. Run the composed handler effect, map outcome to wire
 *      `ResponseFrame` via `wireErrorFromInstance`.
 *
 * Outbound calls / notifications go through the internalized originator
 * (formerly `makeOriginator`'s body, retained as the private helper
 * `makeOriginator` consumed here).
 */
import { Cause, Effect, Exit, type Context, type Scope } from "effect";
import type { TSchema } from "@sinclair/typebox";

import { decodeRpcParams, type RpcDefinition } from "./method.js";
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
  TaskMasterConnection,
  ServerConnectionConfig,
  AgentClientConnectionConfig,
  TaskMasterConnectionConfig,
} from "./connection.js";
import type { HandlerSlot } from "./handlers.js";
import type { CapabilityDescriptor } from "./capabilities.js";
import { FailClosedDefault } from "./defaults.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;
type AnySlot = HandlerSlot<
  AnyRpcDefinition,
  unknown,
  Context.Tag<unknown, unknown>
>;
type WireError = {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
};

/**
 * Erased view of the static handler table: maps wire method names to
 * either a `HandlerSlot` (real implementation) or a `FailClosedDefault`
 * sentinel (`forbidden` / `noOpNotification` — the caller explicitly
 * declined to implement this optional slot). The mapped-type machinery
 * in `handlers.ts` enforces structural shape at the factory call; at
 * runtime the slot lookup is a property access on this record.
 *
 * `undefined` is unreachable for a well-typed literal — every catalog
 * member MUST appear as a key — but the runtime stays defensive so
 * malformed wire frames pointing at unknown methods get `MethodNotFound`.
 */
type ErasedHandlerTable = Readonly<
  Record<string, AnySlot | FailClosedDefault | undefined>
>;

/** Erased view of the provider table — `[tag.key]` → obtain effect. */
type ErasedProviderTable = Readonly<
  Record<string, (args: unknown) => Effect.Effect<unknown, unknown, unknown>>
>;

/**
 * Slot-value sentinel discriminator. Uses the `FailClosedDefault`
 * `Data.taggedEnum`'s built-in `$is` guard so we never hand-parse the
 * `_tag` field; Effect owns the predicate.
 */
const isSlotSentinel = (
  slot: AnySlot | FailClosedDefault,
): slot is FailClosedDefault =>
  FailClosedDefault.$is("Forbidden")(slot) ||
  FailClosedDefault.$is("NoOpNotification")(slot);

/**
 * Type-erase the per-kind handler table at the dispatcher boundary.
 * The factory-side type (`ServerHandlers&lt;Ctx, Caps&gt;` etc.) is a mapped
 * type with literal-named keys; the dispatcher reads slots by frame
 * method name (a runtime string) and needs the structural-record view.
 * Erasure is the design per Spec F §3 carve-out for `unknown` at the
 * private dispatcher plumbing.
 */
const eraseHandlerTable = (table: object): ErasedHandlerTable =>
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- dispatcher-boundary type-erasure (Spec F §3 carve-out); factory-side mapped type has literal-named keys, dispatcher reads by runtime method string
  table as unknown as ErasedHandlerTable; // #ignore-sloppy-code[as-unknown-as]: dispatcher-boundary type-erasure (Spec F §3 carve-out); factory-side mapped type has literal-named keys, dispatcher reads by runtime method string

/**
 * Type-erase the capability provider table at the dispatcher boundary.
 * Same reasoning as `eraseHandlerTable`: per-tag obtain helpers carry
 * tag-specific arg shapes the dispatcher iterates heterogeneously.
 */
const eraseProviderTable = (table: object): ErasedProviderTable =>
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- dispatcher-boundary type-erasure (Spec F §3 carve-out); per-tag obtain helpers re-impose typed args at invocation
  table as unknown as ErasedProviderTable; // #ignore-sloppy-code[as-unknown-as]: dispatcher-boundary type-erasure (Spec F §3 carve-out); per-tag obtain helpers re-impose typed args at invocation

/**
 * Build the server-side dispatcher. Wires the inbound static-table
 * dispatch loop + the outbound originator (TM-callback path) into a
 * single `ServerConnection` value.
 */
export function buildServerDispatcher<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: ServerConnectionConfig<Ctx, Caps>,
): Effect.Effect<ServerConnection<Ctx>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const originator = yield* makeOriginator({
      write: config.write,
      idPrefix: config.idPrefix,
    });
    const dispatch = makeInboundDispatch<Ctx>(
      eraseHandlerTable(config.handlers),
      eraseProviderTable(config.capabilities),
    );
    return {
      id: config.id,
      handle: (frame, ctx) => dispatch(frame, ctx),
      resolve: originator.resolve,
      call: originator.call,
      failAllPending: originator.failAllPending,
      notify: makeNotify(config.write),
    } satisfies ServerConnection<Ctx>;
  }).pipe(Effect.withSpan("buildServerDispatcher"));
}

/**
 * Build the agent-client dispatcher. Wires the originator only (no
 * inbound dispatch — the AgentClient kind's inbound catalog is empty).
 * The empty `notify` shape is `never`-typed at the type level (no
 * call site can satisfy the constraint).
 */
export function buildAgentClientDispatcher<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: AgentClientConnectionConfig<Ctx, Caps>,
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
 * Build the TM dispatcher. Wires both the inbound dispatch loop
 * (against `taskCallbackMethods`) and the outbound originator (against
 * `rpcMethods`). Both TM-inbound slots are OPTIONAL with fail-CLOSED
 * `ForbiddenError` defaults; an empty `{ handlers: {} }` literal
 * produces a TM that responds `Forbidden -32001` to every inbound
 * auth check (Spec F R2).
 */
export function buildTaskMasterDispatcher<
  Ctx,
  Caps extends Context.Tag<any, any>,
>(
  config: TaskMasterConnectionConfig<Ctx, Caps>,
): Effect.Effect<TaskMasterConnection<Ctx>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const originator = yield* makeOriginator({
      write: config.write,
      idPrefix: config.idPrefix,
    });
    const dispatch = makeInboundDispatch<Ctx>(
      eraseHandlerTable(config.handlers),
      eraseProviderTable(config.capabilities),
    );
    return {
      id: config.id,
      handle: (frame, ctx) => dispatch(frame, ctx),
      resolve: originator.resolve,
      call: originator.call,
      failAllPending: originator.failAllPending,
      notify: () =>
        Effect.die(
          "TaskMasterConnection.notify: TM kind originates no notifications",
        ),
    } satisfies TaskMasterConnection<Ctx>;
  }).pipe(Effect.withSpan("buildTaskMasterDispatcher"));
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

// ── Inbound dispatch (static-table loop) ────────────────────────────

/**
 * Build the per-frame inbound dispatcher. Closes over the erased
 * handler + provider tables; the returned function takes one frame +
 * context and produces a wire-ready `ResponseFrame`.
 *
 * Capability auto-provision (Spec F G6): per-definition Shape B
 * metadata (`slot.definition.capabilities`) names each tag the handler
 * `yield*`s. The dispatcher iterates this list, looks up
 * `providers[tag.key]`, calls it with `argsOf(params, ctx)`, and
 * threads `Effect.provideServiceEffect` over the handler effect in
 * declaration order. Sequential execution + first-failure short-circuit
 * per Spec F §5.1 step 3.
 */
function makeInboundDispatch<Ctx>(
  table: ErasedHandlerTable,
  providers: ErasedProviderTable,
) {
  return (
    frame: RequestFrame,
    ctx: Ctx,
  ): Effect.Effect<ResponseFrame, never, never> =>
    Effect.gen(function* () {
      // `JsonRpcMethod` is `string & Brand`; widen to plain string for
      // record/map indexing.
      const method: string = frame.method;
      const slot = table[method];
      if (slot === undefined) {
        // Catalog-membership is type-level enforced — a well-typed
        // factory literal cannot omit a catalog key. Reaching here means
        // a malformed wire frame named a method that isn't in the kind's
        // catalog.
        return methodNotFoundResponse(frame);
      }
      if (isSlotSentinel(slot)) {
        // Caller passed an explicit sentinel (`forbidden` /
        // `noOpNotification`) for this optional slot. Synthesize the
        // matching fail-CLOSED response without invoking a handler.
        return synthesizeFailClosedResponse(frame, slot);
      }

      const paramsResult = yield* Effect.exit(
        decodeRpcParams(slot.definition, frame.params),
      );
      if (Exit.isFailure(paramsResult)) {
        return invalidParamsResponse(frame);
      }

      const startMs = Date.now();
      const handlerEffect = applyCapabilityProvisioning({
        effect: slot.handle(paramsResult.value, ctx),
        capabilities: slot.definition.capabilities ?? [],
        params: paramsResult.value,
        ctx,
        providers,
      });
      // Post-provision R channel is fully covered by the
      // `CapabilityProviderTable` (Spec F I4). The lockstep canary at the
      // handler-table literal site enforces the type-level invariant; at
      // the runtime boundary we erase the residual `R = unknown` to
      // `never` so the surrounding transport's `handle(frame, ctx)` shape
      // resolves to `Effect.Effect<ResponseFrame, never, never>`.
      const handlerExit = yield* Effect.exit(asNeverR(handlerEffect));
      const durationMs = Date.now() - startMs;

      if (Exit.isSuccess(handlerExit)) {
        return yield* successResponse(frame, durationMs, handlerExit.value);
      }
      return yield* failureResponse(frame, durationMs, handlerExit.cause);
    }).pipe(Effect.withSpan("InboundDispatch"));
}

/**
 * Narrow the residual R channel of a fully-provisioned handler effect
 * from `unknown` to `never`. Justification: the lockstep gate in
 * `typed-dispatcher.types-check.ts` ensures every capability tag a
 * handler references appears in `slot.definition.capabilities`, which
 * the dispatcher iterates to thread `provideServiceEffect`. Post-pass,
 * no requirement remains.
 */
const asNeverR = (
  effect: Effect.Effect<unknown, unknown, unknown>,
): Effect.Effect<unknown, unknown, never> =>
  effect as Effect.Effect<unknown, unknown, never>;

interface ProvisioningArgs {
  readonly effect: Effect.Effect<unknown, unknown, unknown>;
  readonly capabilities: ReadonlyArray<CapabilityDescriptor>;
  readonly params: unknown;
  readonly ctx: unknown;
  readonly providers: ErasedProviderTable;
}

/**
 * Spec F G6 / §5.1 step 3: thread `provideServiceEffect` calls for each
 * declared capability in declaration order. `provideServiceEffect` is
 * sequential at the runtime; first-failure short-circuit follows from
 * Effect's standard error semantics (an upstream provider failure
 * propagates through the composed effect without running later
 * providers' obtain helpers).
 *
 * Type-erasure: the handler's R channel is erased to `unknown` at
 * value-level storage; the per-tag `provideServiceEffect` calls
 * structurally compose because each provider's service shape matches
 * its tag's `Identifier`. The compile-time gate
 * (handler R channel ⊆ `CapabilitiesOf&lt;D&gt;`) lives at the
 * handler-table literal site (`typed-dispatcher.types-check.ts`).
 */
function applyCapabilityProvisioning(
  args: ProvisioningArgs,
): Effect.Effect<unknown, unknown, unknown> {
  // Capabilities are applied in REVERSE declaration order so the
  // FIRST-declared provider becomes the OUTERMOST `provideServiceEffect`
  // in the composed pipe — matching the "sequential, declaration-order"
  // contract from Spec F §5.1 step 3 (first provider runs first; its
  // failure short-circuits without running later providers).
  const reversed = [...args.capabilities].reverse();
  return reversed.reduce<Effect.Effect<unknown, unknown, unknown>>(
    (acc, cap) => provideOne(acc, cap, args),
    args.effect,
  );
}

const provideOne = (
  acc: Effect.Effect<unknown, unknown, unknown>,
  cap: CapabilityDescriptor,
  args: ProvisioningArgs,
): Effect.Effect<unknown, unknown, unknown> => {
  const tag = cap.tag;
  // Effect's `Context.Tag` keys its identifier on `tag.key` (per
  // `node_modules/effect/dist/dts/Context.d.ts → interface Tag → readonly key: string`).
  const tagKey = tag.key;
  const provider = args.providers[tagKey];
  if (provider === undefined) {
    // The handler declared a capability with no provider in the table.
    // The lockstep gate at the handler-table literal site
    // (`HandlerSlot.handle.R ⊆ CapabilitiesOf<D>`) catches this at
    // compile time when both sides are non-erased; reaching this
    // branch means either (a) a `defineRpc` declared `capabilities`
    // without a corresponding `CapabilityProviderTable` entry, or
    // (b) the value-level provider table was constructed with a
    // missing tag and the structural type check didn't fire. Fail
    // loud rather than silently skip — silent skip would leave a
    // downstream `Context.NoSuchElementError` deep inside the
    // handler.
    return Effect.die(
      `CapabilityProviderTable missing entry for tag '${tagKey}' declared by definition; ` +
        "every Context.Tag named in `definition.capabilities` must appear in the factory's `capabilities` provider table.",
    );
  }
  const providerEffect = provider(cap.argsOf(args.params, args.ctx));
  return Effect.provideServiceEffect(
    acc,
    tag,
    providerEffect as Effect.Effect<unknown, unknown, never>,
  );
};

/**
 * Synthesize the wire response when the caller passed a sentinel
 * (`forbidden` / `noOpNotification`) for an optional slot.
 *
 * `Forbidden` produces a `ForbiddenError` (-32001) wire response with
 * "Forbidden: &lt;method>" — used for the TM-callback hooks
 * (`DispatchAuthorize`, `MessagesAuthorize`); declining authorization
 * fails-CLOSED, responding "deny" to every inbound auth check.
 *
 * `NoOpNotification` is unreachable on this path: `RequestFrame`s
 * always require a response per JSON-RPC 2.0, so the dispatcher emits
 * `MethodNotFound` to keep the wire contract honest. The branch
 * exists for exhaustiveness over the `FailClosedDefault` enum.
 */
const synthesizeFailClosedResponse = (
  frame: RequestFrame,
  fail: FailClosedDefault,
): ResponseFrame =>
  FailClosedDefault.$match(fail, {
    Forbidden: () =>
      responseFrame(frame.id, {
        error: {
          code: -32001,
          message: `Forbidden: ${frame.method}`,
        },
      }),
    NoOpNotification: () => methodNotFoundResponse(frame),
  });

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
  const message = stringProperty(value, "message") ?? cls.message;
  return wireErrorPayload(cls, message, value.data);
}
