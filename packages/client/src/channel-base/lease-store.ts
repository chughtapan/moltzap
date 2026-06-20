/**
 * Channel-base `LeaseStore` — generic per-key payload tracker.
 *
 * Nanoclaw uses a string-keyed, string-valued store (keyed by JID, payload
 * is the dispatchLeaseId string). The deliberate "keep stale entry to trigger
 * server CONSUMED rejection on retry" semantic uses `peek` (read-only).
 *
 * The class wraps a private `Map`; Effect wrappers are for caller-side
 * composition. Single-threaded by construction — one instance lives per
 * channel runtime, accessed from the host event loop.
 */

import { Effect, Option } from "effect";

export class LeaseStore<HostKey, T> {
  readonly #entries = new Map<HostKey, T>();

  /** Overwrite-on-newer-inbound. Last-write-wins. */
  remember(key: HostKey, payload: T): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.#entries.set(key, payload);
    });
  }

  /**
   * Read-only lookup. Does NOT delete. Nanoclaw uses this for the
   * stale-entry-on-retry semantic at `MoltZapChannel.sendMessage`.
   */
  peek(key: HostKey): Effect.Effect<Option.Option<T>, never, never> {
    return Effect.sync(() => {
      const existing = this.#entries.get(key);
      return existing === undefined ? Option.none() : Option.some(existing);
    });
  }

  /** Read-and-delete. `Option.none` if absent (no throw). */
  consume(key: HostKey): Effect.Effect<Option.Option<T>, never, never> {
    return Effect.sync(() => {
      const existing = this.#entries.get(key);
      if (existing === undefined) return Option.none();
      this.#entries.delete(key);
      return Option.some(existing);
    });
  }

  /** Clears one key (when provided) or the whole store. */
  clear(key?: HostKey): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      if (key === undefined) {
        this.#entries.clear();
      } else {
        this.#entries.delete(key);
      }
    });
  }

  /** Entry count. */
  get size(): Effect.Effect<number, never, never> {
    return Effect.sync(() => this.#entries.size);
  }
}
