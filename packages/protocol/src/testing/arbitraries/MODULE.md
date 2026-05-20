# protocol/testing/arbitraries

_`packages/protocol/src/testing/arbitraries`_

## Purpose

Public barrel for schema-derived protocol arbitraries used by tests.

## Public surface

### [`allRpcMethods`](./rpc.ts#L38)

_Variable_

```ts
export const allRpcMethods: ReadonlyArray<MethodName> = rpcMethods.map(
  (m)
```

Ordered list of every wire method name. Exposed so properties can
assert "every method exercised at least once" without going through
`RpcMap` directly.

### [`arbitraryAnyCall`](./rpc.ts#L71)

_Function_

```ts
export function arbitraryAnyCall(): fc.Arbitrary<ArbitraryRpcCall>
```

Arbitrary that draws any method name + matching params. Used by Tier A
A5 and by Tier E E2's cross-RPC fuzz.

### [`arbitraryCallFor`](./rpc.ts#L48)

_Function_

```ts
export function arbitraryCallFor(
  method: MethodName,
): fc.Arbitrary<ArbitraryRpcCall>
```

Arbitrary of a valid params tree for a single, fixed RPC.

### [`arbitraryConfidentCall`](./rpc.ts#L127)

_Function_

```ts
export function arbitraryConfidentCall(): fc.Arbitrary<ArbitraryRpcCall>
```

Draw a call from the model's confident-oracle set. Per architect
#197 §2.2 literal shape: `fc.constantFrom(...kept).chain(
arbitraryCallFor)`. Probe at module load uses the same
`arbitraryCallFor(m)` generator as execution — so confidence is
checked on the same distribution the property exercises.

If a kept method turns out to be param-sensitive under a later
draw (model predicts ok for the one probe sample but rejects a
subsequent arbitrary-drawn params), the safety-net guard in
`registerModelEquivalence` raises `PropertyInvariantViolation`
pointing at this file — the fix is to widen the derivation (probe
K > 1 samples and keep only methods where every probe predicts ok)
per the architect's contract. Single-probe is sufficient when
`applyCall` is method-only (today).

### [`arbitraryForParams`](./from-typebox.ts#L266)

_Function_

```ts
export function arbitraryForParams<S extends TSchema>(
  schema: S,
): fc.Arbitrary<Static<S>>
```

Shrink-preserving narrower. Some schemas (`Type.Unknown`, `Type.Any`)
produce open-world trees that drown properties in noise. This returns a
narrowed arbitrary still `Value.Check`-valid against `schema` but biased
toward "small typical" values the reference model can reason about.

For now the narrowing strategy is identical to `arbitraryFromSchema` with
smaller default string/array bounds (handled inside `walk`). Exposed as a
distinct export so call sites document their intent.

### [`arbitraryFromSchema`](./from-typebox.ts#L62)

_Function_

```ts
export function arbitraryFromSchema<S extends TSchema>(
  schema: S,
): fc.Arbitrary<Static<S>>
```

Derive an `Arbitrary&lt;Static&lt;S>>` for any TypeBox schema. The derivation
is pure: given the same schema + fast-check seed, it yields the same
value tree (AC10 reproducibility).

### [`arbitraryMalformedFrame`](./frames.ts#L77)

_Function_

```ts
export function arbitraryMalformedFrame(): fc.Arbitrary<ArbitraryMalformedFrame>
```

### [`ArbitraryMalformedFrame`](./frames.ts#L71)

_Interface_

```ts
export interface ArbitraryMalformedFrame {
  readonly base: AnyFrame;
  readonly kind: MalformedFrameKind;
  readonly seed: number;
}
```

Arbitrary of a `(baseFrame, MalformedFrameKind, seed)` tuple so Tier A /
D can replay a specific mutation on shrink.

### [`arbitraryNotificationFrame`](./frames.ts#L48)

_Function_

```ts
export function arbitraryNotificationFrame(): fc.Arbitrary<NotificationFrame>
```

### [`arbitraryRequestFrame`](./frames.ts#L38)

_Function_

```ts
export function arbitraryRequestFrame(): fc.Arbitrary<RequestFrame>
```

### [`arbitraryResponseFrame`](./frames.ts#L42)

_Function_

```ts
export function arbitraryResponseFrame(): fc.Arbitrary<ResponseFrame>
```

### [`ArbitraryRpcCall`](./rpc.ts#L27)

_Interface_

```ts
export interface ArbitraryRpcCall {
  readonly definition: AnyRpcDefinition;
  readonly method: MethodName;
  readonly params: unknown;
}
```

A single drawn RPC invocation: the method name carries through to the
reference model so it can pick the matching reducer.

### [`confidentOracleMethods`](./rpc.ts#L97)

_Variable_

```ts
export const confidentOracleMethods: ReadonlyArray<MethodName> = (()
```

The set of method names the reference model predicts `_tag: "ok"`
for on `initialReferenceState` — derived mechanically at module load
by probing `applyCall` with a single drawn params value per method.

Per architect #197 §2.2: this is NOT a hand-curated list. Methods
move in/out of the confident set automatically when `applyCall`'s
`allowNoEvents` / `uncertainError` split moves, so the sampling
distribution tracks the model.

**Param-invariance contract:** every kept method is treated as
oracle-confident for every params value. If a future `applyCall`
amendment branches on `call.params`, the safety-net guard in
`registerModelEquivalence` (rpc-semantics.ts) fires loudly on the
first non-confident draw and the derivation must widen from the
single-probe form to an `fc.sample`-based invariant check.

## Files

- `frames.ts`
- `from-typebox.ts`
- `rpc.ts`
