/**
 * Reference-model state types.
 *
 * Per Invariant I5 and AC4, the reference model is the contract: its
 * reducer-derived next-state and its predicted event trace are compared
 * against the real server's observable behavior (Tier B). Divergence
 * shrinks to the offending `ArbitraryRpcCall`.
 *
 * Shape: a pure data record keyed by agent id + conversation id. No fibers,
 * no network, no clocks — all actions are total functions.
 */
import { Brand } from "effect";
import type { Agent, AgentId } from "../../identity/methods.js";
import type {
  Conversation,
  ConversationId,
  Message,
} from "../../task/methods.js";
import type { NotificationFrame } from "../../transport/wire.js";

/** Monotonic logical clock — the model does not read wall time. */
export type LogicalTick = number & Brand.Brand<"LogicalTick">;
const logicalTick = Brand.nominal<LogicalTick>();

/** Construct a `LogicalTick` from a raw number. Only call in this module. */
export function mkTick(n: number): LogicalTick {
  return logicalTick(n);
}

/** Every kind of entity the model tracks. */
export interface ReferenceState {
  readonly tick: LogicalTick;
  /** Registered agents, keyed by `agentId`. */
  readonly agents: ReadonlyMap<AgentId, Agent>;
  /** Conversations, keyed by `conversationId`. */
  readonly conversations: ReadonlyMap<ConversationId, Conversation>;
  /** Messages per conversation, append-only, ordered. */
  readonly messages: ReadonlyMap<ConversationId, ReadonlyArray<Message>>;
  /** Per-agent outbox of events the model predicts the server will emit. */
  readonly pendingEvents: ReadonlyMap<
    AgentId,
    ReadonlyArray<NotificationFrame>
  >;
  /** Authorization table — (agentId, conversationId) → role. */
  readonly authz: ReadonlyMap<
    AgentId,
    ReadonlyMap<ConversationId, "owner" | "participant" | "denied">
  >;
  /** Request-ids the model has observed, for uniqueness assertions (B4). */
  readonly seenRequestIds: ReadonlySet<string>;
}

export const initialReferenceState: ReferenceState = {
  tick: mkTick(0),
  agents: new Map(),
  conversations: new Map(),
  messages: new Map(),
  pendingEvents: new Map(),
  authz: new Map(),
  seenRequestIds: new Set(),
};
