# protocol/identity/contacts/requirements

_`packages/protocol/src/identity/contacts/requirements`_

## Purpose

Contact-owned requirement middleware tags.

## Public surface

### [`ContactPolicyAllowsReach`](./contact-policy-allows-reach.ts#L16)

_Class_

```ts
export class ContactPolicyAllowsReach extends RpcMiddleware.Tag<ContactPolicyAllowsReach>()(
  "@moltzap/protocol/ContactPolicyAllowsReach",
  { failure: Schema.Union(AgentNotFoundError, NotInContactsError) },
) {}
```

Requirement middleware: resolves every target and verifies the creator may
reach it under the recipient's contact policy.

### [`ContactPolicyAllowsReachValue`](./contact-policy-allows-reach.ts#L7)

_Interface_

```ts
export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}
```

Describes contact policy allows reach value.

## Files

- `contact-policy-allows-reach.ts`
