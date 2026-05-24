# server-core/src

_`packages/server/src`_

## Purpose

Public exports for `@moltzap/server-core`.

## Public surface

### [`decodeAppManifest`](./standalone.ts#L130)

_Function_

```ts
    try: ()
```

### [`InvalidAppManifest`](./standalone.ts#L51)

_Class_

```ts
  operation: string,
  cause: unknown,
): StandaloneOperationFailed =>
  new StandaloneOperationFailed({
```

Decode failure for an on-disk app manifest. `kind` discriminates JSON
parse failures from schema-validation failures so callers can log the
specific edge that fired without re-inspecting the cause.

### [`SchemaFileNotFound`](./standalone.ts#L42)

_Class_

```ts
  readonly message: string;
```

### [`StandaloneOperationFailed`](./standalone.ts#L34)

_Class_

```ts
  "StandaloneOperationFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
}> {}
```

### [`startServer`](./standalone.ts#L334)

_Function_

```ts
  if (!usePgLite) return Effect.void
```

## Files

- `standalone.ts`
