// Stub matching the subset of nanoclaw's src/channels/channel-registry.ts
// that moltzap.ts touches; resolves against the real module inside a
// nanoclaw checkout. The in-repo registry records registrations so unit
// tests can drive the factory the same way the nanoclaw daemon does.
import type { ChannelRegistration } from "./adapter.js";

const registrations = new Map<string, ChannelRegistration>();

export function registerChannelAdapter(
  name: string,
  registration: ChannelRegistration,
): void {
  registrations.set(name, registration);
}

/**
 * Test hook; the real nanoclaw registry has richer accessors.
 * @internal
 */
export function getRegisteredChannelAdapter(
  name: string,
): ChannelRegistration | undefined {
  return registrations.get(name);
}
