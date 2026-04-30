import {
  Data,
  Deferred,
  Effect,
  Exit,
  HashMap,
  Option,
  Ref,
  Scope,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import type {
  ResponseFrame,
  RequestFrame,
  FrameDirection,
} from "@moltzap/protocol";
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

/**
 * Per-connection s2c pending map. Each entry correlates an outbound
 * `S2cRequestFrame` with the `Deferred` that `sendRpcToClient` is awaiting.
 *
 * Entries are inserted by `sendRpcToClient` and drained by either:
 *   - the inbound s2c response router (success or typed error response), or
 *   - the connection's `Scope` finalizer (`failPendingS2cRequests`) on
 *     disconnect, which fails every entry with `AppDisconnected`.
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
   * `sendRpcToClient` inserts on send; the inbound `s2c` response router
   * deletes + resolves on reply; the connection scope's finalizer
   * (`failPendingS2cRequests`) fails every entry with `AppDisconnected` on
   * disconnect.
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
 * Allocate the per-connection s2c machinery. Caller wires the resulting
 * Refs onto the `MoltZapConnection` record and registers
 * `failPendingS2cRequests(...)` as a scope finalizer.
 */
export const makeS2cConnectionState: Effect.Effect<{
  readonly s2cPending: Ref.Ref<S2cPendingMap>;
  readonly s2cRequestCounter: Ref.Ref<number>;
}> = Effect.gen(function* () {
  const s2cPending = yield* Ref.make<S2cPendingMap>(HashMap.empty());
  const s2cRequestCounter = yield* Ref.make(0);
  return { s2cPending, s2cRequestCounter };
});

/**
 * Fail every outstanding s2c request with `AppDisconnected`. Wired as a
 * `Scope.addFinalizer` on the per-connection scope so disconnect (clean or
 * abrupt) drains the map deterministically. Idempotent: running twice is
 * a no-op because the second call observes an empty map.
 */
export function failPendingS2cRequests(
  connection: MoltZapConnection,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const pending = yield* Ref.getAndSet(
      connection.s2cPending,
      HashMap.empty<string, S2cPendingEntry<unknown>>(),
    );
    for (const [id, entry] of HashMap.entries(pending)) {
      yield* Deferred.fail(
        entry.deferred,
        new AppDisconnected({
          connectionId: connection.id,
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
 *   2. Allocate `Deferred<unknown, S2cRpcError>` and register it in
 *      `connection.s2cPending` keyed by the request id.
 *   3. Encode the `RequestFrame` with `direction: "s2c"` and write it via
 *      `connection.write`. Socket failures fail the Deferred with
 *      `S2cRpcSocketError` so the caller's await observes the failure
 *      rather than hanging.
 *   4. Return `Deferred.await` mapped through the typed error channel. The
 *      reader fiber resolves the Deferred when the matching s2c response
 *      arrives (`completeS2cResponse` below); the connection's `Scope`
 *      finalizer fails it on disconnect.
 *
 * Caller controls timeout via `Effect.timeout` at the call site — there is
 * NO schema-level cap. Result decoding from `unknown` to a typed verdict is
 * the caller's responsibility (Phase 1.1 / B.2 narrows this signature
 * generically against `S2cRpcMap` and folds decoding inside the function).
 */
export function sendRpcToClient(
  connection: MoltZapConnection,
  method: string,
  params: unknown,
): Effect.Effect<unknown, S2cRpcError, never> {
  return Effect.gen(function* () {
    const requestId = yield* nextS2cRequestId(connection);
    const deferred = yield* Deferred.make<unknown, S2cRpcError>();

    yield* Ref.update(connection.s2cPending, (m) =>
      HashMap.set(m, requestId, {
        method,
        deferred,
      } satisfies S2cPendingEntry<unknown>),
    );

    const frame: RequestFrame = {
      jsonrpc: "2.0",
      type: "request",
      direction: "s2c" satisfies FrameDirection,
      id: requestId,
      method,
      params,
    };
    const raw = JSON.stringify(frame);

    // Write under `Effect.onError`-style cleanup: if write fails, drop the
    // pending entry and fail the Deferred so the caller's `await` observes
    // the typed socket error rather than hanging.
    const writeOutcome = yield* Effect.either(connection.write(raw));
    if (writeOutcome._tag === "Left") {
      yield* Ref.update(connection.s2cPending, (m) =>
        HashMap.remove(m, requestId),
      );
      const err = new S2cRpcSocketError({
        connectionId: connection.id,
        method,
        requestId,
        cause: writeOutcome.left,
      });
      yield* Deferred.fail(deferred, err).pipe(Effect.ignore);
      return yield* Effect.fail<S2cRpcError>(err);
    }

    return yield* Deferred.await(deferred);
  });
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
 *   - id not in map         → log + drop (likely a stale reply after
 *                              disconnect-finalize already fired).
 *
 * Returns `Option.some(method)` when a pending entry was completed, so the
 * caller can record telemetry or decide whether to log an unmatched-id
 * warning.
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
    const state = yield* makeS2cConnectionState;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const pending = yield* Ref.getAndSet(
          state.s2cPending,
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
      }).pipe(Effect.ignore),
    );
    return state;
  });
}

// Re-export `Exit` so the layers module's existing imports keep resolving
// without a separate `from "effect"` import. (Internal convenience; not a
// public surface contract.)
export { Exit };

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
