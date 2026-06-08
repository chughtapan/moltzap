# protocol/identity/requirements

_`packages/protocol/src/identity/requirements`_

## Purpose

Identity-owned refinement requirement tags.

## Public surface

### [`AgentClaimed`](./agent-claimed.ts#L11)

_Class_

```ts
export class AgentClaimed extends RpcMiddleware.Tag<AgentClaimed>()(
  "@moltzap/protocol/requirement/AgentClaimed",
  { failure: agentClaimedFailure },
) {}
```

Refinement requirement: the agent arm must be claimed/active. Type-paired
with `AgentPrincipal`; the server reads the live agent connection status.

## Files

- `agent-claimed.ts`
