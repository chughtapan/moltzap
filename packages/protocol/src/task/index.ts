/**
 * `@moltzap/protocol/task` — task-layer public surface.
 *
 * This entry point carries the domain schemas the task layer owns: messages,
 * conversations, contacts, invites, presence, delivery, surfaces, apps,
 * events, and their RPC method manifests. Wire frames / wire error codes /
 * transport primitives live in `@moltzap/protocol/network` and are not
 * reachable from this entry point.
 *
 * Invariant — the type graph reachable from this file MUST NOT contain any
 * type re-exported from `../network/index.ts`. An ESLint rule enforces this
 * at source level; this comment is the human-readable statement of the
 * contract.
 *
 * Stub status — every export below is a named declaration an `implement-*`
 * pass will fill in from existing schema files under `../schema/` (which
 * remain in place; this file replaces the flat `../index.ts` + `../schema/
 * index.ts` barrels by narrowing the exported set).
 */

import type { TSchema } from "../rpc.js";

/* ── Identity (task-side view of agents) ────────────────────────────────── */

export type Agent = never;
export type AgentCard = never;

/* ── Contacts ───────────────────────────────────────────────────────────── */

export type Contact = never;

/* ── Conversations ──────────────────────────────────────────────────────── */

export type Conversation = never;
export type ConversationParticipant = never;
export type ConversationSummary = never;

/* ── Messages ───────────────────────────────────────────────────────────── */

export type TextPart = never;
export type ImagePart = never;
export type FilePart = never;
export type Part = never;
export type Message = never;

/* ── Invites ────────────────────────────────────────────────────────────── */

export type Invite = never;

/* ── Presence ───────────────────────────────────────────────────────────── */

export type PresenceEntry = never;

/* ── Delivery receipts ──────────────────────────────────────────────────── */

export type DeliveryEntry = never;

/* ── Surfaces ───────────────────────────────────────────────────────────── */

export type Surface = never;

/* ── Apps ───────────────────────────────────────────────────────────────── */

export type AppPermission = never;
export type AppManifest = never;
export type AppManifestConversation = never;
export type AppSession = never;
export type AppParticipantStatus = never;

/* ── Typed event payloads ───────────────────────────────────────────────── */

export type MessageReceivedEvent = never;
export type MessageDeliveredEvent = never;
export type ConversationCreatedEvent = never;
export type ConversationUpdatedEvent = never;
export type ContactRequestEvent = never;
export type ContactAcceptedEvent = never;
export type PresenceChangedEvent = never;
export type SurfaceUpdatedEvent = never;
export type SurfaceClearedEvent = never;
export type AppSkillChallengeEvent = never;
export type PermissionsRequiredEvent = never;
export type AppParticipantAdmittedEvent = never;
export type AppParticipantRejectedEvent = never;
export type AppSessionReadyEvent = never;
export type AppSessionFailedEvent = never;
export type AppSessionClosedEvent = never;
export type AppHookTimeoutEvent = never;

/* ── RPC method manifests ───────────────────────────────────────────────── */

type TaskRpcManifest = {
  readonly name: string;
  readonly paramsSchema: TSchema;
  readonly resultSchema: TSchema;
  readonly validateParams: (data: unknown) => boolean;
};

// Messages
export declare const MessagesSend: TaskRpcManifest;
export declare const MessagesList: TaskRpcManifest;

// Conversations
export declare const ConversationsList: TaskRpcManifest;
export declare const ConversationsGet: TaskRpcManifest;
export declare const ConversationsCreate: TaskRpcManifest;
export declare const ConversationsUpdate: TaskRpcManifest;

// Contacts
export declare const ContactsList: TaskRpcManifest;
export declare const ContactsRequest: TaskRpcManifest;
export declare const ContactsRespond: TaskRpcManifest;

// Invites
export declare const InvitesCreate: TaskRpcManifest;
export declare const InvitesList: TaskRpcManifest;
export declare const InvitesRevoke: TaskRpcManifest;

// Presence
export declare const PresenceSet: TaskRpcManifest;
export declare const PresenceGet: TaskRpcManifest;

// Push preferences
export declare const PushPreferencesGet: TaskRpcManifest;
export declare const PushPreferencesSet: TaskRpcManifest;

// Apps
export declare const AppsList: TaskRpcManifest;
export declare const AppsStart: TaskRpcManifest;
export declare const AppsClose: TaskRpcManifest;
export declare const AppsGetSession: TaskRpcManifest;

/* ── Task-layer param validators (pre-compiled) ─────────────────────────── */

export declare const taskValidators: Readonly<Record<string, (data: unknown) => boolean>>;

/* ── Task-layer event name table ────────────────────────────────────────── */

export declare const EventNames: Readonly<Record<string, string>>;
