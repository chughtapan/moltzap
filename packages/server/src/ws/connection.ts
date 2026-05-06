import {
  Data,
  Deferred,
  Effect,
  HashMap,
  Option,
  Ref,
  type Scope,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import {
  isJsonRpcStringId,
  jsonRpcStringId,
  requestFrame,
  type AnyTaskCallbackRpcDefinition,
  type JsonRpcMethod,
  type JsonRpcStringId,
  type ParamsOf,
  type ResponseFrame,
  type ResultOf,
} from "@moltzap/protocol";
import type { AuthenticatedContext } from "../rpc/context.js";

/**
 * Tagged error channel for `sendRpcToClient`. Every public failure mode is
 * a discriminated tag — callers that ignore the channel's totality cannot
 * compile.
 *
 * Phase 9b consumer-migration (sub-issue #460) renamed the protocol-side
 * `appCallbackRpcGroup` to `taskCallbackRpcGroup` after collapsing
 * the appCallback verb set to a single member (`task/authorizeDispatch`).
 * The server-internal `AppDisconnected` / `AppCallbackRpc*` error tags
 * keep the legacy name on purpose: they describe the generic
 * server→client awaitable-RPC pattern (the *transport*), not the
 * protocol group identity. Renaming them would churn every call site
 * for no semantic gain. Phase 11 (arena cutover) is the natural seam
 * if the rename is ever justified.
 */
export class AppDisconnected extends Data.TaggedError("AppDisconnected")<{
  readonly connectionId: string;
  readonly method: JsonRpcMethod;
  readonly requestId: JsonRpcStringId;
}> {}

export class AppCallbackRpcResponseError extends Data.TaggedError(
  "AppCallbackRpcResponseError",
)<{
  readonly connectionId: string;
  readonly method: JsonRpcMethod;
  readonly requestId: JsonRpcStringId;
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

export class AppCallbackRpcDecodeError extends Data.TaggedError(
  "AppCallbackRpcDecodeError",
)<{
  readonly connectionId: string;
  readonly method: JsonRpcMethod;
  readonly requestId: JsonRpcStringId;
  readonly reason: string;
}> {}

export class AppCallbackRpcSocketError extends Data.TaggedError(
  "AppCallbackRpcSocketError",
)<{
  readonly connectionId: string;
  readonly method: JsonRpcMethod;
  readonly requestId: JsonRpcStringId;
  readonly cause: Socket.SocketError;
}> {}

export type AppCallbackRpcError =
  | AppDisconnected
  | AppCallbackRpcResponseError
  | AppCallbackRpcDecodeError
  | AppCallbackRpcSocketError;

/**
 * Per-connection appCallback pending map. Each entry correlates an outbound appCallback
 * request with the `Deferred` that `sendRpcToClient` is awaiting.
 *
 * Entries are inserted by `sendRpcToClient` and drained by either:
 *   - the inbound appCallback response router (`completeAppCallbackResponse`), on success
 *     or typed error response, or
 *   - the connection's `Scope` finalizer (`drainPendingWithAppDisconnected`,
 *     wired by `acquireAppCallbackConnectionState`), which fails every entry with
 *     `AppDisconnected` on disconnect.
 *
 * Routing is local-role disjoint: inbound response-shaped JSON-RPC frames
 * complete this map, while inbound request-shaped frames go through the
 * client-originated RPC router.
 */
export type AppCallbackPendingMap = HashMap.HashMap<
  JsonRpcStringId,
  AppCallbackPendingEntry<unknown>
>;

interface AppCallbackPendingEntry<R> {
  readonly method: JsonRpcMethod;
  readonly deferred: Deferred.Deferred<R, AppCallbackRpcError>;
}

export interface MoltZapConnection {
  id: string;
  /** Write a raw frame to this connection. Fails with SocketError on send
   * failure or if the socket is already closed. */
  write: (raw: string) => Effect.Effect<void, Socket.SocketError>;
  /** Close this connection's scope, tearing down the underlying socket. */
  shutdown: Effect.Effect<void>;
  auth: AuthenticatedContext | null;
  lastPong: number;
  conversationIds: Set<string>;
  mutedConversations: Set<string>;
  /**
   * Per-connection map of pending server-initiated RPC requests.
   * `sendRpcToClient` inserts on send; the inbound appCallback response router
   * (`completeAppCallbackResponse`) deletes + resolves on reply; the connection
   * scope's finalizer (`drainPendingWithAppDisconnected`, wired by
   * `acquireAppCallbackConnectionState`) fails every entry with `AppDisconnected`
   * on disconnect.
   */
  readonly appCallbackPending: Ref.Ref<AppCallbackPendingMap>;
  /**
   * Monotonic counter for minting outbound appCallback request ids
   * (`srv-<connId>-<seq>`). The prefix keeps server-originated ids
   * distinguishable in captures and logs while routing derives from
   * JSON-RPC frame shape.
   */
  readonly appCallbackRequestCounter: Ref.Ref<number>;
}

/**
 * Drain a pending-map Ref by failing every Deferred with
 * `AppDisconnected(connectionId, method, requestId)`. Used by the
 * connection scope finalizer in `acquireAppCallbackConnectionState` and by any
 * direct teardown path. Idempotent — `getAndSet(..., empty())` means a
 * second call observes an empty map and is a no-op.
 */
function drainPendingWithAppDisconnected(
  connectionId: string,
  pendingRef: Ref.Ref<AppCallbackPendingMap>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const pending = yield* Ref.getAndSet(
      pendingRef,
      HashMap.empty<JsonRpcStringId, AppCallbackPendingEntry<unknown>>(),
    );
    for (const [id, entry] of HashMap.entries(pending)) {
      yield* Deferred.fail(
        entry.deferred,
        new AppDisconnected({
          connectionId,
          method: entry.method,
          requestId: id,
        }),
      ).pipe(Effect.ignore);
    }
  });
}

