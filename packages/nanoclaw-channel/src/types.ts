/**
 * @file Minimal NanoClaw persistence types used to compile the MoltZap adapter
 * outside its host application. The module path and field shapes mirror the
 * digest-pinned NanoClaw image used by simulator runs.
 */

type EngageMode = "pattern" | "mention" | "mention-sticky";
type SenderScope = "all" | "known";
type IgnoredMessagePolicy = "drop" | "accumulate";
type UnknownSenderPolicy = "strict" | "request_approval" | "public";

/* eslint-disable @typescript-eslint/naming-convention -- These quoted fields mirror Nanoclaw's SQLite row contract exactly at the external boundary. */
/** NanoClaw routing row for one platform conversation. */
export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  // NanoClaw stamps channel_type when callers omit the default instance.
  instance?: string;
  name: string | null;
  is_group: number;
  unknown_sender_policy: UnknownSenderPolicy;
  // Callers can rely on the database's null default when denial is absent.
  denied_at?: string | null;
  created_at: string;
}

/** NanoClaw routing row connecting a platform conversation to an agent. */
export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: EngageMode;
  engage_pattern: string | null;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
  session_mode: "shared" | "per-thread" | "agent-shared";
  priority: number;
  // Null inherits the adapter declaration so routing policy stays live.
  threads?: number | null;
  created_at: string;
}

/* eslint-enable @typescript-eslint/naming-convention -- Restore strict defaults after the external row contract. */
