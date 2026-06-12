/**
 * `network.send` — outbound routing primitive.
 *
 * Two collaborators: the {@link AgentEndpointResolver} for the durable
 * `AgentId → live ConnectionId set` lookup and the
 * {@link ConnectionManager} for the writable socket. A Tag at
 * `core/layers.ts` provides this composition.
 *
 * Outbound routing is strictly per-agent ({@link send}) or
 * per-agent-set ({@link broadcast}). App callbacks write over the app's
 * own `AppEndpoint` originator inside `AppHost`, not through here.
 */
import { Brand, Data, Effect, Either, HashSet, Option } from "effect";
import type { NotificationParamsOf } from "@moltzap/protocol/rpc";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { SocketError } from "@effect/platform/Socket";
import { ConnectionManager } from "#socket";
import type { AgentConnection } from "#socket";
import { AgentEndpointResolver } from "./agent-endpoint-resolver.js";

/**
 * Branded raw-string payload. The send primitive writes the exact
 * bytes to the recipient socket — no parse, no transform, no validate.
 * The nominal brand prevents an unwitting caller from passing an
 * arbitrary `string` where a wire-ready frame is expected.
 */
export type OpaquePayload = string & Brand.Brand<"OpaquePayload">;

// ---------------------------------------------------------------------------
// Result + error channel
// ---------------------------------------------------------------------------

/**
 * Successful single-recipient write. The fan-out variant
 * {@link NetworkSendService.broadcast} returns the delivered agent ids
 * in its success channel and absorbs `DeliveryError` cases.
 */
export class DeliveryAck extends Data.TaggedClass("DeliveryAck")<{
  readonly to: AgentId;
}> {}

/**
 * Recipient agent has no live connection. Caller-recoverable —
 * usually drop or queue rather than retry.
 */
class RecipientNotResolved extends Data.TaggedError("RecipientNotResolved")<{
  readonly to: AgentId;
}> {}

/**
 * Socket write failed. The inner `SocketError` cause is
 * preserved so the caller distinguishes a write failure from a
 * resolution failure without re-running the lookup.
 */
class WriteFailed extends Data.TaggedError("WriteFailed")<{
  readonly to: AgentId;
  readonly cause: SocketError;
}> {}

export type DeliveryError = RecipientNotResolved | WriteFailed;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface BroadcastOptions {
  readonly forConversation?: ConversationId;
  readonly excludeConnectionId?: ConnectionId;
  readonly messageId?: MessageId;
}

interface BroadcastWrite {
  readonly cid: ConnectionId;
  readonly conn: AgentConnection;
  readonly target: AgentId;
  readonly payload: OpaquePayload;
  readonly options: BroadcastOptions;
}

/**
 * Outbound-routing primitive. Use the constructor directly in code;
 * route through `NetworkSendServiceTag` in DI-aware code.
 */
export class NetworkSendService {
  constructor(
    private readonly resolver: AgentEndpointResolver,
    private readonly connections: ConnectionManager,
  ) {}

  /**
   * Route `payload` to one live connection of `agentId`. Iterates the
   * resolver set so a stale entry does not poison the send when a
   * sibling connection is still live. {@link RecipientNotResolved}
   * folds "no resolver entry" and "every resolved connection has gone
   * away" — callers can't act on the distinction without poking
   * internal state.
   */
  send(
    to: AgentId,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    return Effect.gen(this, function* () {
      const conns = yield* this.resolver.resolveAll(to);
      for (const candidate of HashSet.values(conns)) {
        const conn = yield* this.connections.peek(candidate);
        if (Option.isNone(conn)) continue;
        yield* conn.value.socket.write(payload).pipe(
          Effect.either,
          Effect.flatMap(
            Either.match({
              onLeft: (cause) => Effect.fail(new WriteFailed({ to, cause })),
              onRight: () => Effect.void,
            }),
          ),
        );
        return new DeliveryAck({ to });
      }
      return yield* Effect.fail(new RecipientNotResolved({ to }));
    });
  }

