# protocol/testing/conformance/identity

_`packages/protocol/src/testing/conformance/identity`_

## Purpose

Public barrel for identity-layer conformance properties.

Identity-layer conformance properties.

Authority + agent-identity invariants — who is allowed to call what,
positive-path authority checks, negative-path rejections.

Each `register*` lives in its own file. This barrel re-exports them
by name AND aggregates them into `IDENTITY_PROPERTIES` for the
`_shared/suite.ts` aggregator.

## Public surface

### [`IDENTITY_PROPERTIES`](./index.ts#L24)

_Variable_

```ts
export const IDENTITY_PROPERTIES: ReadonlyArray<
  (ctx: ConformanceRunContext) => void
> = [registerAuthorityPositive, registerAuthorityNegative]
```

All identity-layer property registrars, in suite walk order
(authority-positive → authority-negative).

### [`registerAuthorityNegative`](./authority-negative.ts#L40)

_Function_

```ts
export function registerAuthorityNegative(ctx: ConformanceRunContext): void
```

### [`registerAuthorityPositive`](./authority-positive.ts#L30)

_Function_

```ts
export function registerAuthorityPositive(ctx: ConformanceRunContext): void
```

## Files

- `authority-negative.ts`
- `authority-positive.ts`
- `index.ts`
