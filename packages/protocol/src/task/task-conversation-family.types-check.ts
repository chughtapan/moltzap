/**
 * @file Spec D1 (#598) type-canary surface.
 *
 * Positive canaries: assert the new descriptors are reachable from the
 * flat `@moltzap/protocol` barrel under their declared names, and that
 * the schema-inferred payload types match the documented shape. Each
 * compile-time equality assertion locks one invariant — a future edit
 * that narrows a field, renames a key, or drops an export turns it
 * into a `tsc --build` failure.
 *
 * Negative canaries: assert the symbols that Spec D1 explicitly does
 * NOT introduce (`TaskConversationUpdate`, `TaskConversationGet`,
 * `TaskConversationMute`, `TaskConversationLeave`,
 * `TaskConversationUnmute`, `task/conversation/updated` notification)
 * are NOT re-exported. Each `@ts-expect-error` swallows the TS2305
 * "no exported member" error that the missing export produces — if a
 * future edit accidentally exports any of those symbols, the import
 * succeeds and `tsc --noEmit` fails with TS2578 ("Unused
 * '@ts-expect-error' directive").
 */
import type { Schema } from "effect";
import type { JsonRpcMethod } from "../transport/wire.js";
import type {
  AgentId,
  AppId,
  Conversation,
  ConversationId,
  TaskConversationListItem,
  TaskConversationParticipantsRemovedNotification,
  TaskId,
} from "../index.js";
import {
  DEFAULT_APP_ID,
  TaskConversationAddParticipant,
  TaskConversationArchive,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationCreate,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationList,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  TaskConversationRemoveParticipant,
  TaskConversationUnarchive,
  TaskConversationUnarchivedNotificationDefinition,
  TaskRequest,
  TaskLeave,
} from "../index.js";

// ── Compile-time equality helper ─────────────────────────────────────
type Expect<T extends true> = T;
type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;

// ── Canary 1: wire names are the singular `task/*` namespace ─────────
//
// Locks the namespace decision (singular `task/`) chosen by the
// architect to avoid wire-collision with the legacy plural `tasks/`
// family during the D1 dual-emit window. A future rename to
// `tasks/conversation/...` breaks every assertion below.
// All RPC + notification `name` fields are branded
// `JsonRpcMethod<Name>` (nominal brand from `transport/wire.ts`); the
// canary compares against the same branded shape.
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

export type _D1WireNameCanary =
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
// Locks: `appId` REQUIRED + branded (`AppId` not `string`); `tmType`
// ELIMINATED; `initialConversation` optional. A regression that
// re-introduces `tmType` or downgrades `appId` to `string` fails the
// `Expect<Equal<...>>` below.

type TaskRequestParams = Schema.Schema.Type<typeof TaskRequest.paramsSchema>;
type _C1 = Expect<Equal<TaskRequestParams["appId"], AppId>>;
// Post-#723 (Effect Schema): `Schema.Array` yields `readonly T[]`.
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
// Spec body Goal 3 fixes `conversation: Conversation | null` (NOT
// optional `conversation?`); the AC text uses shorthand `conversation?`
// but Goal 3 is canonical. Lock the explicit nullable shape so the
// stub matches the wire signature reviewers consume.
type _C5 = Expect<
  Equal<TaskRequestResult["conversation"], Conversation | null>
>;

export type _D1TaskCreateShapeCanary = _C1 | _C2 | _C3 | _C4 | _C5;

// ── Canary 3: DEFAULT_APP_ID is branded and the spec-fixed UUID ──────
//
// Locks: the constant is branded `AppId` (so call sites can't pass
// arbitrary strings), and its runtime value is the spec-fixed UUID v4.

// Runtime equality (the literal UUID value) is asserted via a
// conformance test in `packages/protocol/src/testing/conformance/task/`
// (see plan §9); here we only encode the brand.
export type _D1DefaultAppIdCanary = Expect<Equal<typeof DEFAULT_APP_ID, AppId>>;

// ── Canary 4: TaskConversationListItem schema shape ──────────────────
//
// Locks the per-row item structure: `{ taskId, conversation,
// participants: AgentId[] }`. Spec body Goal 1 explicitly fixes this
// shape; a future edit that adds `unreadCount` or a top-level
// `archivedAt` (which would duplicate `conversation.archivedAt`) fails
// here.

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
// Spec D1 adds `archivedAt?: DateTimeString` to the `Conversation` row
// so clients can filter archived rows out of
// `TaskConversationList` responses without a separate field on
// `TaskConversationListItem`. Lock the additive change.
type _L4 = Expect<Equal<Conversation["archivedAt"], string | undefined>>;

export type _D1ListItemCanary = _L1 | _L2 | _L3 | _L4;

// ── Canary 5: ParticipantsRemoved reason enum ────────────────────────
//
// Locks the `reason` discriminator (`"app_remove" | "task_leave"`).
// Drives the exhaustive-switch impl-staff writes in the broadcast
// helper; a third reason added without code coverage fails here.

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

export type _D1RemovedReasonCanary = _R1 | _R2 | _R3;

// ── Negative canary block: explicitly-rejected symbols ───────────────
//
// Spec body Goal 1 lists these as "NOT included" (deleted from the
// protocol). Each `@ts-expect-error` swallows the "no exported
// member" error; an accidental re-export turns the directive into a
// TS2578 unused-directive failure.

// @ts-expect-error — TaskConversationUpdate is NOT a D1 export (spec body Goal 1: "conversation naming is set-at-create-time only").
import type { TaskConversationUpdate as _NoUpdate } from "../index.js";
// @ts-expect-error — TaskConversationGet is NOT a D1 export (single-item filter on List; client picks).
import type { TaskConversationGet as _NoGet } from "../index.js";
// @ts-expect-error — TaskConversationMute is NOT a D1 export (mute is a client concern; `conversation_participants.muted_until` retires in D3).
import type { TaskConversationMute as _NoMute } from "../index.js";
// @ts-expect-error — TaskConversationUnmute is NOT a D1 export (paired with Mute; same rationale).
import type { TaskConversationUnmute as _NoUnmute } from "../index.js";
// @ts-expect-error — TaskConversationLeave is NOT a D1 export (agents leave whole task via TaskLeave).
import type { TaskConversationLeave as _NoConvLeave } from "../index.js";
// @ts-expect-error — TaskConversationUpdatedNotificationDefinition is NOT a D1 export (spec body Goal 5 lists 5 events; `updated` is not among them).
import type { TaskConversationUpdatedNotificationDefinition as _NoUpdatedNotif } from "../index.js";

export type _D1NegativeCanary =
  | _NoUpdate
  | _NoGet
  | _NoMute
  | _NoUnmute
  | _NoConvLeave
  | _NoUpdatedNotif;
