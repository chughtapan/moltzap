import { Deferred, Effect, HashMap, Ref } from "effect";

/**
 * Coalesce concurrent requests for the same key onto a single in-flight
 * Deferred. The first caller forks `work` as a daemon and registers the
 * Deferred atomically via `Ref.modify`; subsequent callers retrieve the
 * same Deferred and await it. Entries are removed when the work completes
 * so the next call with the same key starts fresh. `Ref.modify` is atomic
 * so two fibers can't both see `!has(key)` and install separate Deferreds.
 */
export const coalesce = <K, A, E>(
  ref: Ref.Ref<HashMap.HashMap<K, Deferred.Deferred<A, E>>>,
  key: K,
  work: Effect.Effect<A, E>,
): Effect.Effect<A, E> => {
  // Ref.modify + forkDaemon MUST be atomic: if the caller fiber is
  // interrupted between them, the Deferred is registered in the map
  // but no daemon exists to populate it, and future callers on the
  // same key would await forever.
  const install = Ref.modify(
    ref,
    (
      map: HashMap.HashMap<K, Deferred.Deferred<A, E>>,
    ): [
      { deferred: Deferred.Deferred<A, E>; isOwner: boolean },
      HashMap.HashMap<K, Deferred.Deferred<A, E>>,
    ] => {
      const existing = HashMap.get(map, key);
      if (existing._tag === "Some") {
        return [{ deferred: existing.value, isOwner: false }, map];
      }
      const d = Effect.runSync(Deferred.make<A, E>());
      return [{ deferred: d, isOwner: true }, HashMap.set(map, key, d)];
    },
  );

  // Mostly-uninterruptible: install + fork is atomic (can't be split by
  // caller interrupt), but the work running inside the daemon and the
  // per-caller Deferred.await both need `restore()` so timeouts / races
  // inside `work` can actually interrupt their inner `Effect.async`.
  return Effect.uninterruptibleMask((restore) =>
    install.pipe(
      Effect.tap(({ deferred, isOwner }) =>
        isOwner
          ? Effect.forkDaemon(
              restore(work).pipe(
                Effect.exit,
                Effect.flatMap((exit) =>
                  Ref.update(ref, (m) => HashMap.remove(m, key)).pipe(
                    Effect.andThen(
                      exit._tag === "Success"
                        ? Deferred.succeed(deferred, exit.value)
                        : Deferred.failCause(deferred, exit.cause),
                    ),
                  ),
                ),
              ),
            )
          : Effect.void,
      ),
      Effect.flatMap(({ deferred }) => restore(Deferred.await(deferred))),
    ),
  );
};

/** Interrupt every pending Deferred in the coalesce map and clear it. */
export const drainCoalesceMap = <K, A, E>(
  ref: Ref.Ref<HashMap.HashMap<K, Deferred.Deferred<A, E>>>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const map = yield* Ref.getAndSet(
      ref,
      HashMap.empty<K, Deferred.Deferred<A, E>>(),
    );
    for (const [, d] of HashMap.entries(map)) {
      yield* Deferred.interrupt(d);
    }
  });
