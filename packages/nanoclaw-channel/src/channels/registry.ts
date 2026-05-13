// Stub registry matching nanoclaw's src/channels/registry.ts. In a real nanoclaw
// install, moltzap.ts imports from './registry.js' and resolves to nanoclaw's
// actual channel registry. In this package, we re-implement the minimal surface
// so the channel file compiles and unit-tests in isolation.

import type {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from "../types.js";

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registeredChannelFactories = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  if (registeredChannelFactories.get(name) === factory) return;
  registeredChannelFactories.set(name, factory);
}