/**
 * Mint the next request id for an outbound appCallback RPC. Format
 * `srv-<connId>-<seq>` distinguishes server-originated ids from ids the client
 * mints (`rpc-N`, `tc-...`, etc.) in logs and captures.
 */
function nextAppCallbackRequestId(
  connection: MoltZapConnection,
): Effect.Effect<JsonRpcStringId> {
  return Ref.modify(connection.appCallbackRequestCounter, (n) => {
    const next = n + 1;
    return [jsonRpcStringId(`srv-${connection.id}-${next}`), next];
  });
}

/**
 * Send an awaitable RPC from server → client over `connection`'s WebSocket.
 *
 * Mechanics (composed entirely from Effect primitives — no bespoke promise
 * pool, no callback registry, no setTimeout retry loop):
 *
 *   1. Mint a fresh request id from the connection's counter.
 *   2. Allocate `Deferred<unknown, AppCallbackRpcError>`.
 *   3. `Effect.acquireUseRelease` around the pending-map pair:
 *      - acquire: register the `{method, deferred}` entry in
 *        `connection.appCallbackPending` keyed by the request id (atomic
 *        `Ref.update`).
 *      - use: encode the JSON-RPC request, write it via `connection.write`,
 *        then `Deferred.await`. Socket
 *        failures fail the Deferred with `AppCallbackRpcSocketError` so the
 *        caller's await observes the failure rather than hanging.
 *      - release: remove the entry from `appCallbackPending` (atomic
 *        `Ref.update`). Fires on success, error, AND interrupt.
 *
 * Cleanup contract (Issue #310). The pending registry insert/remove are
 * an `acquireUseRelease` pair; the entry is removed on success, error,
 * AND interrupt. Interrupt paths covered:
 *
 *   - Caller fiber interrupt (e.g., `Effect.timeout` firing inside a
 *     hook wrapper): release runs, entry removed before the inner exit
 *     unwinds.
 *   - Parent scope teardown mid-await: connection-Scope finalizer
 *     (`drainPendingWithAppDisconnected`) drains the map and fails the
 *     Deferred with `AppDisconnected`; the release then runs an
 *     idempotent `HashMap.remove` (no-op).
 *   - Normal completion via `completeAppCallbackResponse`: removes the entry in
 *     its own atomic `Ref.modify`; release re-removes (no-op).
 *
 * All three paths converge through atomic `Ref` ops on a single map, so
 * no torn state. A late inbound response frame for a request whose
 * caller was interrupted finds `Option.none()` in `completeAppCallbackResponse`
 * and is silently dropped (no panic, no Deferred re-resolve).
 *
 * Caller controls timeout via `Effect.timeout` at the call site — there
 * is NO schema-level cap. Result decoding from `unknown` to a typed
 * verdict happens inside this function: every call passes a typed
 * `AnyTaskCallbackRpcDefinition` whose `validateResult` predicate
 * narrows the response (Phase 9b consumer-migration; the legacy
 * `AppCallbackRpcMap` indirection retired alongside the appCallback
 * group rename).
 */
