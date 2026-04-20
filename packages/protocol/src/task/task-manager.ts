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
    typeof u === "string" && /^tm:(default|app):[a-z0-9-]+:[A-Za-z0-9_-]+$/.test(u),
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

export const TaskManagerActionSchema: Schema.Schema<TaskManagerAction, unknown> = Schema.declare(
  (_u: unknown): _u is TaskManagerAction => {
    throw new Error("not implemented");
  },
  { identifier: "TaskManagerAction" },
);

/* ── Endpoint-registration record, stored at createTask time ─────────────── */

export interface TaskManagerEndpointRegistration {
  readonly taskId: TaskId;
  readonly address: TaskManagerAddress;
  readonly kind: "default" | "app";
  readonly appId: AppId | null;
}
