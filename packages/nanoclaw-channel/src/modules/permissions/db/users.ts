// safer-arch-ignore no-trivial-sink-file: Deliberate db-layer helper owning permission user persistence for the channel adapter.
// Stub matching the subset of nanoclaw's src/modules/permissions/db/users.ts
// that moltzap.ts touches; resolves against the real sqlite-backed module
// inside a nanoclaw checkout.
import type { User } from "../../../types.js";

const users = new Map<string, User>();

export function upsertUser(user: User): void {
  users.set(user.id, user);
}

/**
 * Test hook; the real nanoclaw module persists to sqlite.
 * @internal
 */
export function getUserById(id: string): User | undefined {
  return users.get(id);
}
