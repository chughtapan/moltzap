/**
 * @file Typed server-to-client notification fan-out over live agent
 * connections.
 * The endpoint resolver supplies every live connection id for an agent, and
 * the connection manager supplies the reverse RPC client and conversation
 * subscription state for each connection.
 */
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import type { NotificationParamsOf } from "@moltzap/protocol/rpc";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import { Context, Effect, HashSet, Layer, Option } from "effect";
import {
  type AgentConnection,
  type ConnectionManager,
  ConnectionManagerTag,
} from "#socket";
import {
  type AgentEndpointResolver,
  AgentEndpointResolverTag,
} from "./agent-endpoint-resolver.js";

interface BroadcastOptions {
  readonly forConversation?: ConversationId;
  readonly excludeConnectionId?: ConnectionId;
}

/**
 * Typed notification fan-out service. Use the constructor directly in code;
 * route through `NetworkSendServiceTag` in DI-aware code.
 */
export class NetworkSendService {
  private readonly resolver: AgentEndpointResolver;
  private readonly connections: ConnectionManager;

  constructor(resolver: AgentEndpointResolver, connections: ConnectionManager) {
    this.resolver = resolver;
    this.connections = connections;
  }

  /**
   * Shared per-agent / per-connection fan-out driver. For every agent in
   * `agentIds`, resolves its live connections, runs the `connectionCanReceive`
   * gate, and invokes `fire` on each gate-passing connection. An agent lands in
   * `delivered` when at least one of its connections passed the gate.
   * @param agentIds Value supplied to the operation.
   * @param options Options that control the operation.
   * @param fire Value supplied to the operation.
   * @returns The delivered result.
   */
  private fanOut(
    agentIds: readonly AgentId[],
    options: BroadcastOptions,
    fire: (
      conn: AgentConnection,
      cid: ConnectionId,
      target: AgentId,
    ) => Effect.Effect<void>,
  ): Effect.Effect<{ readonly delivered: readonly AgentId[] }> {
    return Effect.gen(
      function* (this: NetworkSendService) {
        const delivered: AgentId[] = [];
        for (const target of agentIds) {
          const connIds = yield* this.resolver.resolveAll(target);
          let reached = false;
          for (const cid of HashSet.values(connIds)) {
            const connOpt = yield* this.connectionCanReceive(cid, options);
            if (Option.isNone(connOpt)) {
              continue;
            }
            yield* fire(connOpt.value, cid, target);
            reached = true;
          }
          if (reached) {
            delivered.push(target);
          }
        }
        return { delivered };
      }.bind(this),
    );
  }

  /**
   * Gate one resolved connection for conversation fan-out. Returns the
   * gate-passing {@link AgentConnection} (so the caller threads it into
   * the notification sender without a second `peek`), or `None` when the
   * connection is excluded, gone, not an agent arm, or not a member of the
   * target conversation.
   * @param cid Value supplied to the operation.
   * @param options Options that control the operation.
   * @returns The conn opt result.
   */
  private connectionCanReceive(
    cid: ConnectionId,
    options: BroadcastOptions,
  ): Effect.Effect<Option.Option<AgentConnection>> {
    return Effect.gen(
      function* (this: NetworkSendService) {
        if (
          options.excludeConnectionId !== undefined &&
          cid === options.excludeConnectionId
        ) {
          return Option.none();
        }
        const connOpt = yield* this.connections.peek(cid);
        if (Option.isNone(connOpt)) {
          return Option.none();
        }
        const conn = connOpt.value;
        // Only authenticated agent arms participate in conversation fan-out;
        // unauthenticated arms have no conversation subscriptions.
        if (conn._tag !== "AgentConnection") {
          return Option.none();
        }
        const conversationId = options.forConversation;
        if (conversationId !== undefined) {
          const subscribed =
            yield* this.connections.isAgentSubscribedToConversation(
              conn.auth.agentId,
              conversationId,
            );
          if (!subscribed) {
            return Option.none();
          }
        }
        return Option.some(conn);
      }.bind(this),
    );
  }

  /**
   * Fan a server→client notification out to every live connection of each agent
   * in `agentIds`. The notification rides each target connection's reverse
   * `RpcClient` (`originator.notify`), fired fork-and-forget — the `void` result
   * settles on the client's ack, the fan-out does not block on the round-trip.
   * Applies the shared per-connection gate: conversation membership plus
   * `excludeConnectionId`.
   * @param agentIds Value supplied to the operation.
   * @param definition Protocol definition to process.
   * @param params Request payload to process.
   * @param options Options that control the operation.
   * @returns The broadcast notification result.
   */
  broadcastNotification<D extends AnyNotificationDefinition>(
    agentIds: readonly AgentId[],
    definition: D,
    params: NotificationParamsOf<D>,
    options: BroadcastOptions = {},
  ): Effect.Effect<{ readonly delivered: readonly AgentId[] }> {
    return this.fanOut(agentIds, options, (conn, cid) =>
      Effect.sync(() => {
        this.forkNotificationFire(conn, cid, definition, params);
      }),
    );
  }

  private forkNotificationFire<D extends AnyNotificationDefinition>(
    conn: AgentConnection,
    cid: ConnectionId,
    definition: D,
    params: NotificationParamsOf<D>,
  ): void {
    Effect.runFork(
      conn.originator.notify(definition, params).pipe(
        Effect.catchAll((cause) =>
          Effect.logWarning("broadcast: notification fire failed").pipe(
            Effect.annotateLogs({
              event: "broadcast.notify_failed",
              connId: cid,
              method: definition.name,
              cause: String(cause),
            }),
          ),
        ),
      ),
    );
  }
}

/** Implements network send service tag. */
export class NetworkSendServiceTag extends Context.Tag(
  "moltzap/NetworkSendService",
)<NetworkSendServiceTag, NetworkSendService>() {}

/** Provides the network send service live runtime value. */
export const networkSendServiceLive = Layer.effect(
  NetworkSendServiceTag,
  Effect.gen(function* () {
    const resolver = yield* AgentEndpointResolverTag;
    const connections = yield* ConnectionManagerTag;
    return new NetworkSendService(resolver, connections);
  }).pipe(Effect.withSpan("NetworkSendServiceLive")),
);
