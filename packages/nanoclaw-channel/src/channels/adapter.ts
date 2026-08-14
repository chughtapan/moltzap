/**
 * @file Minimal NanoClaw channel contract used to compile the MoltZap adapter
 * outside its host application. The module path and signatures mirror the
 * digest-pinned NanoClaw image used by simulator runs, so the installed adapter
 * binds to NanoClaw's own declarations.
 */

/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- nanoclaw's ChannelAdapter contract is Promise-based; the mirrored signatures must match upstream verbatim. */

/** Host callbacks a channel invokes for projected metadata and messages. */
export interface ChannelSetup {
  onInbound(
    platformId: string,
    threadId: string | null,
    message: InboundMessage,
  ): void | Promise<void>;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
}

/** Inbound message shape accepted by NanoClaw's channel host. */
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

/** Outbound message shape emitted by the NanoClaw host. */
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

/** Routing defaults NanoClaw applies to direct and group contexts. */
export interface ChannelDefaults {
  dm: ChannelContextDefaults;
  group: ChannelContextDefaults;
  mentions: "platform" | "dm-only" | "never";
}

/** Lifecycle and delivery surface implemented by a NanoClaw channel. */
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

/** Factory and defaults recorded under a NanoClaw channel name. */
export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  defaults?: ChannelDefaults;
}

/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore strict defaults after the scoped exception. */
