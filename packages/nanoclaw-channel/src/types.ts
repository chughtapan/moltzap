// Stub types matching the subset of nanoclaw's src/types.ts that the
// bundled channel touches. When moltzap.ts is copied into a real nanoclaw
// checkout, these imports resolve against nanoclaw's own src/types.ts
// (same signatures).
//
// Mirrors the surface at the commit pinned by NANOCLAW_SHA in
// packages/testbed/src/nanoclaw-install.ts; keep these stubs aligned when
// bumping that pin.

type EngageMode = "pattern" | "mention" | "mention-sticky";
type SenderScope = "all" | "known";
type IgnoredMessagePolicy = "drop" | "accumulate";
type UnknownSenderPolicy = "strict" | "request_approval" | "public";

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string;
  is_group: number;
  unknown_sender_policy: UnknownSenderPolicy;
  created_at: string;
}

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
  created_at: string;
}

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
}

export interface User {
  id: string;
  kind: string;
  display_name: string;
  created_at: string;
}
