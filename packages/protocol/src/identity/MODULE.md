# protocol/identity

_`packages/protocol/src/identity`_

## Purpose

Public barrel for identity, agent, and contact protocol descriptors.

## Public surface

### [`Agent`](./agents.ts#L79)

_TypeAlias_

```ts
export type Agent = Schema.Schema.Type<typeof AgentSchema>;
```

### [`AgentCard`](./agents.ts#L80)

_TypeAlias_

```ts
export type AgentCard = Schema.Schema.Type<typeof AgentCardSchema>;
```

### [`AgentId`](./agents.ts#L45)

_TypeAlias_

```ts
export const AgentId = brandedId("AgentId");
```

### [`AgentId`](./agents.ts#L45)

_Variable_

```ts
export const AgentId = brandedId("AgentId")
```

### [`AgentNotFoundError`](./agents.ts#L36)

_Class_

```ts
export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFound",
  errorPayloadFields,
) {
  static readonly message = "Agent not found";
}
```

A referenced agent id does not resolve to an agent row. Raised wire-side when
a `participants` / `invitedAgentIds` target names an agent that does not
exist. Client-side name lookups use the same tagged error with a message/data
payload describing the missing name.

### [`agentOwnershipSchema`](./agents.ts#L98)

_Function_

```ts
export function agentOwnershipSchema(): typeof AgentOwnershipSchema
```

### [`AgentsList`](./agents.ts#L188)

_Variable_

```ts
export const AgentsList = defineRpc({
  name: "agents/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(AgentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal, AgentClaimed],
  errors: [InvalidParamsError],
})
```

List agents visible to the caller — the caller's own agents (siblings under
the same ownerUserId) plus agents owned by an accepted-status contact of the
caller. Unclaimed callers see only themselves.

- **Principal:** `AgentPrincipal` head + `AgentClaimed` (claimed/active agent).

### [`AgentsLookup`](./agents.ts#L142)

_Variable_

```ts
export const AgentsLookup = defineRpc({
  name: "agents/lookup",
  params: Schema.Struct({
    agentIds: Schema.Array(AgentId).pipe(
      Schema.minItems(1),
      Schema.maxItems(100),
    ),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
  requires: [AgentPrincipal],
  errors: [],
})
```

Look up agents by their UUIDs. Returns agent cards for found agents.

- **Principal:** `AgentPrincipal` head (no claimed refinement).

### [`AgentsLookupByName`](./agents.ts#L164)

_Variable_

```ts
export const AgentsLookupByName = defineRpc({
  name: "agents/lookupByName",
  params: Schema.Struct({
    names: Schema.Array(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)),
    ).pipe(Schema.minItems(1), Schema.maxItems(100)),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
  requires: [AgentPrincipal],
  errors: [],
})
```

Look up agents by their short names.

- **Principal:** `AgentPrincipal` head (no claimed refinement).

### [`Contact`](./contacts.ts#L65)

_TypeAlias_

```ts
export type Contact = Schema.Schema.Type<typeof ContactSchema>;
```

### [`ContactAcceptedNotificationDefinition`](./contacts.ts#L177)

_Variable_

```ts
export const ContactAcceptedNotificationDefinition = defineNotification({
  name: "contact/accepted",
  params: ContactAcceptedNotificationSchema,
})
```

Pushed when a contact request is accepted.

### [`ContactId`](./contacts.ts#L30)

_TypeAlias_

```ts
export const ContactId = brandedId("ContactId");
```

### [`ContactId`](./contacts.ts#L30)

_Variable_

```ts
export const ContactId = brandedId("ContactId")
```

### [`ContactNotFoundError`](./contacts.ts#L41)

_Class_

```ts
export class ContactNotFoundError extends Schema.TaggedError<ContactNotFoundError>()(
  "ContactNotFound",
  errorPayloadFields,
) {
  static readonly message = "Contact not found";
}
```

The referenced contact does not exist (or is not the caller's).

### [`ContactRequestNotificationDefinition`](./contacts.ts#L169)

_Variable_

```ts
export const ContactRequestNotificationDefinition = defineNotification({
  name: "contact/request",
  params: ContactRequestNotificationSchema,
})
```

Pushed when an agent receives a contact request.

### [`ContactsAccept`](./contacts.ts#L127)

_Variable_

```ts
export const ContactsAccept = defineRpc({
  name: "contacts/accept",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, ForbiddenError, UnauthorizedError],
})
```

Accept a pending contact request.

- **Principal:** `AgentPrincipal` head (no claimed refinement).

### [`ContactsAdd`](./contacts.ts#L104)

_Variable_

```ts
export const ContactsAdd = defineRpc({
  name: "contacts/add",
  params: Schema.Struct({
    contactUserId: UserId,
    relationship: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ForbiddenError, ConflictError, UnauthorizedError],
})
```

Create a contact request.

- **Principal:** `AgentPrincipal` head (no claimed refinement).

### [`ContactsById`](./contacts.ts#L146)

_Variable_

```ts
export const ContactsById = defineRpc({
  name: "contacts/byId",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, UnauthorizedError],
})
```

Look up a contact by its identifier.

- **Principal:** `AgentPrincipal` head (no claimed refinement).

### [`ContactsList`](./contacts.ts#L78)

_Variable_

```ts
export const ContactsList = defineRpc({
  name: "contacts/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    contacts: Schema.Array(ContactSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal],
  errors: [InvalidParamsError, UnauthorizedError],
})
```

List contacts for the authenticated agent.

- **Principal:** `AgentPrincipal` head (no claimed refinement).

### [`identityNotifications`](./methods.ts#L51)

_Variable_

```ts
export const identityNotifications = [
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
] as const
```

### [`identityRpcMethods`](./methods.ts#L41)

_Variable_

```ts
export const identityRpcMethods = [
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
] as const
```

### [`NotInContactsError`](./contacts.ts#L33)

_Class_

```ts
export class NotInContactsError extends Schema.TaggedError<NotInContactsError>()(
  "NotInContacts",
  errorPayloadFields,
) {
  static readonly message = "Recipient blocks unsolicited contacts";
}
```

### [`Register`](./agents.ts#L116)

_Variable_

```ts
export const Register = defineRpc({
  name: "agents/register",
  params: Schema.Struct({
    name: Schema.String.pipe(
      Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
    ),
    description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
    inviteCode: Schema.optional(InviteCode),
  }),
  result: Schema.Struct({
    agentId: AgentId,
    apiKey: AgentKey,
  }),
  requires: [],
  errors: [ConflictError],
})
```

Register a new agent and receive an API key.

**Returns:** Agent ID and API key.

### [`UserId`](./agents.ts#L43)

_TypeAlias_

```ts
export const UserId = brandedId("UserId");
```

### [`UserId`](./agents.ts#L43)

_Variable_

```ts
export const UserId = brandedId("UserId")
```

### [`validateAgent`](./agents.ts#L95)

_Variable_

```ts
export const validateAgent = closedGuard(AgentSchema)
```

### [`validateAgentCard`](./agents.ts#L96)

_Variable_

```ts
export const validateAgentCard = closedGuard(AgentCardSchema)
```

## Files

- `agents.ts`
- `contacts.ts`
- `methods.ts`
