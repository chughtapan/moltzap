// Stub types matching the subset of nanoclaw's src/types.ts that the
// bundled channel touches. When moltzap.ts is copied into a real nanoclaw
// checkout, these imports resolve against nanoclaw's own src/types.ts
// (same signatures).
//
// Keep this mirrored surface aligned with the digest-pinned NanoClaw
// application image used by simulator runs.

type EngageMode = "pattern" | "mention" | "mention-sticky";
type SenderScope = "all" | "known";
type IgnoredMessagePolicy = "drop" | "accumulate";
type UnknownSenderPolicy = "strict" | "request_approval" | "public";

/* eslint-disable @typescript-eslint/naming-convention -- These quoted fields mirror Nanoclaw's SQLite row contract exactly at the external boundary. */
/** Describes messaging group. */
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

/** Describes messaging group agent. */
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
