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
import type { ResponseFrame, RequestFrame } from "@moltzap/protocol";
import type * as Tracer from "effect/Tracer";
import type { AuthenticatedContext } from "../rpc/context.js";

/**
 * Tagged error channel for `sendRpcToClient`. Every public failure mode is
 * a discriminated tag — callers that ignore the channel's totality cannot
 * compile.
 */
export class AppDisconnected extends Data.TaggedError("AppDisconnected")<{
  readonly connectionId: string;
  readonly method: string;
  readonly requestId: string;
}> {}

export class S2cRpcResponseError extends Data.TaggedError(
  "S2cRpcResponseError",
)<{
  readonly connectionId: string;
  readonly method: string;
  readonly requestId: string;
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

export class S2cRpcDecodeError extends Data.TaggedError("S2cRpcDecodeError")<{
  readonly connectionId: string;
  readonly method: string;
  readonly requestId: string;
  readonly reason: string;
}> {}

export class S2cRpcSocketError extends Data.TaggedError("S2cRpcSocketError")<{
  readonly connectionId: string;
  readonly method: string;
  readonly requestId: string;
  readonly cause: Socket.SocketError;
}> {}

export type S2cRpcError =
  | AppDisconnected
  | S2cRpcResponseError
  | S2cRpcDecodeError
  | S2cRpcSocketError;

const TRACEPARENT_VERSION = "00";
const TRACEPARENT_SAMPLED_FLAGS = "01";
const TRACEPARENT_UNSAMPLED_FLAGS = "00";

/**
 * Per-connection s2c pending map. Each entry correlates an outbound s2c
 * request with the `Deferred` that `sendRpcToClient` is awaiting.
 *
 * Entries are inserted by `sendRpcToClient` and drained by either:
 *   - the inbound s2c response router (`completeS2cResponse`), on success
 *     or typed error response, or
 *   - the connection's `Scope` finalizer (`drainPendingWithAppDisconnected`,
 *     wired by `acquireS2cConnectionState`), which fails every entry with
 *     `AppDisconnected` on disconnect.
 *
 * Routing is `(side, type)`-disjoint: c2s requests/responses go through
 * separate paths and never key into this map.
 */
export type S2cPendingMap = HashMap.HashMap<string, S2cPendingEntry<unknown>>;

interface S2cPendingEntry<R> {
  readonly method: string;
  readonly deferred: Deferred.Deferred<R, S2cRpcError>;
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
   * `sendRpcToClient` inserts on send; the inbound s2c response router
   * (`completeS2cResponse`) deletes + resolves on reply; the connection
   * scope's finalizer (`drainPendingWithAppDisconnected`, wired by
   * `acquireS2cConnectionState`) fails every entry with `AppDisconnected`
   * on disconnect.
   */
  readonly s2cPending: Ref.Ref<S2cPendingMap>;
  /**
   * Monotonic counter for minting outbound s2c request ids
   * (`srv-<connId>-<seq>`). Direction-namespaced: c2s and s2c id pools may
   * collide on the wire without confusing routing because the pending maps
   * are keyed on `(side, type)`.
   */
  readonly s2cRequestCounter: Ref.Ref<number>;
}

/**
 * Drain a pending-map Ref by failing every Deferred with
 * `AppDisconnected(connectionId, method, requestId)`. Used by the
 * connection scope finalizer in `acquireS2cConnectionState` and by any
 * direct teardown path. Idempotent — `getAndSet(..., empty())` means a
 * second call observes an empty map and is a no-op.
 */
