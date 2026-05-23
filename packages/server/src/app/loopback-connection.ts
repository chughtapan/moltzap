import { Effect } from "effect";
import type * as Socket from "@effect/platform/Socket";
import type {
  AnyTaskCallbackRpcDefinition,
  ParamsOf,
  RpcCallError,
  ResultOf,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { MoltZapConnection } from "../transport/connection.js";

/**
 * In-process handler for one task-callback RPC. The handler returns
 * the wire-shape result for the matching definition; no encode/decode
 * loop since both sides live in-process.
 */
type LoopbackHandler<D extends AnyTaskCallbackRpcDefinition> = (
  params: ParamsOf<D>,
) => Effect.Effect<ResultOf<D>, RpcCallError>;

/**
 * Mapped over the closed `AnyTaskCallbackRpcDefinition` union, keyed
 * by each definition's wire name. Mandates one handler per
 * task-callback RPC at construction time — adding a new entry to
 * `taskCallbackMethods` becomes a compile error at every loopback
 * construction site (which is the right blast radius for "I added a
 * new server→app RPC; who needs to handle it?").
 */
export type LoopbackHandlers = {
  readonly [D in AnyTaskCallbackRpcDefinition as D["name"]]: LoopbackHandler<D>;
};

/**
 * Build a `MoltZapConnection` whose outbound `call` dispatches to
 * in-process handlers instead of going over a WebSocket. The
 * connection satisfies the same interface as a real WS connection so
 * `AppHost`, `AppRegistry`, and `sendRpcToClient` see ONE shape — the
 * difference between "in-process moderator" and "wire moderator" is
 * which factory built the connection, not how it's consumed.
 *
 * Loopback-specific behavior:
 *   - `originator.call(D, params)` indexes `handlers` by `D.name`. The
 *     mapped type guarantees every member of
 *     `AnyTaskCallbackRpcDefinition` has a handler — no runtime
 *     "method not found" branch exists.
 *   - `originator.notify` / `failAllPending` are no-ops (the default
 *     app doesn't subscribe to notifications and has no pending
 *     Deferreds to drain).
 *   - `originator.handle` / `originator.resolve` defect — a loopback
 *     never receives inbound frames; if anyone calls these, it's a
 *     wiring bug that should crash the server immediately.
 *   - `write` / `shutdown` are similarly defects / inert.
 */
export function makeLoopbackConnection(args: {
  readonly id: ConnectionId;
  readonly handlers: LoopbackHandlers;
}): MoltZapConnection {
  const call = <D extends AnyTaskCallbackRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
  ): Effect.Effect<ResultOf<D>, RpcCallError> => {
    const handler = args.handlers[
      definition.name as D["name"]
    ] as LoopbackHandler<D>;
    return handler(params);
  };

  const wiringBug = (op: string) =>
    Effect.die(
      new Error(
        `loopback connection ${args.id}: ${op} is not implemented (no inbound dispatch)`,
      ),
    );

  const writeUnreachable = (
    _raw: string,
  ): Effect.Effect<void, Socket.SocketError> =>
    Effect.die(
      new Error(
        `loopback connection ${args.id}: write is not implemented (use originator.call)`,
      ),
    );

  return {
    id: args.id,
    write: writeUnreachable,
    shutdown: Effect.void,
    auth: null,
    lastPong: Date.now(),
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
    originator: {
      id: args.id,
      call,
      notify: () => Effect.void,
      failAllPending: () => Effect.void,
      handle: () => wiringBug("originator.handle"),
      resolve: () => wiringBug("originator.resolve"),
    } as MoltZapConnection["originator"],
  };
}
