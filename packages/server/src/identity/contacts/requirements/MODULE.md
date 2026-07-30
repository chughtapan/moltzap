# server-core/identity/contacts/requirements

_`packages/server/src/identity/contacts/requirements`_

## Purpose

Contact-domain requirement helpers.

## Public surface

### [`CreatorAndTargets`](./reach.ts#L12)

_Interface_

```ts
export interface CreatorAndTargets {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}
```

Describes creator and targets.

### [`obtainContactPolicyAllowsReach`](./reach.ts#L22)

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

Provides the obtain contact policy allows reach runtime value.

**Returns:** The obtain contact policy allows reach result.

## Files

- `reach.ts`
