/**
 * @file Type-canary surface for the `task/*` conversation family.
 *
 * Spans the `app` + `task` + `identity` layers (`TaskCreate` is the app-callable
 * head), so it lives in `app/` and reaches DOWN to task/identity — never up. It
 * imports the concrete sibling modules, not the root barrel.
 *
 * Each compile-time equality assertion locks one invariant — a future edit that
 * narrows a field, renames a key, or drops an export turns it into a
 * `tsc --build` failure.
 */
import type { Schema } from "effect";
import type { JsonRpcMethod } from "../transport/wire.js";
import type { AgentId } from "../identity/agents.js";
import {
  AppId,
  TaskId,
  DEFAULT_APP_ID,
  TaskRequest,
  TaskLeave,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
} from "../task/tasks.js";
import type {
  TaskConversationListItem,
  TaskConversationParticipantsRemovedNotification,
} from "../task/tasks.js";
import type { Conversation } from "../task/conversations.js";
import { ConversationId } from "../task/conversations.js";
import { TaskCreate } from "./app-callbacks.js";

// ── Compile-time equality helper ─────────────────────────────────────
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

// ── Canary 1: wire names are the singular `task/*` namespace ─────────
//
// Locks the singular `task/` namespace (vs a plural `tasks/conversation/...`).
// All RPC + notification `name` fields are branded `JsonRpcMethod<Name>`
// (nominal brand from `transport/wire.ts`); the canary compares against the same
// branded shape.
type _N1 = Expect<
  Equal<typeof TaskRequest.name, JsonRpcMethod<"task/request">>
>;
type _N2 = Expect<Equal<typeof TaskLeave.name, JsonRpcMethod<"task/leave">>>;
type _N3 = Expect<
  Equal<
    typeof TaskConversationCreate.name,
    JsonRpcMethod<"task/conversation/create">
  >
>;
type _N4 = Expect<
  Equal<
    typeof TaskConversationList.name,
    JsonRpcMethod<"task/conversation/list">
  >
>;
type _N5 = Expect<
  Equal<
    typeof TaskConversationArchive.name,
    JsonRpcMethod<"task/conversation/archive">
  >
>;
type _N6 = Expect<
  Equal<
    typeof TaskConversationUnarchive.name,
    JsonRpcMethod<"task/conversation/unarchive">
  >
>;
type _N7 = Expect<
  Equal<
    typeof TaskConversationAddParticipant.name,
    JsonRpcMethod<"task/conversation/participants/add">
  >
>;
type _N8 = Expect<
  Equal<
    typeof TaskConversationRemoveParticipant.name,
    JsonRpcMethod<"task/conversation/participants/remove">
  >
>;
type _N9 = Expect<
  Equal<
    typeof TaskConversationCreatedNotificationDefinition.name,
    JsonRpcMethod<"task/conversation/created">
  >
>;
type _N10 = Expect<
  Equal<
    typeof TaskConversationArchivedNotificationDefinition.name,
    JsonRpcMethod<"task/conversation/archived">
  >
>;
type _N11 = Expect<
  Equal<
    typeof TaskConversationUnarchivedNotificationDefinition.name,
    JsonRpcMethod<"task/conversation/unarchived">
  >
>;
type _N12 = Expect<
  Equal<
    typeof TaskConversationParticipantsAddedNotificationDefinition.name,
    JsonRpcMethod<"task/conversation/participants/added">
  >
>;
type _N13 = Expect<
  Equal<
    typeof TaskConversationParticipantsRemovedNotificationDefinition.name,
    JsonRpcMethod<"task/conversation/participants/removed">
  >
>;

export type _WireNameCanary =
  | _N1
  | _N2
  | _N3
  | _N4
  | _N5
  | _N6
  | _N7
  | _N8
  | _N9
  | _N10
  | _N11
  | _N12
  | _N13;

// ── Canary 2: TaskRequest params shape (appId-only, no tmType) ────────
//
// Locks: `appId` REQUIRED + branded (`AppId` not `string`); `initialConversation`
// optional; the param set is exactly these three keys. `Schema.Array` yields
// `readonly T[]`.
type TaskRequestParams = Schema.Schema.Type<typeof TaskRequest.paramsSchema>;
type _C1 = Expect<Equal<TaskRequestParams["appId"], AppId>>;
type _C2 = Expect<
  Equal<TaskRequestParams["invitedAgentIds"], readonly AgentId[]>
>;
type _C3 = Expect<
  Equal<
    keyof TaskRequestParams,
    "appId" | "invitedAgentIds" | "initialConversation"
  >
>;

type TaskRequestResult = Schema.Schema.Type<typeof TaskRequest.resultSchema>;
type _C4 = Expect<Equal<keyof TaskRequestResult, "task" | "conversation">>;
// `conversation: Conversation | null` (NOT optional `conversation?`).
type _C5 = Expect<
  Equal<TaskRequestResult["conversation"], Conversation | null>
>;

export type _TaskRequestShapeCanary = _C1 | _C2 | _C3 | _C4 | _C5;

// ── Canary 3: DEFAULT_APP_ID is branded `AppId` ──────────────────────
//
// The constant is branded `AppId`, so call sites can't pass arbitrary strings.
// Its runtime UUID value is asserted by a conformance test under
// `testing/conformance/task/`.
export type _DefaultAppIdCanary = Expect<Equal<typeof DEFAULT_APP_ID, AppId>>;

// ── Canary 4: TaskConversationListItem schema shape ──────────────────
//
// Locks the per-row item structure: `{ taskId, conversation, participants:
// AgentId[] }`. A future edit that adds `unreadCount` or a top-level
// `archivedAt` (which would duplicate `conversation.archivedAt`) fails here.
type _L1 = Expect<
  Equal<
    keyof TaskConversationListItem,
    "taskId" | "conversation" | "participants"
  >
>;
type _L2 = Expect<Equal<TaskConversationListItem["taskId"], TaskId>>;
type _L3 = Expect<
  Equal<TaskConversationListItem["participants"], readonly AgentId[]>
>;
// `archivedAt?: DateTimeString` on the `Conversation` row lets clients filter
// archived rows out of `TaskConversationList` responses without a separate field
// on `TaskConversationListItem`.
type _L4 = Expect<Equal<Conversation["archivedAt"], string | undefined>>;

export type _ListItemCanary = _L1 | _L2 | _L3 | _L4;

// ── Canary 5: ParticipantsRemoved reason enum ────────────────────────
//
// Locks the `reason` discriminator (`"app_remove" | "task_leave"`), which drives
// the exhaustive-switch in the broadcast helper; a third reason added without
// code coverage fails here.
type _R1 = Expect<
  Equal<
    TaskConversationParticipantsRemovedNotification["reason"],
    "app_remove" | "task_leave"
  >
>;
type _R2 = Expect<
  Equal<
    TaskConversationParticipantsRemovedNotification["removedAgentId"],
    AgentId
  >
>;
type _R3 = Expect<
  Equal<
    TaskConversationParticipantsRemovedNotification["conversationId"],
    ConversationId
  >
>;

export type _RemovedReasonCanary = _R1 | _R2 | _R3;

// ── Canary 6: task/create app-callback wire name ─────────────────────
//
// Locks the app-facing admission callback to the wire name `task/create`
// (distinct from the agent-facing entry RPC `task/request`, pinned by Canary 1
// `_N1`). The server round-trips this exact method name to the app's
// `task_create` hook; a rename of the `TaskCreate` constant that drifts the wire
// name would silently break admission without this pin.
export type _TaskCreateWireNameCanary = Expect<
  Equal<typeof TaskCreate.name, JsonRpcMethod<"task/create">>
>;
