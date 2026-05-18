/**
 * @file `Connection&lt;Ctx>` — the public facade Spec A (#595) introduces.
 *
 * STUB FILE — architect tier, arch sub-issue #603.
 * Interface + constructor signatures only. Bodies live in impl-staff
 * (`throw new Error("not implemented: &lt;symbol>")` per safer:architect
 * SKILL.md convention).
 *
 * Spec sections mapped here:
 *   - Goal §1   — exported `Connection&lt;Ctx>` + `makeServerConnection` /
 *                  `makeClientConnection`
 *   - Goal §2   — `runRaw` + `onRequestDecoded` (inbound pump)
 *   - Goal §3   — `call` / `notify` / `sendError` / `sendParseError` /
 *                  `sendInvalidRequest` / `sendUnauthorized` (outbound)
 *   - Goal §4   — `register` / `unregister` (dynamic handlers)
 *   - "Handler registration contract" — five invariants for the
 *      handler map (key, duplicate-key, idempotent unregister,
 *      idempotent unsubscribe, in-flight, decode-vs-dispatch snapshot)
 *
 * Public-interface signatures are LSP-anchored to existing symbols in
 * `wire.ts` (frame shapes), `method.ts` (definition + ParamsOf/ResultOf),
 * `rpc-registry.ts` (decoded inbound types), and `errors.ts` (tagged
 * error classes). Cite by symbol, never by line (per
 * `feedback_no_line_number_doc_citations`).
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
import type { JsonRpcId } from "../wire.js";
import type {
  ConnectionClosedError,
  ConnectionRunError,
  DuplicateHandlerError,
  RequestTimeoutError,
  RpcCallError,
  SocketWriteError,
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
 *   - `ServerConnection&lt;Ctx>` = `Connection&lt;Ctx, AnyTaskCallbackRpcDefinition, AnyNotificationDefinition>`
 *   - `ClientConnection&lt;Ctx>` = `Connection&lt;Ctx, AnyRpcDefinition,             AnyNotificationDefinition>`
 *
 * Two constructors return the appropriate aliased shape; the type
 * system rejects e.g. `serverConnection.call(ClientOnlyRpc, ...)` at
 * compile time.
 *
 * Generic positions:
 *   - `Ctx`       — handler-thread context (server: pre-auth dispatch
 *                    context with `auth: AuthenticatedContext | null` +
 *                    `connId`; client: `ServerRpcContext` with
 *                    `requestId` + `definition`). Hooks AND handlers
 *                    receive the same `Ctx` so caller-side state flows
 *                    structurally through both seams.
 *   - `OutCall`   — outbound RPC definition set (`AnyTaskCallbackRpcDefinition`
 *                    on server, `AnyRpcDefinition` on client).
 *   - `OutNotify` — outbound notification definition set (currently
 *                    `AnyNotificationDefinition` on both sides; Spec B
 *                    may narrow client-side).
 */
