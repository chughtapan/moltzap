/**
 * `network.send` — outbound routing primitive.
 *
 * Two collaborators: the {@link AgentEndpointResolver} for the durable
 * `AgentId → live ConnectionId set` lookup and the
 * {@link ConnectionManager} for the writable socket. A Tag at
 * `app/layers.ts` provides this composition.
 *
 * Issue #673 cutover: the `EndpointAddress` brand + endpoint-kind
 * dispatch retired. Outbound routing is now strictly per-agent
 * ({@link send}) or per-agent-set ({@link broadcast}). App-TM
 * observability writes via {@link AppHost}'s remote-registration table
 * directly, not through here.
 */
import { Brand, Data, Effect, Either, HashSet } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { ConversationId, MessageId } from "@moltzap/protocol/task";
import type * as Socket from "@effect/platform/Socket";
import { ConnectionManager } from "../transport/connection.js";
import { AgentEndpointResolver } from "./agent-endpoint-resolver.js";

/**
 * Branded raw-string payload. The send primitive writes the exact
 * bytes to the recipient socket — no parse, no transform, no validate.
 * The nominal brand prevents an unwitting caller from passing an
 * arbitrary `string` where a wire-ready frame is expected; construct
 * via {@link opaquePayload}.
 */
export type OpaquePayload = string & Brand.Brand<"OpaquePayload">;
const OpaquePayloadBrand = Brand.nominal<OpaquePayload>();

/** Brand a raw string as an {@link OpaquePayload}. */
export const opaquePayload = (raw: string): OpaquePayload =>
  OpaquePayloadBrand(raw);

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
export class RecipientNotResolved extends Data.TaggedError(
  "RecipientNotResolved",
)<{
  readonly to: AgentId;
}> {}

/**
 * Socket write failed. The inner {@link Socket.SocketError} cause is
 * preserved so the caller distinguishes a write failure from a
 * resolution failure without re-running the lookup.
 */
export class WriteFailed extends Data.TaggedError("WriteFailed")<{
  readonly to: AgentId;
  readonly cause: Socket.SocketError;
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
        const conn = this.connections.get(candidate);
        if (conn === undefined) continue;
        yield* conn.write(payload).pipe(
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
   *   (`conn.conversationIds.has(...)`) and mute gate
   *   (`!conn.mutedConversations.has(...)`); absent, every connection
   *   of every listed agent receives.
   * - `excludeConnectionId` — skip the named connection. The
   *   `messages/send` author uses this to avoid echoing the RPC reply
   *   back as a notification.
   *
   * `delivered` lists agents whose at-least-one connection was
   * scheduled to receive a write — drives the offline-recipient set
   * for `MessageService.send`'s delivery-webhook + trace-capture
   * branches.
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
        if (!this.connectionCanReceive(cid, options)) continue;
        this.forkBroadcastWrite({ cid, target, payload, options });
        agentReached = true;
      }
      return agentReached;
    });
  }

  private connectionCanReceive(
    cid: ConnectionId,
    options: BroadcastOptions,
  ): boolean {
    if (
      options.excludeConnectionId !== undefined &&
      cid === options.excludeConnectionId
    ) {
      return false;
    }
    const conn = this.connections.get(cid);
    if (conn === undefined || conn.auth === null) return false;
    const conversationId = options.forConversation;
    if (conversationId === undefined) return true;
    return (
      conn.conversationIds.has(conversationId) &&
      !conn.mutedConversations.has(conversationId)
    );
  }

  private forkBroadcastWrite(write: BroadcastWrite): void {
    const conn = this.connections.get(write.cid);
    if (conn === undefined) return;
    Effect.runFork(
      conn.write(write.payload).pipe(
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
  }
}
