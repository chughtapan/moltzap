// Stub matching the subset of nanoclaw's src/channels/channel-registry.ts
// that moltzap.ts touches; resolves against the real module inside a
// nanoclaw checkout. The in-repo registry records registrations so unit
// tests can drive the factory the same way the nanoclaw daemon does.
import type { ChannelRegistration } from "./adapter.js";

// safer-arch-ignore no-trivial-sink-file: This host-substitution seam mirrors Nanoclaw's registry contract so the channel source binds to the real runtime registry when installed and to this smoke-test stub in isolation.
const registrations = new Map<string, ChannelRegistration>();

/**
 * Registers channel adapter.
 * @param name Name of the operation.
 * @param registration Value supplied to the operation.
 */
export function registerChannelAdapter(
  name: string,
  registration: ChannelRegistration,
): void {
  registrations.set(name, registration);
}

/**
 * Test hook; the real nanoclaw registry has richer accessors.
 * @param name Name of the operation.
 * @internal
 * @returns The get registered channel adapter result.
 */
export function getRegisteredChannelAdapter(
  name: string,
): ChannelRegistration | undefined {
  return registrations.get(name);
}
