/**
 * @file Synchronous read helpers for Effect Ref and immutable HashMap values
 * at object-method boundaries.
 */

import { Effect, HashMap, Option, Ref } from "effect";

/**
 * Read a `Ref` synchronously outside an Effect scope. Only safe for `Ref`s
 * that never fiber-park (the stock `Ref.Ref&lt;A>` never does). Use from
 * object methods or sync code paths that hold a `Ref` set up at construction.
 * @param ref In-memory reference whose current value is immediately available.
 * @returns The value observed at the synchronous call boundary.
 */
export const snapshot = <A>(ref: Ref.Ref<A>): A => Effect.runSync(Ref.get(ref));

/**
 * Lookup `key` in `m`, falling back to `dflt()` if absent. Lazy default.
 * @param m Immutable map to inspect.
 * @param key Key whose value is requested.
 * @param dflt Lazy fallback, evaluated only when the key is absent.
 * @returns The stored value or the fallback value.
 */
export const getOr = <K, V>(
  m: HashMap.HashMap<K, V>,
  key: K,
  dflt: () => V,
): V => Option.getOrElse(HashMap.get(m, key), dflt);
