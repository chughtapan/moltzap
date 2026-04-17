import { Effect, HashMap, Option, Ref } from "effect";

/**
 * Read a `Ref` synchronously outside an Effect scope. Only safe for `Ref`s
 * that never fiber-park (the stock `Ref.Ref<A>` never does). Use from
 * object methods or sync code paths that hold a `Ref` set up at construction.
 */
export const snapshot = <A>(ref: Ref.Ref<A>): A => Effect.runSync(Ref.get(ref));

/** Lookup `key` in `m`, falling back to `dflt()` if absent. Lazy default. */
export const getOr = <K, V>(
  m: HashMap.HashMap<K, V>,
  key: K,
  dflt: () => V,
): V => Option.getOrElse(HashMap.get(m, key), dflt);
