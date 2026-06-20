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
import type { Effect } from "effect";

export interface ChannelOpts {
  profileName?: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

type ChannelFactory = (opts: ChannelOpts) => Effect.Effect<Channel, unknown>;

const registeredChannelFactories = new Map<string, ChannelFactory>();

/**
 * Register a `ChannelFactory` under a name so the nanoclaw runtime
 * can construct channel instances by name at boot. The moltzap
 * channel registers itself at module load via
 * `registerChannel("moltzap", channelFactory)`.
 *
 * Idempotent: re-registering the same factory under the same name
 * is a no-op (avoids double-registration warnings when this module
 * is loaded twice in a hot-reload environment).
 *
 * The factory returns an Effect because channel construction loads the
 * MoltZap client config and must not expose a half-configured channel.
 */
export function registerChannel(name: string, factory: ChannelFactory): void {
  if (registeredChannelFactories.get(name) === factory) return;
  registeredChannelFactories.set(name, factory);
}
