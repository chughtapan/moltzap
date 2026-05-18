/**
 * @file `Connection&lt;CtxPreAuth, CtxPostAuth, …>` — the public facade
 *       Spec A (#595) introduces.
 *
 * STUB FILE — architect tier, arch sub-issue #603.
 * Interface + constructor signatures only. Bodies live in impl-staff
 * (`Effect.dieMessage("not implemented: &lt;symbol>")` per safer:architect
 * SKILL.md convention).
 *
 * Spec sections mapped here:
 *   - Goal §1   — exported `Connection&lt;CtxPreAuth, CtxPostAuth, …>` +
 *                  `makeServerConnection` / `makeClientConnection`
 *   - Goal §2   — `runRaw` + `onRequestDecoded` (inbound pump). r1 F5:
 *                  `runRaw` takes a per-frame `ctxFactory` that
 *                  materializes `CtxPreAuth`.
 *   - Goal §3   — `call` / `notify` / `sendError` / `sendParseError` /
 *                  `sendInvalidRequest` / `sendUnauthorized` (outbound).
 *                  r1 F3: error channels use named union aliases
 *                  (`ConnectionCallError` / `ConnectionWriteError`).
 *   - Goal §4   — `register` / `unregister` (dynamic handlers). r2:
 *                  `register` is overloaded — Connect-binding handler
 *                  is typed against `CtxPreAuth`, every other handler
 *                  against `CtxPostAuth`. See "Auth-establishment
 *                  invariant" below.
 *   - "Handler registration contract" — six invariants for the
 *      handler map (key, duplicate-key, idempotent unregister,
 *      idempotent unsubscribe, in-flight, decode-vs-dispatch snapshot)
 *      + one hook-chain invariant.
 *
 * ## Auth-establishment invariant (r2 — codex P2-r2-1 resolution)
 *
 * The seam between `CtxPreAuth` and `CtxPostAuth` is NOT a single
 * global cast after the hook chain. The bootstrap RPC (`Connect`)
 * deliberately bypasses the auth hook — when its handler runs the
 * non-null `auth` invariant has NOT been established. Every OTHER
 * handler runs only after a registered auth hook has narrowed the
 * runtime invariant. The Connection encodes this by per-definition
 * narrowing the handler-map type:
 *
 *   - `register(Connect, h)`   typed against `RpcHandler&lt;CtxPreAuth, …>`
 *   - `register(OtherDef, h)`  typed against `RpcHandler&lt;CtxPostAuth, …>`
 *
 * The dispatcher branches in ONE switch (`req.definition === Connect`?
 * → CtxPreAuth path : CtxPostAuth path) — see §6.1 of the design doc
 * for the full dataflow. Localizing the type-narrowing here means no
 * unconditional pre→post type-coercion leaks across handlers; the
 * Connect handler sees the pre-auth shape it actually receives.
 *
 * Public-interface signatures are LSP-anchored to existing symbols in
 * `wire.ts` (frame shapes), `method.ts` (definition + ParamsOf/ResultOf),
 * `rpc-registry.ts` (decoded inbound types), `network/methods.ts`
 * (`Connect` — the auth-establishing RPC), and `errors.ts` (tagged
 * error classes + F3 named aliases). Cite by symbol, never by line
 * (per `feedback_no_line_number_doc_citations`).
 */
import { Effect, type Scope } from "effect";
import type { TSchema } from "@sinclair/typebox";
import type {
  NotificationDefinition,
  NotificationParamsOf,
  ParamsOf,
  ResultOf,
  RpcDefinition,
} from "../method.js";
import type { AnyTaskCallbackRpcDefinition } from "../../rpc-registry.js";
import type { Connect } from "../../network/methods.js";
import type { JsonRpcId } from "../wire.js";
import type {
  ConnectionCallError,
  ConnectionRegisterError,
  ConnectionRunError,
  ConnectionWriteError,
} from "../errors.js";
import type {
  ConnectionContext,
  DecodedRequest,
  HookFailure,
  JsonValue,
  RpcHandler,
  Subscription,
} from "./handler.js";
import type { SocketLike } from "./socket-like.js";

type AnyRpcDefinition = RpcDefinition<string, TSchema, TSchema>;
type AnyNotificationDefinition = NotificationDefinition<string, TSchema>;