export function sendRpcToClient<D extends AnyTaskCallbackRpcDefinition>(
  connection: MoltZapConnection,
  definition: D,
  params: ParamsOf<D>,
): Effect.Effect<ResultOf<D>, AppCallbackRpcError, never> {
  return Effect.gen(function* () {
    const method = definition.name;
    const requestId = yield* nextAppCallbackRequestId(connection);
    const deferred = yield* Deferred.make<unknown, AppCallbackRpcError>();
    const frame = requestFrame(requestId, definition, params);
    const raw = JSON.stringify(frame);

    return yield* Effect.acquireUseRelease(
      // acquire: register the pending entry. Atomic `Ref.update` —
      // `completeAppCallbackResponse` and the connection-Scope finalizer key
      // off the same Ref, so all three writers serialize.
      Ref.update(connection.appCallbackPending, (m) =>
        HashMap.set(m, requestId, {
          method,
          deferred,
        } satisfies AppCallbackPendingEntry<unknown>),
      ),
      // use: write the frame, then await the Deferred. Socket failures
      // settle the Deferred so a late inbound frame's `Deferred.succeed`
      // is a no-op via `Effect.ignore` on an already-failed Deferred.
      //
      // Race note (intentional, benign): if the disconnect-finalizer
      // fires between the acquire above and the write below, the
      // finalizer drains the entry first and fails the Deferred with
      // `AppDisconnected`. The write may then fail (socket already
      // closed) and we attempt `Deferred.fail` with `AppCallbackRpcSocketError`
      // — `Effect.ignore` swallows the no-op on an already-settled
      // Deferred. Caller observes whichever completion landed first;
      // both error tags are correct readings of the failure.
      () =>
        Effect.gen(function* () {
          yield* connection.write(raw).pipe(
            Effect.catchAll((cause) => {
              const err = new AppCallbackRpcSocketError({
                connectionId: connection.id,
                method,
                requestId,
                cause,
              });
              return Deferred.fail(deferred, err).pipe(
                Effect.ignore,
                Effect.zipRight(Effect.fail<AppCallbackRpcError>(err)),
              );
            }),
          );
          const result = yield* Deferred.await(deferred);
          if (!definition.validateResult(result)) {
            return yield* Effect.fail(
              new AppCallbackRpcDecodeError({
                connectionId: connection.id,
                method,
                requestId,
                reason: `Invalid result for method: ${method}`,
              }),
            );
          }
          return result as ResultOf<D>;
        }),
      // release: remove the entry. Idempotent — `HashMap.remove` on an
      // already-removed key is a no-op, so this is safe whether
      // `completeAppCallbackResponse` already removed it (success/error path)
      // or the connection-Scope finalizer drained it (disconnect path).
      () =>
        Ref.update(connection.appCallbackPending, (m) =>
          HashMap.remove(m, requestId),
        ),
    );
  });
}

/**
 * Resolve the appCallback pending entry that matches `frame.id`, if any. Called by
 * the inbound appCallback response router on the server's read fiber.
 *
 * Three completion outcomes (totally exhaustive — every well-formed
 * response that arrives lands in exactly one branch):
 *
 *   - `frame.error` present → `Deferred.fail` with `AppCallbackRpcResponseError`.
 *   - `frame.error` absent  → `Deferred.succeed` with `frame.result`.
 *   - id not in map         → returns `Option.none()`; caller decides
 *                              whether to log (likely a stale reply after
 *                              disconnect-finalize already fired).
 *
 * Returns `Option.some(method)` when a pending entry was completed, so the
 * caller can record telemetry or attribute the response to its method.
 */
