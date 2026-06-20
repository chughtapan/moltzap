# protocol/identity/principals

_`packages/protocol/src/identity/principals`_

## Purpose

Principal middleware requirement tags.

## Public surface

### [`AgentPrincipal`](./agent-principal.ts#L12)

_Class_

```ts
export class AgentPrincipal extends RpcMiddleware.Tag<AgentPrincipal>()(
  "@moltzap/protocol/requirement/AgentPrincipal",
  { failure: principalGateFailure },
) {}
```

Principal requirement: narrow the live connection to the agent arm. The first
element of an agent-callable method's `requires`. Fails `Unauthorized` /
`Forbidden` on a non-agent arm.

### [`AppPrincipal`](./app-principal.ts#L12)

_Class_

```ts
export class AppPrincipal extends RpcMiddleware.Tag<AppPrincipal>()(
  "@moltzap/protocol/requirement/AppPrincipal",
  { failure: principalGateFailure },
) {}
```

Principal requirement: narrow the live connection to the app arm. The first
element of an app-callable method's `requires`. Fails `Unauthorized` /
`Forbidden` on a non-app arm.

### [`AuthenticatedPrincipal`](./authenticated-principal.ts#L12)

_Class_

```ts
export class AuthenticatedPrincipal extends RpcMiddleware.Tag<AuthenticatedPrincipal>()(
  "@moltzap/protocol/requirement/AuthenticatedPrincipal",
  { failure: principalGateFailure },
) {}
```

Principal requirement: require any authenticated arm. Used by methods that
are shared by first-party agent and app clients but still must reject the
unauthenticated pre-connect arm.

### [`PrincipalRequirement`](./types.ts#L6)

_TypeAlias_

```ts
export type PrincipalRequirement =
  | typeof AgentPrincipal
  | typeof AppPrincipal
  | typeof AuthenticatedPrincipal;
```

The principal-requirement tags that can head a gated RPC descriptor.

## Files

- `agent-principal.ts`
- `app-principal.ts`
- `authenticated-principal.ts`
- `types.ts`
