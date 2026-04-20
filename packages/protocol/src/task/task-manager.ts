/**
 * Task-manager public surface — slice C additions to `@moltzap/protocol/task`.
 *
 * Re-exported from `./index.ts` (the entry point slice A declares). An intra-
 * `/task/` import; the slice A ESLint `no-restricted-imports` rule targets
 * `@moltzap/protocol/network` ↔ `@moltzap/protocol/task` cross-imports only
 * and does not restrict intra-`/task/*` references.
 */

import { Schema } from "effect";
// Reach into the network sibling for EndpointAddress. Slice A's
// `@moltzap/protocol/network` is the canonical home. Importing the type-only
// reference preserves the one-way protocol dependency (task may import from
// network; network may NOT import from task — enforced by ESLint rule per
// spec #135).
import type { EndpointAddress } from "../network/index.js";
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

// Forward targets are wire-layer addresses, not agent ids. The task layer's
// listParticipants returns AgentId[]; the TM resolves those to
// EndpointAddress values via the network-layer identity service before
// constructing a Forward action. This matches NetworkDeliveryService.send,
// which only accepts EndpointAddress. The AgentId → EndpointAddress
// resolution is a dedicated task-layer service (see §4 data flow) with its
// own typed error surface; never a hidden best-effort inside this union.
export type TaskManagerAction =
  | { readonly _tag: "Forward"; readonly recipients: readonly EndpointAddress[] }
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