export function completeAppCallbackResponse(
  connection: MoltZapConnection,
  frame: ResponseFrame,
): Effect.Effect<Option.Option<JsonRpcMethod>> {
  return Effect.gen(function* () {
    if (!isJsonRpcStringId(frame.id)) return Option.none();
    const responseId = frame.id;
    const removed = yield* Ref.modify(connection.appCallbackPending, (m) => {
      const entry = HashMap.get(m, responseId);
      if (Option.isNone(entry)) return [Option.none(), m];
      return [Option.some(entry.value), HashMap.remove(m, responseId)];
    });
    if (Option.isNone(removed)) return Option.none();
    const entry = removed.value;
    if ("error" in frame) {
      yield* Deferred.fail(
        entry.deferred,
        new AppCallbackRpcResponseError({
          connectionId: connection.id,
          method: entry.method,
          requestId: responseId,
          code: frame.error.code,
          message: frame.error.message,
          data: frame.error.data,
        }),
      ).pipe(Effect.ignore);
    } else {
      yield* Deferred.succeed(entry.deferred, frame.result).pipe(Effect.ignore);
    }
    return Option.some(entry.method);
  });
}

/**
 * Acquire the per-connection appCallback machinery and bind a Scope finalizer that
 * fails every still-pending Deferred with `AppDisconnected` when the scope
 * closes. Caller composes this inside the connection's `Effect.scoped`
 * boundary.
 *
 * Returns the Refs the connection record needs. The finalizer registration
 * is a side-effect on the surrounding scope; nothing the caller has to
 * track directly.
 */
export function acquireAppCallbackConnectionState(
  connectionId: string,
): Effect.Effect<
  {
    readonly appCallbackPending: Ref.Ref<AppCallbackPendingMap>;
    readonly appCallbackRequestCounter: Ref.Ref<number>;
  },
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const appCallbackPending = yield* Ref.make<AppCallbackPendingMap>(
      HashMap.empty(),
    );
    const appCallbackRequestCounter = yield* Ref.make(0);
    yield* Effect.addFinalizer(() =>
      drainPendingWithAppDisconnected(connectionId, appCallbackPending),
    );
    return { appCallbackPending, appCallbackRequestCounter };
  });
}

export class ConnectionManager {
  private connections = new Map<string, MoltZapConnection>();

  add(conn: MoltZapConnection): void {
    this.connections.set(conn.id, conn);
  }

  remove(id: string): void {
    this.connections.delete(id);
  }

  get(id: string): MoltZapConnection | undefined {
    return this.connections.get(id);
  }

  all(): MoltZapConnection[] {
    return [...this.connections.values()];
  }

  getByAgent(agentId: string): MoltZapConnection[] {
    return Array.from(this.connections.values()).filter(
      (conn) => conn.auth && conn.auth.agentId === agentId,
    );
  }

  /**
   * Subscribe all currently-connected sockets of the given agents to a
   * conversation. Adds `conversationId` to each matching connection's
   * `conversationIds` set so subsequent `Broadcaster.broadcastToConversation`
   * calls reach those sockets. Idempotent: a connection already subscribed is
   * a no-op (Set semantics). Returns the list of connection ids that were
   * subscribed (for observability + tests).
   *
   * Exposed for downstream apps that create conversations via
   * `ConversationService.create` directly (rather than the `conversations/
   * create` RPC handler, which already does this work internally). Without
   * this helper, every consumer re-implements the same loop and drifts when
   * the subscription shape changes.
   */
  subscribeAgentsToConversation(
    agentIds: readonly string[],
    conversationId: string,
  ): string[] {
    const subscribed: string[] = [];
    const agentSet = new Set(agentIds);
    for (const conn of this.connections.values()) {
      if (!conn.auth) continue;
      if (!agentSet.has(conn.auth.agentId)) continue;
      conn.conversationIds.add(conversationId);
      subscribed.push(conn.id);
    }
    return subscribed;
  }

  entries(): IterableIterator<[string, MoltZapConnection]> {
    return this.connections.entries();
  }

  get size(): number {
    return this.connections.size;
  }
}