/**
 * Typed transport facade. Owns the JSON.parse → decode → match →
 * dispatch → encode → write pipeline.
 *
 * Direction is encoded in the generics, NOT a runtime discriminant
 * (Spec A Decision D6):
 *   - `ServerConnection&lt;CtxPreAuth, CtxPostAuth>` =
 *       `Connection&lt;CtxPreAuth, CtxPostAuth, AnyTaskCallbackRpcDefinition, AnyNotificationDefinition>`
 *   - `ClientConnection&lt;CtxPreAuth, CtxPostAuth>` =
 *       `Connection&lt;CtxPreAuth, CtxPostAuth, AnyRpcDefinition, AnyNotificationDefinition>`
 *
 * Two constructors return the appropriate aliased shape; the type
 * system rejects e.g. `serverConnection.call(ClientOnlyRpc, ...)` at
 * compile time.
 *
 * Generic positions (r1 F6 — split pre/post-auth, r2 sound via
 * per-definition register narrowing rather than a global cast):
 *   - `CtxPreAuth`  — visible to `onRequestDecoded` hooks AND to the
 *                      `Connect` handler. Server: `DispatchContextPreAuth`
 *                      with `auth: AuthenticatedContext | null`.
 *                      Client: typically `ServerRpcContext`.
 *   - `CtxPostAuth` — visible to every handler EXCEPT `Connect` —
 *                      i.e. handlers that run only after an auth hook
 *                      has narrowed the runtime invariant. Server:
 *                      `DispatchContext` with non-null `auth`.
 *                      Constrained `CtxPostAuth extends CtxPreAuth` so
 *                      the narrowing is structurally expressible; the
 *                      default makes them equal for callers that don't
 *                      need the split (single-Ctx ergonomics).
 *   - `OutCall`     — outbound RPC definition set (`AnyTaskCallbackRpcDefinition`
 *                      on server, `AnyRpcDefinition` on client).
 *   - `OutNotify`   — outbound notification definition set (currently
 *                      `AnyNotificationDefinition` on both sides; Spec B
 *                      may narrow client-side).
 */
export interface Connection<
  CtxPreAuth = unknown,
  CtxPostAuth extends CtxPreAuth = CtxPreAuth,
  OutCall extends AnyRpcDefinition = AnyRpcDefinition,
  OutNotify extends AnyNotificationDefinition = AnyNotificationDefinition,
