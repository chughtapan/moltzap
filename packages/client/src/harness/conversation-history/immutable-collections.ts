/**
 * @file Creates collection snapshots whose native mutation methods remain
 * unreachable even through an unsafe runtime cast.
 */

/**
 * Copy values behind a frozen closure-backed read-only set view.
 *
 * @param values Values to detach from their mutable source collection.
 * @returns A frozen view with no native mutation methods.
 */
export function readonlySetSnapshot<Value>(
  values: Iterable<Value>,
): ReadonlySet<Value> {
  const snapshot = new Set(values);
  const view: ReadonlySet<Value> = {
    get size() {
      return snapshot.size;
    },
    has: (value: Value) => snapshot.has(value),
    entries: () => snapshot.entries(),
    keys: () => snapshot.keys(),
    values: () => snapshot.values(),
    forEach: (...parameters: Parameters<ReadonlySet<Value>["forEach"]>) => {
      const callback = parameters[0];
      const thisArgument: unknown = parameters[1];
      for (const value of snapshot) {
        if (thisArgument === undefined) {
          callback(value, value, view);
        } else {
          callback.call(thisArgument, value, value, view);
        }
      }
    },
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
  };
  return Object.freeze(view);
}

/**
 * Copy entries behind a frozen closure-backed read-only map view.
 *
 * @param entries Entries to detach from their mutable source collection.
 * @returns A frozen view with no native mutation methods.
 */
export function readonlyMapSnapshot<Key, Value>(
  entries: Iterable<readonly [Key, Value]>,
): ReadonlyMap<Key, Value> {
  const snapshot = new Map(entries);
  const view: ReadonlyMap<Key, Value> = {
    get size() {
      return snapshot.size;
    },
    get: (key: Key) => snapshot.get(key),
    has: (key: Key) => snapshot.has(key),
    entries: () => snapshot.entries(),
    keys: () => snapshot.keys(),
    values: () => snapshot.values(),
    forEach: (
      ...parameters: Parameters<ReadonlyMap<Key, Value>["forEach"]>
    ) => {
      const callback = parameters[0];
      const thisArgument: unknown = parameters[1];
      for (const [key, value] of snapshot) {
        if (thisArgument === undefined) {
          callback(value, key, view);
        } else {
          callback.call(thisArgument, value, key, view);
        }
      }
    },
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
  };
  return Object.freeze(view);
}
