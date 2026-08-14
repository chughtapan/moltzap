/**
 * @file In-memory mirror of NanoClaw's channel registry for isolated adapter
 * tests. The same module path binds to the host registry when the adapter is
 * installed in NanoClaw.
 */

import type { ChannelRegistration } from "./adapter.js";

// safer-arch-ignore no-trivial-sink-file: This host-substitution seam mirrors Nanoclaw's registry contract so the channel source binds to the real runtime registry when installed and to this smoke-test stub in isolation.
const registrations = new Map<string, ChannelRegistration>();

/**
 * Records an adapter factory under its host-facing channel name.
 * @param name Channel name NanoClaw uses for registration.
 * @param registration Factory and defaults exposed to NanoClaw.
 */
export function registerChannelAdapter(
  name: string,
  registration: ChannelRegistration,
): void {
  registrations.set(name, registration);
}

/**
 * Looks up an adapter registration recorded by an isolated test.
 * @param name Host-facing channel name to look up.
 * @internal
 * @returns The matching registration, or `undefined` when none was recorded.
 */
export function getRegisteredChannelAdapter(
  name: string,
): ChannelRegistration | undefined {
  return registrations.get(name);
}