> {
  // ── Inbound pump ───────────────────────────────────────────────────

  /**
   * Drive the inbound read loop. Reads frames off `socket.runRaw`,
   * routes them through `decode*Inbound`, dispatches per frame type,
   * and emits responses via `socket.write`.
   *
   * Termination semantics:
   *   - Clean socket close → `Effect.void` (NOT an error)
   *   - Read-side fault    → `SocketReadError` (constituent of
   *                          `ConnectionRunError`)
   *   - Handler-map / dispatcher defect → `DispatchPanic` (constituent
   *                          of `ConnectionRunError`)
   *
   * Per-frame *recoverable* failures (decode errors, schema rejections,
   * hook-rejected auth) are converted to JSON-RPC error responses and
   * consumed INSIDE the pump — they do NOT escape via the Effect's
   * error channel.
   *
   * r1 F5 — `ctxFactory` materializes `CtxPreAuth` per inbound request
   * frame. The factory is invoked once per decoded request before the
   * hook chain fires; its `Effect&lt;CtxPreAuth, never, never>` shape
   * keeps the seam pure and lets impl-staff back it by `Ref.get` /
   * `Effect.succeed` of per-connection state without an escape hatch.
   * Rejected alternatives: (b) `Ref&lt;Ctx>` in `ConnectionConfig` (mutable
   * state, awkward to test); (c) closure-only Ctx with phantom generic
   * (reintroduces the out-of-band closure trick `ConnectionContext`
   * eliminated).
   */
  readonly runRaw: (
    socket: SocketLike,
    ctxFactory: (
      req: DecodedRequest,
    ) => Effect.Effect<CtxPreAuth, never, never>,
  ) => Effect.Effect<void, ConnectionRunError, never>;

  /**
   * Register a pre-dispatch hook fired AFTER frame decode but BEFORE
   * handler dispatch. The integration point Non-goal §3 references
   * for caller-owned auth.
   *
   * Hook success → request proceeds to handler dispatch.
   * Hook failure (`HookFailure`) → request short-circuits with
   *   `connection.sendError(...)` derived from the tagged error's
   *   wire-class registration. The handler is NOT invoked.
   *
   * Multiple hooks compose; hooks fire in registration order. A hook
   * that succeeds yields control to the next; the first failing hook
   * short-circuits the chain. Disposal via `Subscription.unsubscribe`
   * is idempotent.
   *
   * Architect decision (resolves the §9 sync-vs-Effect clarification):
   * lifted to `Effect&lt;Subscription, never, never>` for symmetry with
   * `register` and so impl-staff can back it with a `Ref.update` (no
   * sync-mutation escape hatch). The Effect's error channel is `never`
   * because installation can't fail — duplicate hooks compose; only
   * `register` rejects on duplicate-method conflict.
   *
   * The hook's `ctx: ConnectionContext&lt;CtxPreAuth>` intersects the
   * caller's `CtxPreAuth` with `{ socket: SocketLike }`, so server
   * hooks read both `connId` / nullable `auth` (from
   * `DispatchContextPreAuth`) AND `socket` without closure-only
   * handwaving. The hook fires BEFORE the post-auth narrowing seam;
   * downstream handlers see `CtxPostAuth` only because the dispatcher
   * branches on definition identity (see "Auth-establishment
   * invariant" at top-of-file).
   */
  readonly onRequestDecoded: (
    hook: (
      req: DecodedRequest,
      ctx: ConnectionContext<CtxPreAuth>,
    ) => Effect.Effect<void, HookFailure, never>,
  ) => Effect.Effect<Subscription, never, never>;

  // ── Outbound — RPC + notification ──────────────────────────────────

  /**
   * Send an RPC request, await a response frame, decode the result.
   *
   * Effect requirements channel is `never`: caller provides the
   * surrounding Scope (returned by `makeServerConnection` /
   * `makeClientConnection`).
   *
   * Per-call deadline is caller-owned via `Effect.timeout` at the
   * call site; Connection does not impose one. `RequestTimeoutError`
   * surfaces only when the caller's deadline expires.
   */
  readonly call: <D extends OutCall>(
    def: D,
    params: ParamsOf<D>,
  ) => Effect.Effect<ResultOf<D>, ConnectionCallError, never>;

  /**
   * Send a notification (no response expected). Spec A Decision D5:
   * `def extends OutNotify` is enforced at the type level — compile-time
   * discrimination, not a runtime branch. The constructor that produced
   * this Connection fixes `OutNotify`.
   */
  readonly notify: <D extends OutNotify>(
    def: D,
    params: NotificationParamsOf<D>,
  ) => Effect.Effect<void, ConnectionWriteError, never>;

  // ── Outbound — error responses ─────────────────────────────────────

  /**
   * Generic error responder (Spec A Decision D4 = B). Three named
   * helpers below wrap this with the JSON-RPC reserved codes encoded
   * at the type level for compile-time discrimination.
   */
  readonly sendError: (
    id: JsonRpcId | null,
    code: number,
    message: string,
    data?: JsonValue,
  ) => Effect.Effect<void, ConnectionWriteError, never>;

  /**
   * Reserved code -32700 (ParseError). Used by the inbound pump when
   * JSON.parse fails on a frame. Spec A "Golden frames" §6 fixes the
   * wire shape.
   */
  readonly sendParseError: () => Effect.Effect<
    void,
    ConnectionWriteError,
    never
  >;

  /**
   * Reserved code -32600 (InvalidRequest). Used by the inbound pump
   * when JSON parses but the frame schema rejects the shape. Spec A
   * "Golden frames" §7 fixes the wire shape.
   */
  readonly sendInvalidRequest: (
    id: JsonRpcId | null,
    reason: string,
  ) => Effect.Effect<void, ConnectionWriteError, never>;

  /**
   * Derives the wire code + message from `UnauthorizedError`'s
   * registered metadata via `wireErrorFromInstance(new UnauthorizedError(...))`.
   * Current wire shape: `code: -32000`, `message: "Not authenticated.
   * Send network/connect first."` (cite: `wire-errors.ts → UnauthorizedError`).
   *
   * NOTE: Spec A "Golden frames" §8 lists `code: -32001` for the
   * unauthorized frame; that conflicts with the in-tree
   * `UnauthorizedError.code = -32000` (and `ForbiddenError.code =
   * -32001`). The golden fixture impl-staff captures must follow the
   * in-tree class registry, NOT the spec's literal — i.e. emit
   * `code: -32000`. Flagged for impl-staff fixture authoring.
   */
  readonly sendUnauthorized: (
    id: JsonRpcId | null,
  ) => Effect.Effect<void, ConnectionWriteError, never>;

  // ── Dynamic handler registration ───────────────────────────────────

  /**
   * Register a handler for a method. Rejects with `DuplicateHandlerError`
   * if a handler already exists for `def.name`.
   *
   * See "Handler registration contract" in the design doc for the six
   * invariants (key, duplicate-key, idempotent unregister, idempotent
   * unsubscribe, in-flight semantics, decode-vs-dispatch snapshot) +
   * one hook-chain invariant.
   *
   * Handlers added after construction take effect on the next decoded
   * inbound frame (per the dispatch-time snapshot rule).
   *
   * Per-definition narrowing — single conditional-typed signature so
   * the type-level `Ctx` matches the actual runtime invariant for
   * every definition:
   *
   *   - `Connect` is the auth-establishing bootstrap RPC. The auth
   *      hook short-circuits to `Effect.void` for `Connect` without
   *      narrowing `auth` to non-null. The Connect handler therefore
   *      sees `CtxPreAuth` (nullable `auth`) — typing it against
   *      `CtxPostAuth` would lie about the runtime shape.
   *   - Every OTHER definition runs only after a registered auth hook
   *      has narrowed the invariant. Their handlers see `CtxPostAuth`.
   *
   * The dispatcher branches on `req.definition === Connect` to pick
   * the right `Ctx` per request (§6.1 of the design doc). Localizing
   * the seam here means no unconditional pre→post type coercion
   * leaks across handler calls.
   *
   * Soundness note. The earlier overload-set draft (Connect overload
   * first, default overload `&lt;D extends AnyRpcDefinition>` second)
   * admitted `register(Connect, postAuthHandler)` via the default
   * overload: the Connect overload rejected the post-auth handler
   * under `RpcHandler`'s contravariance in `Ctx`, but the default
   * overload's `D` was not narrowed to exclude `Connect`, so the
   * fall-through accepted it — leaving the dispatcher to pass a
   * `CtxPreAuth` value to a handler typed for `CtxPostAuth` (runtime
   * NPE on `ctx.auth.userId` deref). The single-conditional signature
   * below closes the seam because `D` is inferred ONCE per call: when
   * `D = typeof Connect`, the handler slot's conditional resolves to
   * `RpcHandler&lt;CtxPreAuth, D>`, and the post-auth handler is rejected
   * — there is no second overload to fall through to. The
   * `Parameters&lt;typeof register>[1]` canary at
   * `connection.public-surface.types-check.ts` evaluates the
   * conditional against the generic's constraint
   * (`AnyRpcDefinition extends typeof Connect`? — false), so the
   * default-branch handler-ctx still resolves to `CtxPostAuth` and
   * the bidirectional gate continues to fire.
   */
  readonly register: <D extends AnyRpcDefinition>(
    def: D,
    handler: D extends typeof Connect
      ? RpcHandler<CtxPreAuth, D>
      : RpcHandler<CtxPostAuth, D>,
  ) => Effect.Effect<Subscription, ConnectionRegisterError, never>;

  /**
   * Unregister the handler for `def.name`. Idempotent: a no-op when
   * no handler is currently registered.
   *
   * In-flight handler invocations that have already entered the handler
   * effect run to completion (no cancellation). Newly arriving frames
   * after `unregister` observe the handler map without that entry.
   */
  readonly unregister: <D extends AnyRpcDefinition>(
    def: D,
  ) => Effect.Effect<void, never, never>;
}

