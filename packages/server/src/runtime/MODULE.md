# server-core/runtime

_`packages/server/src/runtime`_

## Purpose

Runtime helpers for RPC validation and request coalescing.

## Public surface

### [`coalesce`](./coalesce.ts#L66)

_Function_

```ts
export const coalesce = <K, A, E>(
  ref: Ref.Ref<HashMap.HashMap<K, Deferred.Deferred<A, E>>>,
  key: K,
  work: Effect.Effect<A, E>,
): Effect.Effect<A, E>
```

Coalesce concurrent requests for the same key onto a single in-flight
Deferred. The first caller forks `work` as a daemon and registers the
Deferred atomically via `Ref.modify`; subsequent callers retrieve the
same Deferred and await it. Entries are removed when the work completes
so the next call with the same key starts fresh. `Ref.modify` is atomic
so two fibers can't both see `!has(key)` and install separate Deferreds.

### [`currentArgv`](./direct-run.ts#L8)

_Function_

```ts
export function currentArgv(): readonly string[]
```

### [`drainCoalesceMap`](./coalesce.ts#L105)

_Function_

```ts
export const drainCoalesceMap = <K, A, E>(
  ref: Ref.Ref<HashMap.HashMap<K, Deferred.Deferred<A, E>>>,
): Effect.Effect<void>
```

Interrupt every pending Deferred in the coalesce map and clear it.

### [`isStandaloneDirectRun`](./direct-run.ts#L1)

_Function_

```ts
export function isStandaloneDirectRun(argv: readonly string[]): boolean
```

### [`validateParams`](./validator.ts#L12)

_Function_

```ts
export const validateParams = <T>(
  validator: Validator<T>,
  input: unknown,
): Effect.Effect<T, InvalidParamsError>
```

Lift an AJV validator into an Effect. Succeeds with the narrowed `T`,
fails with `InvalidParamsError` — never defects. The `T` parameter must
match the AJV schema at the call site.

### [`Validator`](./validator.ts#L5)

_TypeAlias_

```ts
export type Validator<T> = (input: unknown) => input is T;
```

AJV validator shape (`Ajv.ValidateFunction`) without importing AJV.

## Files

- `coalesce.ts`
- `direct-run.ts`
- `validator.ts`
