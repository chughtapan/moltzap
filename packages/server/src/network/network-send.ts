/**
 * `network.send(to: EndpointAddress, payload: OpaquePayload)
 *   → Effect&lt;DeliveryAck, DeliveryError, never>`
 *
 * Outbound-routing primitive. Two collaborators: the
 * {@link AgentEndpointResolver} for the durable `agent` lookup and the
 * {@link ConnectionManager} for the writable socket; a Tag at
 * `app/layers.ts` provides this composition.
 *
 * Endpoint kinds dispatched here (the brand at
 * `packages/protocol/src/network/actor-model.ts` encodes the kind in
 * the address prefix; the switch is exhaustive over
 * {@link EndpointAddressKind}):
 *
 * - `tm:agent:&lt;agentId>` — durable per-agent address used by
 *   `tasks.tm_endpoint_address` and for any consumer addressing an
 *   agent by identity. Resolves via the resolver's forward map and
 *   writes to one of the agent's live connections;
 *   {@link RecipientNotResolved} when no socket holds the address.
 * - `tm:app:&lt;id>` — app-TM registrations dispatched through the
 *   in-process {@link AppTmRegistry} (default DM / group TMs and any
 *   future custom in-process TMs register handlers at boot);
 *   {@link RecipientNotResolved} when no handler is registered.
 *
 * Same code path runs whether the resolved connection lives in this
 * process or another (plan §1.3 in-process loopback policy).
 */
import { Brand, Data, Effect, Either, HashSet, Match } from "effect";
import {
  endpointAddressKind,
  type EndpointAddress,
  type EndpointAddressKind,
} from "@moltzap/protocol/network";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/task";
import type * as Socket from "@effect/platform/Socket";
import { ConnectionManager } from "../transport/connection.js";
import { AgentEndpointResolver } from "./agent-endpoint-resolver.js";
import type { AppTmRegistry } from "./app-tm-registry.js";

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
  readonly to: EndpointAddress;
}> {}

/**
 * Recipient address has no live connection. Caller-recoverable —
 * usually drop or queue rather than retry.
 */
export class RecipientNotResolved extends Data.TaggedError(
  "RecipientNotResolved",
)<{
  readonly to: EndpointAddress;
}> {}

/**
 * Socket write failed. The inner {@link Socket.SocketError} cause is
 * preserved so the caller distinguishes a write failure from a
 * resolution failure without re-running the lookup.
 */
export class WriteFailed extends Data.TaggedError("WriteFailed")<{
  readonly to: EndpointAddress;
  readonly cause: Socket.SocketError;
}> {}

export type DeliveryError = RecipientNotResolved | WriteFailed;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface BroadcastOptions {
  readonly forConversation?: ConversationId;
  readonly excludeConnectionId?: string;
  readonly messageId?: MessageId;
}

interface BroadcastWrite {
  readonly cid: string;
  readonly target: AgentId;
  readonly payload: OpaquePayload;
  readonly options: BroadcastOptions;
}

/**
 * The outbound-routing primitive. Use the constructor directly in code;
 * route through `NetworkSendServiceTag` in DI-aware code.
 */
export class NetworkSendService {
  constructor(
    private readonly resolver: AgentEndpointResolver,
    private readonly connections: ConnectionManager,
    private readonly appTmRegistry: AppTmRegistry,
  ) {}

  /**
   * Route `payload` to the connection bound to `to`. Dispatches by
   * address kind.
   */
  send(
    to: EndpointAddress,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    const kind: EndpointAddressKind = endpointAddressKind(to);
    return Match.value(kind).pipe(
      Match.when("agent", () => this.sendToDurableAgent(to, payload)),
      Match.when("app", () => this.sendToAppTm(to, payload)),
      Match.exhaustive,
    );
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
    cid: string,
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

  /**
   * App-TM dispatch (`tm:app:&lt;id>`) — routes through the in-process
   * {@link AppTmRegistry}; no WebSocket round-trip.
   * {@link RecipientNotResolved} when no handler is registered.
   * Handler errors are absorbed inside the handler's `never` channel.
   */
  private sendToAppTm(
    to: EndpointAddress,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    return Effect.gen(this, function* () {
      const handler = yield* this.appTmRegistry.resolve(to);
      if (handler === undefined) {
        return yield* Effect.fail(new RecipientNotResolved({ to }));
      }
      yield* handler(payload);
      return new DeliveryAck({ to });
    });
  }

  /**
   * Durable-agent delivery (`tm:agent:&lt;agentId>`). Picks one live
   * connection of the agent and writes; iterates the resolver set so a
   * stale entry does not poison the send when a sibling connection is
   * still live. {@link RecipientNotResolved} folds "no resolver
   * entry" and "every resolved connection has gone away" — callers
   * can't act on the distinction without poking internal state.
   */
  private sendToDurableAgent(
    to: EndpointAddress,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    return Effect.gen(this, function* () {
      const agentIdValue = parseAgentIdFromDurableAddress(to);
      const conns = yield* this.resolver.resolveAll(agentIdValue);
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
}

const DURABLE_AGENT_PREFIX = "tm:agent:";

function parseAgentIdFromDurableAddress(address: EndpointAddress): AgentId {
  return String(address).slice(DURABLE_AGENT_PREFIX.length) as AgentId;
}