export interface Connection<
  Ctx = unknown,
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
   */
  readonly runRaw: (
    socket: SocketLike,
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
   * The hook's `ctx: ConnectionContext&lt;Ctx>` intersects the caller's
   * `Ctx` with `{ socket: SocketLike }`, so server hooks read both
   * `connId` / `auth` (from `DispatchContext`) AND `socket` without
   * closure-only handwaving.
   */
  readonly onRequestDecoded: (
    hook: (
      req: DecodedRequest,
      ctx: ConnectionContext<Ctx>,
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
  ) => Effect.Effect<
    ResultOf<D>,
    | RpcCallError
    | SocketWriteError
    | ConnectionClosedError
    | RequestTimeoutError,
    never
  >;

  /**
   * Send a notification (no response expected). Spec A Decision D5:
   * `def extends OutNotify` is enforced at the type level — compile-time
   * discrimination, not a runtime branch. The constructor that produced
   * this Connection fixes `OutNotify`.
   */
  readonly notify: <D extends OutNotify>(
    def: D,
    params: NotificationParamsOf<D>,
  ) => Effect.Effect<void, SocketWriteError | ConnectionClosedError, never>;

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
  ) => Effect.Effect<void, SocketWriteError | ConnectionClosedError, never>;

  /**
   * Reserved code -32700 (ParseError). Used by the inbound pump when
   * JSON.parse fails on a frame. Spec A "Golden frames" §6 fixes the
   * wire shape.
   */
  readonly sendParseError: () => Effect.Effect<
    void,
    SocketWriteError | ConnectionClosedError,
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
  ) => Effect.Effect<void, SocketWriteError | ConnectionClosedError, never>;

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
  ) => Effect.Effect<void, SocketWriteError | ConnectionClosedError, never>;

  // ── Dynamic handler registration ───────────────────────────────────

  /**
   * Register a handler for a method. Rejects with `DuplicateHandlerError`
   * if a handler already exists for `def.name`.
   *
   * See "Handler registration contract" in the design doc for the five
   * invariants (key, duplicate-key, idempotent unregister, idempotent
   * unsubscribe, in-flight semantics, decode-vs-dispatch snapshot).
   *
   * Handlers added after construction take effect on the next decoded
   * inbound frame (per the dispatch-time snapshot rule).
   */
  readonly register: <D extends AnyRpcDefinition>(
    def: D,
    handler: RpcHandler<Ctx, D>,
  ) => Effect.Effect<Subscription, DuplicateHandlerError, never>;

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
 */
export type ServerConnection<Ctx = unknown> = Connection<
  Ctx,
  AnyTaskCallbackRpcDefinition,
  AnyNotificationDefinition
>;

/**
 * Client-side Connection. Outbound `call` constrained to the full
 * `AnyRpcDefinition` set (client originates every client→server RPC).
 */
export type ClientConnection<Ctx = unknown> = Connection<
  Ctx,
  AnyRpcDefinition,
  AnyNotificationDefinition
>;

/**
 * Server-side constructor. Inbound shape = `decodeClientInbound`
 * (client → server frames). Returns a `ServerConnection&lt;Ctx>` whose
 * `call` is type-restricted to `AnyTaskCallbackRpcDefinition`.
 *
 * Returns `Effect&lt;ServerConnection&lt;Ctx>, never, Scope.Scope>`:
 * caller owns the scope (per Spec A Invariant "Connection's Effect
 * requirements"). Scope-close runs the correlator finalizer that
 * drains pending calls with `ConnectionClosedError`.
 */
export function makeServerConnection<Ctx = unknown>(
  _config: ConnectionConfig,
): Effect.Effect<ServerConnection<Ctx>, never, Scope.Scope> {
  // Stub: defect (never-channel preserved). Impl-staff fills the body.
  return Effect.dieMessage(
    "not implemented: makeServerConnection (Spec A #595 / arch #603)",
  ) as Effect.Effect<ServerConnection<Ctx>, never, Scope.Scope>;
}

/**
 * Client-side constructor. Inbound shape = `decodeServerInbound`
 * (server → client frames). Returns a `ClientConnection&lt;Ctx>` whose
 * `call` is type-restricted to the full `AnyRpcDefinition` set.
 *
 * Returns `Effect&lt;ClientConnection&lt;Ctx>, never, Scope.Scope>`.
 * Scope-close runs the correlator finalizer that drains pending calls
 * with `ConnectionClosedError`.
 */
export function makeClientConnection<Ctx = unknown>(
  _config: ConnectionConfig,
): Effect.Effect<ClientConnection<Ctx>, never, Scope.Scope> {
  // Stub: defect (never-channel preserved). Impl-staff fills the body.
  return Effect.dieMessage(
    "not implemented: makeClientConnection (Spec A #595 / arch #603)",
  ) as Effect.Effect<ClientConnection<Ctx>, never, Scope.Scope>;
}
