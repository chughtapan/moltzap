# server-core/identity/contacts/requirements

_`packages/server/src/identity/contacts/requirements`_

## Purpose

Contact-domain requirement helpers.

## Public surface

### [`CreatorAndTargets`](./reach.ts#L11)

_Interface_

```ts
export interface CreatorAndTargets {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}
```

### [`obtainContactPolicyAllowsReach`](./reach.ts#L16)

_Function_

```ts
export const obtainContactPolicyAllowsReach = (
  input: CreatorAndTargets,
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  AgentNotFoundError | NotInContactsError,
  ConversationServiceTag
>
```

## Files

- `reach.ts`
