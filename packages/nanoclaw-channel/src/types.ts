// Stub types matching the subset of nanoclaw's src/types.ts that moltzap.ts touches.
// When moltzap.ts is copied into a real nanoclaw fork, these imports resolve
// against nanoclaw's own src/types.ts (which has the same signatures).
//
// Pinned to nanoclaw 1.2.52 types as of 2026-04-10. If nanoclaw upstream refactors
// these signatures, bump the stubs together with the pinned NANOCLAW_SHA in
// packages/runtimes/src/nanoclaw-process.ts.

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: {
    additionalMounts?: Array<{
      hostPath: string;
      containerPath?: string;
      readonly?: boolean;
    }>;
    timeout?: number;
  };
  requiresTrigger?: boolean;
  isMain?: boolean;
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
}

type UpstreamAsyncVoid = ReturnType<typeof Promise.resolve<void>>;

export interface Channel {
  name: string;
  connect(): UpstreamAsyncVoid;
  sendMessage(jid: string, text: string): UpstreamAsyncVoid;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): UpstreamAsyncVoid;
  setTyping?(jid: string, isTyping: boolean): UpstreamAsyncVoid;
  syncGroups?(force: boolean): UpstreamAsyncVoid;
}

export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
