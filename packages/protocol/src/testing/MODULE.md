# protocol/testing

_`packages/protocol/src/testing`_

## Purpose

Public barrel for protocol testing utilities.

`@moltzap/protocol/testing` — TestClient + TestServer primitives,
arbitrary derivation, Toxiproxy adversity layer, and the conformance
runner.

## Public surface

### [`waitForValue`](./wait.ts#L30)

_Function_

```ts
export const waitForValue = <A, E = never, R = never>(
  probe: Effect.Effect<A | undefined, E, R>,
  options?: { readonly pollMillis?: number },
): Effect.Effect<A, E, R>
```

Poll `probe` until it returns a defined value, then return it.

### [`waitUntil`](./wait.ts#L18)

_Function_

```ts
export const waitUntil = (
  predicate: () => boolean,
  options?: { readonly pollMillis?: number },
): Effect.Effect<void>
```

Poll `predicate` until it returns true.

### [`WIRE_ERROR_TAG`](./wire-error-tags.ts#L9)

_Variable_

```ts
export const WIRE_ERROR_TAG =
```

## Files

- `wait.ts`
- `wire-error-tags.ts`
