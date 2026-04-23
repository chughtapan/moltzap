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
import type { Agent, Conversation, Message } from "../../types.js";
import type { EventFrame } from "../../schema/frames.js";

/** Monotonic logical clock — the model does not read wall time. */
export type LogicalTick = number & { readonly __brand: "LogicalTick" };

/** Every kind of entity the model tracks. */
export interface ReferenceState {
  readonly tick: LogicalTick;
  /** Registered agents, keyed by `agentId`. */
  readonly agents: ReadonlyMap<string, Agent>;
  /** Conversations, keyed by `conversationId`. */
  readonly conversations: ReadonlyMap<string, Conversation>;
  /** Messages per conversation, append-only, ordered. */
  readonly messages: ReadonlyMap<string, ReadonlyArray<Message>>;
  /** Per-agent outbox of events the model predicts the server will emit. */
  readonly pendingEvents: ReadonlyMap<string, ReadonlyArray<EventFrame>>;
  /** Authorization table — (agentId, conversationId) → role. */
  readonly authz: ReadonlyMap<
    string,
    ReadonlyMap<string, "owner" | "participant" | "denied">
  >;
  /** Request-ids the model has observed, for uniqueness assertions (B4). */
  readonly seenRequestIds: ReadonlySet<string>;
}

export const initialReferenceState: ReferenceState = (() => {
  throw new Error("not implemented");
})();