function drainPendingWithAppDisconnected(
  connectionId: string,
  pendingRef: Ref.Ref<S2cPendingMap>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const pending = yield* Ref.getAndSet(
      pendingRef,
      HashMap.empty<string, S2cPendingEntry<unknown>>(),
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
 * Mint the next request id for an outbound s2c RPC. Format
 * `srv-<connId>-<seq>` is direction-namespaced from c2s ids the client mints
 * (`rpc-N`, `tc-...`, etc.) so the two pending maps may overlap on raw id
 * without ambiguity.
 */
function nextS2cRequestId(
  connection: MoltZapConnection,
): Effect.Effect<string> {
  return Ref.modify(connection.s2cRequestCounter, (n) => {
    const next = n + 1;
    return [`srv-${connection.id}-${next}`, next];
  });
}

/**
 * Send an awaitable RPC from server → client over `connection`'s WebSocket.
 *
 * Mechanics (composed entirely from Effect primitives — no bespoke promise
 * pool, no callback registry, no setTimeout retry loop):
 *
 *   1. Mint a fresh request id from the connection's counter.
 *   2. Allocate `Deferred<unknown, S2cRpcError>`.
 *   3. `Effect.acquireUseRelease` around the pending-map pair:
 *      - acquire: register the `{method, deferred}` entry in
 *        `connection.s2cPending` keyed by the request id (atomic
 *        `Ref.update`).
 *      - use: encode the `RequestFrame` with `direction: "s2c"`, write
 *        it via `connection.write`, then `Deferred.await`. Socket
 *        failures fail the Deferred with `S2cRpcSocketError` so the
 *        caller's await observes the failure rather than hanging.
 *      - release: remove the entry from `s2cPending` (atomic
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
 *   - Normal completion via `completeS2cResponse`: removes the entry in
 *     its own atomic `Ref.modify`; release re-removes (no-op).
 *
 * All three paths converge through atomic `Ref` ops on a single map, so
 * no torn state. A late inbound response frame for a request whose
 * caller was interrupted finds `Option.none()` in `completeS2cResponse`
 * and is silently dropped (no panic, no Deferred re-resolve).
 *
 * Caller controls timeout via `Effect.timeout` at the call site — there
 * is NO schema-level cap. Result decoding from `unknown` to a typed
 * verdict is the caller's responsibility (Phase 1.1 / B.2 narrows this
 * signature generically against `S2cRpcMap` and folds decoding inside
 * the function).
 */
export function sendRpcToClient(
  connection: MoltZapConnection,
  method: string,
  params: unknown,
): Effect.Effect<unknown, S2cRpcError, never> {
  return Effect.gen(function* () {
    const requestId = yield* nextS2cRequestId(connection);
    const deferred = yield* Deferred.make<unknown, S2cRpcError>();
    const traceparent = yield* traceparentFromCurrentSpan;
    const frame: RequestFrame = {
      jsonrpc: "2.0",
      type: "request",
      direction: "s2c",
      id: requestId,
      method,
      params,
      ...(traceparent !== undefined ? { traceparent } : {}),
    };
    const raw = JSON.stringify(frame);

    return yield* Effect.acquireUseRelease(
      // acquire: register the pending entry. Atomic `Ref.update` —
      // `completeS2cResponse` and the connection-Scope finalizer key
      // off the same Ref, so all three writers serialize.
      Ref.update(connection.s2cPending, (m) =>
        HashMap.set(m, requestId, {
          method,
          deferred,
        } satisfies S2cPendingEntry<unknown>),
      ),
      // use: write the frame, then await the Deferred. Socket failures
      // settle the Deferred so a late inbound frame's `Deferred.succeed`
      // is a no-op via `Effect.ignore` on an already-failed Deferred.
      //
      // Race note (intentional, benign): if the disconnect-finalizer
      // fires between the acquire above and the write below, the
      // finalizer drains the entry first and fails the Deferred with
      // `AppDisconnected`. The write may then fail (socket already
      // closed) and we attempt `Deferred.fail` with `S2cRpcSocketError`
      // — `Effect.ignore` swallows the no-op on an already-settled
      // Deferred. Caller observes whichever completion landed first;
      // both error tags are correct readings of the failure.
      () =>
        connection.write(raw).pipe(
          Effect.matchEffect({
            onFailure: (socketError) =>
              Effect.gen(function* () {
                const err = new S2cRpcSocketError({
                  connectionId: connection.id,
                  method,
                  requestId,
                  cause: socketError,
                });
                yield* Deferred.fail(deferred, err).pipe(Effect.ignore);
                return yield* Effect.fail<S2cRpcError>(err);
              }),
            onSuccess: () => Deferred.await(deferred),
          }),
        ),
      // release: remove the entry. Idempotent — `HashMap.remove` on an
      // already-removed key is a no-op, so this is safe whether
      // `completeS2cResponse` already removed it (success/error path)
      // or the connection-Scope finalizer drained it (disconnect path).
      () =>
        Ref.update(connection.s2cPending, (m) => HashMap.remove(m, requestId)),
    );
  });
}

const traceparentFromCurrentSpan: Effect.Effect<string | undefined> =
  Effect.currentSpan.pipe(
    Effect.match({
      onFailure: () => undefined,
      onSuccess: formatTraceparentFromSpan,
    }),
  );

function formatTraceparentFromSpan(span: Tracer.Span): string {
  return [
    TRACEPARENT_VERSION,
    span.traceId,
    span.spanId,
    span.sampled ? TRACEPARENT_SAMPLED_FLAGS : TRACEPARENT_UNSAMPLED_FLAGS,
  ].join("-");
}

/**
 * Resolve the s2c pending entry that matches `frame.id`, if any. Called by
 * the inbound s2c response router on the server's read fiber.
 *
 * Three completion outcomes (totally exhaustive — every well-formed
 * response that arrives lands in exactly one branch):
 *
 *   - `frame.error` present → `Deferred.fail` with `S2cRpcResponseError`.
 *   - `frame.error` absent  → `Deferred.succeed` with `frame.result`.
 *   - id not in map         → returns `Option.none()`; caller decides
 *                              whether to log (likely a stale reply after
 *                              disconnect-finalize already fired).
 *
 * Returns `Option.some(method)` when a pending entry was completed, so the
 * caller can record telemetry or attribute the response to its method.
 */
export function completeS2cResponse(
  connection: MoltZapConnection,
  frame: ResponseFrame,
): Effect.Effect<Option.Option<string>> {
  return Effect.gen(function* () {
    const removed = yield* Ref.modify(connection.s2cPending, (m) => {
      const entry = HashMap.get(m, frame.id);
      if (Option.isNone(entry)) return [Option.none(), m];
      return [Option.some(entry.value), HashMap.remove(m, frame.id)];
    });
    if (Option.isNone(removed)) return Option.none();
    const entry = removed.value;
    if (frame.error !== undefined) {
      yield* Deferred.fail(
        entry.deferred,
        new S2cRpcResponseError({
          connectionId: connection.id,
          method: entry.method,
          requestId: frame.id,
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
 * Acquire the per-connection s2c machinery and bind a Scope finalizer that
 * fails every still-pending Deferred with `AppDisconnected` when the scope
 * closes. Caller composes this inside the connection's `Effect.scoped`
 * boundary.
 *
 * Returns the Refs the connection record needs. The finalizer registration
 * is a side-effect on the surrounding scope; nothing the caller has to
 * track directly.
 */
export function acquireS2cConnectionState(connectionId: string): Effect.Effect<
  {
    readonly s2cPending: Ref.Ref<S2cPendingMap>;
    readonly s2cRequestCounter: Ref.Ref<number>;
  },
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const s2cPending = yield* Ref.make<S2cPendingMap>(HashMap.empty());
    const s2cRequestCounter = yield* Ref.make(0);
    yield* Effect.addFinalizer(() =>
      drainPendingWithAppDisconnected(connectionId, s2cPending),
    );
    return { s2cPending, s2cRequestCounter };
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
