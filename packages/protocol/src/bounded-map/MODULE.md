# protocol/bounded-map

_`packages/protocol/src/bounded-map`_

## Purpose

Bounded insertion-ordered map shared by endpoint and server caches.

Protocol is the common dependency leaf for client and server runtime
packages, so this synchronous store lives in a focused subpath that
preserves their one-way imports.

## Public surface

### [`BoundedMap`](./index.ts#L25)

_Class_

```ts
export class BoundedMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new InvalidBoundedMapCapacity({ capacity });
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  set(key: K, value: V): readonly [K, V] | undefined {
    if (this.#entries.has(key)) {
      this.#entries.delete(key);
    }
    this.#entries.set(key, value);

    if (this.#entries.size <= this.capacity) {
      return undefined;
    }

    const oldest = this.#entries.entries().next();
    if (oldest.done) {
      return undefined;
    }
    this.#entries.delete(oldest.value[0]);
    return oldest.value;
  }

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.#entries.forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
}
```

Insertion-ordered map with a fixed entry capacity.

Setting an existing key refreshes its position without evicting another
entry. Reads preserve insertion order.

## Files

- `index.ts`