// ── Constructors ─────────────────────────────────────────────────────

/**
 * Configuration for the two constructors. `idPrefix` is forwarded to
 * the internal correlator (replaces the legacy `makeJsonRpcClient`
 * `idPrefix` config — server uses `srv-${connId}`, client uses `rpc`).
 */
export interface ConnectionConfig {
  readonly idPrefix: string;
}

/**
 * Server-side Connection. Outbound `call` is constrained to the
 * server→client appCallback set at the type level; the type system
 * rejects accidental dispatch of a client→server method.
 *
 * Imports `AnyTaskCallbackRpcDefinition` from `../../rpc-registry.js`;
 * impl-staff lifts the import when filling the body.
 *
 * Generic split (r1 F6): both `CtxPreAuth` (hooks + Connect handler)
 * and `CtxPostAuth` (handlers post-auth narrowing). Default-equal so
 * callers that don't need the split pass a single type
 * (`ServerConnection&lt;DispatchContext>` → both Pre and Post equal).
 */
export type ServerConnection<
  CtxPreAuth = unknown,
  CtxPostAuth extends CtxPreAuth = CtxPreAuth,
> = Connection<
  CtxPreAuth,
  CtxPostAuth,
  AnyTaskCallbackRpcDefinition,
  AnyNotificationDefinition
