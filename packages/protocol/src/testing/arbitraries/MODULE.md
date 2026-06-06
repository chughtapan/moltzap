# protocol/testing/arbitraries

_`packages/protocol/src/testing/arbitraries`_

## Purpose

Public barrel for schema-derived protocol arbitraries used by tests.

## Public surface

### [`allRpcMethods`](./rpc.ts#L35)

_Variable_

```ts
export const allRpcMethods: ReadonlyArray<MethodName> =
  serverInboundMethods.map((m) => m.name)
```

Ordered list of every wire method name. Exposed so properties can
assert "every method exercised at least once" without going through
`RpcMap` directly.

### [`arbitraryAnyCall`](./rpc.ts#L67)

_Function_

```ts
export function arbitraryAnyCall(): fc.Arbitrary<ArbitraryRpcCall>
```

Arbitrary that draws any method name + matching params. Used by the
RpcMap-coverage property and the cross-RPC fuzz property.

### [`arbitraryCallFor`](./rpc.ts#L44)

_Function_

```ts
export function arbitraryCallFor(
  method: MethodName,
): fc.Arbitrary<ArbitraryRpcCall>
```

Arbitrary of a valid params tree for a single, fixed RPC.

### [`arbitraryFromSchema`](./schema-arbitrary.ts#L23)

_Function_

```ts
export function arbitraryFromSchema<S extends Schema.Schema.AnyNoContext>(
  schema: S,
): FastCheck.Arbitrary<Schema.Schema.Type<S>>
```

Derive an `Arbitrary&lt;Schema.Schema.Type&lt;S>>` for any Effect `Schema`. The
derivation is pure: given the same schema + fast-check seed, it yields the
same value tree (AC10 reproducibility). The return type is Effect's
re-exported `FastCheck.Arbitrary` — the SAME `fast-check` module the rest of
the suite samples with (both pinned to fast-check v3, the version Effect's
`Arbitrary.make` binds to), so no cross-module cast is needed.

### [`ArbitraryRpcCall`](./rpc.ts#L24)

_Interface_

```ts
export interface ArbitraryRpcCall {
  readonly definition: AnyServerRpcDefinition;
  readonly method: MethodName;
  readonly params: unknown;
}
```

A single drawn RPC invocation: the method name selects the wire
definition and the params tree is drawn from that definition's schema.

## Files

- `rpc.ts`
- `schema-arbitrary.ts`
