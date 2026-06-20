# protocol/identity/requirements

_`packages/protocol/src/identity/requirements`_

## Purpose

Identity-owned refinement requirement tags.

## Public surface

### [`ActiveAgent`](./active-agent.ts#L10)

_Class_

```ts
export class ActiveAgent extends RpcMiddleware.Tag<ActiveAgent>()(
  "@moltzap/protocol/requirement/ActiveAgent",
  { failure: activeAgentFailure },
) {}
```

Agent-principal refinement: the connected agent must be active.

## Files

- `active-agent.ts`
