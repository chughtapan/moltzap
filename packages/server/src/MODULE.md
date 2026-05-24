# server-core/src

_`packages/server/src`_

## Purpose

`@moltzap/server-core` main entry — consumed via the bin and the `./test-utils` subpath.

## Public surface

### [`SchemaFileNotFound`](./standalone.ts#L41)

_Class_

```ts
export class SchemaFileNotFound extends Data.TaggedError("SchemaFileNotFound")<{
  readonly message: string;
}> {}
```

### [`StandaloneOperationFailed`](./standalone.ts#L33)

_Class_

```ts
export class StandaloneOperationFailed extends Data.TaggedError(
  "StandaloneOperationFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
  readonly operation: string;
}> {}
```

### [`startServer`](./standalone.ts#L257)

_Function_

```ts
export function startServer(configPath?: string)
```

## Files

- `standalone.ts`
