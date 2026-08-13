# protocol/identity/principals

_`packages/protocol/src/identity/principals`_

## Purpose

Principal middleware requirement tags.

## Public surface

### [`AuthenticatedAgent`](./index.ts#L16)

_Class_

```ts
export class AuthenticatedAgent extends RpcMiddleware.Tag<AuthenticatedAgent>()(
  "@moltzap/protocol/requirement/AuthenticatedAgent",
  { failure: principalGateFailure },
) {}
```

Principal requirement: the connection is an authenticated agent. The sole
principal gate — every gated method heads its `requires` with this tag,
rejecting the unauthenticated pre-connect arm.

### [`PrincipalRequirement`](./index.ts#L22)

_TypeAlias_

```ts
export type PrincipalRequirement = typeof AuthenticatedAgent;
```

The principal-requirement tag that heads a gated RPC descriptor.

## Files

- `index.ts`
