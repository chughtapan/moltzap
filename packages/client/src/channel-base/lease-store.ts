/**
 * Channel-base `LeaseStore<HostKey, T>` — generic per-key payload tracker.
 *
 * Nanoclaw uses `LeaseStore<string, string>` (keyed by JID, payload is the
 * dispatchLeaseId string). The deliberate "keep stale entry to trigger
 * server CONSUMED rejection on retry" semantic is preserved via `peek`
 * (read-only) — see arch sub-issue #605 §3.3 and §6.3.
 *
 * Implementation is impl-staff scope. The class wraps a private `Map`;
 * Effect wrappers are for caller-side composition, not concurrency.
 */

import type { Effect, Option } from "effect";

export class LeaseStore<HostKey, T> {
  // Implementation note (impl-staff): private map field. Constructor is a
  // no-arg ctor; HostKey + T are pure type parameters with no runtime
  // witness required.
  constructor() {
    throw new Error("not implemented (arch stub; impl-staff scope)");
  }

  /** Overwrite-on-newer-inbound. Last-write-wins per spec table. */
  remember(_key: HostKey, _payload: T): Effect.Effect<void, never, never> {
    throw new Error("not implemented (arch stub; impl-staff scope)");
  }

  /**
   * Read-only lookup. Does NOT delete. Nanoclaw uses this for the
   * stale-entry-on-retry semantic at `MoltZapChannel.sendMessage`.
   */
  peek(_key: HostKey): Effect.Effect<Option.Option<T>, never, never> {
    throw new Error("not implemented (arch stub; impl-staff scope)");
  }

  /** Read-and-delete. `Option.none` if absent (no throw). */
  consume(_key: HostKey): Effect.Effect<Option.Option<T>, never, never> {
    throw new Error("not implemented (arch stub; impl-staff scope)");
  }

  /** Clears one key (when provided) or the whole store. */
  clear(_key?: HostKey): Effect.Effect<void, never, never> {
    throw new Error("not implemented (arch stub; impl-staff scope)");
  }

  /** Entry count. */
  get size(): Effect.Effect<number, never, never> {
    throw new Error("not implemented (arch stub; impl-staff scope)");
  }
}
