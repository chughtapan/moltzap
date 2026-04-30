import { Data, Effect } from "effect";
import type * as Socket from "@effect/platform/Socket";
import type { AuthenticatedContext } from "../rpc/context.js";

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
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1.0 STUB — server-initiated awaitable RPC (B.0 architect)
//
// Implementer (B.1) wires the per-connection pending map and Scope finalizer
// onto `MoltZapConnection` itself (extend the interface with a `s2cPending`
// `Ref<Map<RequestId, Deferred>>` field, owned by the connection's `Scope`).
// On disconnect, scope finalization fails every pending Deferred with
// `AppDisconnected`. Caller controls timeout via `Effect.timeout` at the call
// site — there is NO schema-level timeout cap (the manifest 30s cap is
// removed alongside the webhook fields in B.4).
//
// ROUTING RESPONSIBILITIES (after collapse in frames.ts):
//   - Inbound `request` frame, direction=c2s → existing server RPC router.
//   - Inbound `response` frame, direction=s2c → THIS module's pending map.
//
// FRAME ID GENERATION: implementer mints request ids via a per-connection
// counter prefixed with `srv-` (e.g. `srv-<connId>-<seq>`). Direction
// namespacing in frames.ts means c2s and s2c may use overlapping ids without
// confusing routing.
//
// ERROR CHANNEL (typed, never throw):
// ─────────────────────────────────────────────────────────────────────────────

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
 * Send an awaitable RPC from server → client over `connection`'s WS.
 *
 * Implementer (B.1):
 *   1. Mint a fresh request id from the connection's counter.
 *   2. Allocate `Deferred<Result, S2cRpcError>` and register it in the
 *      connection's `s2cPending` map.
 *   3. Encode an `S2cRequestFrame` (frames.ts) and `connection.write` it.
 *   4. Return `Deferred.await` as the Effect. The inbound-frame handler
 *      resolves/rejects the Deferred when the matching response arrives.
 *   5. Scope finalizer: when the connection scope closes, walk the pending
 *      map and `Deferred.fail(_, AppDisconnected)` for every entry.
 *
 * Caller (AppHost) wraps the returned Effect in `Effect.timeout(manifestMs)`
 * for hook-level timeouts. Result decoding from `unknown` to the typed
 * verdict is the caller's responsibility (use the corresponding result schema
 * from `@moltzap/protocol`).
 *
 * NOT IMPLEMENTED — architect stub. Body is `throw` per safer:architect rule.
 */
export function sendRpcToClient(
  connection: MoltZapConnection,
  method: string,
  params: unknown,
): Effect.Effect<unknown, S2cRpcError, never> {
  void connection;
  void method;
  void params;
  throw new Error("not implemented");
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
