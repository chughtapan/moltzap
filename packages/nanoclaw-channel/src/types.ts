// Stub types matching the subset of nanoclaw's src/types.ts that moltzap.ts touches.
// When moltzap.ts is copied into a real nanoclaw fork, these imports resolve
// against nanoclaw's own src/types.ts (which has the same signatures).
//
// Mirrors the channel surface at NanoClaw SHA
// 934f063aff5c30e7b49ce58b53b41901d3472a3e. Update these stubs with the
// NANOCLAW_SHA in packages/testbed/src/nanoclaw-install.ts.

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
  ...metadata: [
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ]
) => void;
