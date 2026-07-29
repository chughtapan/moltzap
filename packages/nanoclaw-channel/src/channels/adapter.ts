/* eslint-disable agent-code-guard/promise-type -- nanoclaw's ChannelAdapter contract is Promise-based; the mirrored signatures must match upstream verbatim. */
// Stub types matching the subset of nanoclaw's src/channels/adapter.ts that
// moltzap.ts touches. When moltzap.ts is copied into a real nanoclaw
// checkout, these imports resolve against nanoclaw's own adapter module
// (same signatures). Mirrors the surface at the commit pinned by
// NANOCLAW_SHA in packages/testbed/src/nanoclaw-install.ts; keep aligned
// when bumping that pin.

export interface ChannelSetup {
  onInbound(
    platformId: string,
    threadId: string | null,
    message: InboundMessage,
  ): void | Promise<void>;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
}

export interface InboundMessage {
  id: string;
  kind: "chat" | "chat-sdk";
  content: unknown;
  timestamp: string;
  isMention?: boolean;
  isGroup?: boolean;
}

interface OutboundFile {
  filename: string;
  data: Uint8Array;
}

export interface OutboundMessage {
  kind: string;
  content: unknown;
  files?: OutboundFile[];
}

interface ChannelContextDefaults {
  engageMode: "pattern" | "mention" | "mention-sticky";
  engagePattern?: string;
  threads: boolean;
  unknownSenderPolicy: "strict" | "request_approval" | "public";
}

export interface ChannelDefaults {
  dm: ChannelContextDefaults;
  group: ChannelContextDefaults;
  mentions: "platform" | "dm-only" | "never";
}

export interface ChannelAdapter {
  name: string;
  channelType: string;
  instance?: string;
  supportsThreads: boolean;
  setup(config: ChannelSetup): Promise<void>; // #ignore-sloppy-code[promise-type]: mirrors nanoclaw's Promise-based contract verbatim
  teardown(): Promise<void>; // #ignore-sloppy-code[promise-type]: mirrors nanoclaw's Promise-based contract verbatim
  isConnected(): boolean;
  deliver(
    platformId: string,
    threadId: string | null,
    message: OutboundMessage,
  ): Promise<string | undefined>; // #ignore-sloppy-code[promise-type]: mirrors nanoclaw's Promise-based contract verbatim
  defaults?: ChannelDefaults;
}

type ChannelAdapterFactory = () =>
  | ChannelAdapter
  | Promise<ChannelAdapter>
  | null;

export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  defaults?: ChannelDefaults;
}