>;

/**
 * Client-side Connection. Outbound `call` constrained to the full
 * `AnyRpcDefinition` set (client originates every client→server RPC).
 *
 * Generic split (r1 F6): identical shape to `ServerConnection`; the
 * client side typically uses default-equal `CtxPreAuth = CtxPostAuth`
 * because there's no client-side auth seam.
 */
export type ClientConnection<
  CtxPreAuth = unknown,
  CtxPostAuth extends CtxPreAuth = CtxPreAuth,
> = Connection<
  CtxPreAuth,
  CtxPostAuth,
  AnyRpcDefinition,
  AnyNotificationDefinition
>;

/**
 * Server-side constructor. Inbound shape = `decodeClientInbound`
 * (client → server frames). Returns a
 * `ServerConnection&lt;CtxPreAuth, CtxPostAuth>` whose `call` is
 * type-restricted to `AnyTaskCallbackRpcDefinition`.
 *
 * Returns `Effect&lt;ServerConnection&lt;…>, never, Scope.Scope>`: caller
 * owns the scope (per Spec A Invariant "Connection's Effect
 * requirements"). Scope-close runs the correlator finalizer that
 * drains pending calls with `ConnectionClosedError`.
 *
 * Canonical impl-staff instantiation:
 *   `makeServerConnection&lt;DispatchContextPreAuth, DispatchContext>(config)`
 * — the hook chain + Connect handler see nullable `auth`; every other
 * registered handler sees the non-null `DispatchContext` shape.
 */
export function makeServerConnection<
  CtxPreAuth = unknown,
  CtxPostAuth extends CtxPreAuth = CtxPreAuth,
>(
  _config: ConnectionConfig,
): Effect.Effect<
  ServerConnection<CtxPreAuth, CtxPostAuth>,
  never,
  Scope.Scope
> {
  // Stub: defect (never-channel preserved). Impl-staff fills the body.
  return Effect.dieMessage(
    "not implemented: makeServerConnection (Spec A #595 / arch #603)",
  ) as Effect.Effect<
    ServerConnection<CtxPreAuth, CtxPostAuth>,
    never,
    Scope.Scope
  >;
}

/**
 * Client-side constructor. Inbound shape = `decodeServerInbound`
 * (server → client frames). Returns a
 * `ClientConnection&lt;CtxPreAuth, CtxPostAuth>` whose `call` is
 * type-restricted to the full `AnyRpcDefinition` set.
 *
 * Returns `Effect&lt;ClientConnection&lt;…>, never, Scope.Scope>`.
 * Scope-close runs the correlator finalizer that drains pending calls
 * with `ConnectionClosedError`.
 */
export function makeClientConnection<
  CtxPreAuth = unknown,
  CtxPostAuth extends CtxPreAuth = CtxPreAuth,
>(
  _config: ConnectionConfig,
): Effect.Effect<
  ClientConnection<CtxPreAuth, CtxPostAuth>,
  never,
  Scope.Scope
> {
  // Stub: defect (never-channel preserved). Impl-staff fills the body.
  return Effect.dieMessage(
    "not implemented: makeClientConnection (Spec A #595 / arch #603)",
  ) as Effect.Effect<
    ClientConnection<CtxPreAuth, CtxPostAuth>,
    never,
    Scope.Scope
  >;
}