  /**
   * Fan out `payload` across every live connection of every agent in
   * `agentIds`. Per-CONNECTION (multi-tab agents receive one frame per
   * live connection); writes are forked so a hung recipient does not
   * extend the caller's RPC latency.
   *
   * Filter options:
   * - `forConversation` — apply the per-connection subscription gate
   *   (`conn.conversationIds.has(...)`); absent, every connection
   *   of every listed agent receives.
   * - `excludeConnectionId` — skip the named connection. The
   *   `messages/send` author uses this to avoid echoing the RPC reply
   *   back as a notification.
   *
   * `delivered` lists agents whose at-least-one connection was
   * scheduled to receive a write — drives trace-capture's
   * offline-recipient accounting.
   */
  broadcast(
    agentIds: readonly AgentId[],
    payload: OpaquePayload,
    opts: BroadcastOptions = {},
  ): Effect.Effect<{ readonly delivered: readonly AgentId[] }, never, never> {
    return Effect.gen(this, function* () {
      const delivered: AgentId[] = [];
      for (const target of agentIds) {
        const reached = yield* this.broadcastToAgent(target, payload, opts);
        if (reached) delivered.push(target);
      }
      return { delivered };
    });
  }

  private broadcastToAgent(
    target: AgentId,
    payload: OpaquePayload,
    options: BroadcastOptions,
  ): Effect.Effect<boolean, never, never> {
    return Effect.gen(this, function* () {
      const connIds = yield* this.resolver.resolveAll(target);
      let agentReached = false;
      for (const cid of HashSet.values(connIds)) {
        const connOpt = yield* this.connectionCanReceive(cid, options);
        if (Option.isNone(connOpt)) continue;
        yield* this.forkBroadcastWrite({
          cid,
          conn: connOpt.value,
          target,
          payload,
          options,
        });
        agentReached = true;
      }
      return agentReached;
    });
  }

  /**
   * Gate one resolved connection for conversation fan-out. Returns the
   * gate-passing {@link AgentConnection} (so the caller threads it into
   * {@link forkBroadcastWrite} without a second `peek`), or `None` when
   * the connection is excluded, gone, not an agent arm, or not a member
   * of the target conversation.
   */
  private connectionCanReceive(
    cid: ConnectionId,
    options: BroadcastOptions,
  ): Effect.Effect<Option.Option<AgentConnection>> {
    return Effect.gen(this, function* () {
      if (
        options.excludeConnectionId !== undefined &&
        cid === options.excludeConnectionId
      ) {
        return Option.none();
      }
      const connOpt = yield* this.connections.peek(cid);
      if (Option.isNone(connOpt)) return Option.none();
      const conn = connOpt.value;
      // Only authenticated agent arms participate in conversation fan-out;
      // unauthenticated and app arms have no `conversationIds` membership.
      if (conn._tag !== "AgentConnection") return Option.none();
      const conversationId = options.forConversation;
      if (
        conversationId !== undefined &&
        !conn.conversationIds.has(conversationId)
      ) {
        return Option.none();
      }
      return Option.some(conn);
    });
  }

  private forkBroadcastWrite(write: BroadcastWrite): Effect.Effect<void> {
    return Effect.sync(() => {
      Effect.runFork(
        write.conn.socket.write(write.payload).pipe(
          Effect.catchAll((cause) =>
            Effect.logWarning("broadcast: socket write failed").pipe(
              Effect.annotateLogs({
                event: "broadcast.write_failed",
                reason: "WriteFailed",
                connId: write.cid,
                agentId: write.target,
                conversationId: write.options.forConversation,
                messageId: write.options.messageId,
                cause: String(cause),
              }),
            ),
          ),
        ),
      );
    });
  }

  /**
   * Fan a server→client notification out to every live connection of each agent
   * in `agentIds`. The notification rides each target connection's reverse
   * `RpcClient` (`originator.call`), fired fork-and-forget — the `void` result
   * settles on the client's ack, the fan-out does not block on the round-trip.
   * Applies the same per-connection gate as {@link broadcast}
   * (`connectionCanReceive`): conversation membership + `excludeConnectionId`.
   */
  broadcastNotification<D extends AnyNotificationDefinition>(
    agentIds: readonly AgentId[],
    definition: D,
    params: NotificationParamsOf<D>,
    options: BroadcastOptions = {},
  ): Effect.Effect<{ readonly delivered: readonly AgentId[] }, never, never> {
    return Effect.gen(this, function* () {
      const delivered: AgentId[] = [];
      for (const target of agentIds) {
        const connIds = yield* this.resolver.resolveAll(target);
        let reached = false;
        for (const cid of HashSet.values(connIds)) {
          const connOpt = yield* this.connectionCanReceive(cid, options);
          if (Option.isNone(connOpt)) continue;
          this.forkNotificationFire(connOpt.value, cid, definition, params);
          reached = true;
        }
        if (reached) delivered.push(target);
      }
      return { delivered };
    });
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
