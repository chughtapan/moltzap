/**
 * Task-manager public surface — slice C additions to `@moltzap/protocol/task`.
 *
 * Re-exported from `./index.ts` (the entry point slice A declares). An intra-
 * `/task/` import; the slice A ESLint `no-restricted-imports` rule targets
 * `@moltzap/protocol/network` ↔ `@moltzap/protocol/task` cross-imports only
 * and does not restrict intra-`/task/*` references.
 */

import { Schema } from "effect";
import type { Part } from "./index.js";

/* ── Branded IDs ─────────────────────────────────────────────────────────── */

export type TaskManagerAddress = string & { readonly __brand: "TaskManagerAddress" };
export type TaskId = string & { readonly __brand: "TaskId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type AppId = string & { readonly __brand: "AppId" };
export type MessageId = string & { readonly __brand: "MessageId" };

export const TaskManagerAddressSchema: Schema.Schema<TaskManagerAddress, string> = Schema.declare(
  (u: unknown): u is TaskManagerAddress =>
    typeof u === "string" &&
    /^tm:(default-dm|default-group|app):[a-z0-9-]+:[A-Za-z0-9_-]+$/.test(u),
  { identifier: "TaskManagerAddress" },
);

/* ── Payload the sender publishes to a TM address ────────────────────────── */

export interface TaskMessagePayload {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
  readonly parts: readonly Part[];
  readonly replyToId?: MessageId;
}

export const TaskMessagePayloadSchema: Schema.Schema<TaskMessagePayload, unknown> = Schema.declare(
  (_u: unknown): _u is TaskMessagePayload => {
    throw new Error("not implemented");
  },
  { identifier: "TaskMessagePayload" },
);

/* ── Exhaustive action set the TM may return ─────────────────────────────── */

// Forward targets are AgentIds, keeping the TM at the identity abstraction.
// The AgentId → EndpointAddress resolver lives in the NETWORK LAYER (co-
// located with ConnectionManager). The task-manager runtime — not the TM
// itself — resolves each AgentId to an EndpointAddress via that service and
// then calls NetworkDeliveryService.send per recipient. This keeps the TM
// decoupled from the wire addressing scheme and from offline/routing
// concerns, both of which are network-layer responsibilities.
export type TaskManagerAction =
  | { readonly _tag: "Forward"; readonly recipients: readonly AgentId[] }
  | { readonly _tag: "Block"; readonly reason: string }
  | { readonly _tag: "Modify"; readonly payload: TaskMessagePayload }
  | { readonly _tag: "Close"; readonly reason: string }
  | {
      readonly _tag: "AttachConversation";
      readonly conversationId: ConversationId;
      readonly participantIds: readonly AgentId[];
    };

// Typed attempt vocabulary for task-layer mutations that must be validated
// against the TM policy BEFORE they hit the CRUD surface. Distinct from
// TaskManagerAction (which is a TM→task-layer RETURN type); this is a
// task-layer→TM CALL-GATE type. DmImmutableError on addParticipant lives
// here, keeping DM policy out of the task-layer CRUD entirely.
export type MutationAttempt =
  | { readonly _tag: "AddParticipantAttempt"; readonly taskId: TaskId; readonly agentId: AgentId }
  | { readonly _tag: "RemoveParticipantAttempt"; readonly taskId: TaskId; readonly agentId: AgentId }
  | { readonly _tag: "CloseTaskAttempt"; readonly taskId: TaskId };

export const TaskManagerActionSchema: Schema.Schema<TaskManagerAction, unknown> = Schema.declare(
  (_u: unknown): _u is TaskManagerAction => {
    throw new Error("not implemented");
  },
  { identifier: "TaskManagerAction" },
);

/* ── Endpoint-registration record, stored at createTask time ─────────────── */

/**
 * `kind` discriminates three defaults + app-owned (spec #137 round-2 goal 2):
 *   - `default-dm`    — platform-default DM TM: uniqueness at creation
 *                       (SELECT-before-INSERT) + immutability at mutation
 *                       (rejects participant actions with `DmImmutableError`).
 *   - `default-group` — platform-default group passthrough TM: no rules,
 *                       stores the message and fans out to participants.
 *   - `app`           — app-registered TM via `registerTaskManager`.
 */
export interface TaskManagerEndpointRegistration {
  readonly taskId: TaskId;
  readonly address: TaskManagerAddress;
  readonly kind: "default-dm" | "default-group" | "app";
  readonly appId: AppId | null;
}
