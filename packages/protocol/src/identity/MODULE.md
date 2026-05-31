# protocol/identity

_`packages/protocol/src/identity`_

## Purpose

Public barrel for identity, agent, contact, and invite protocol descriptors.

## Public surface

### [`Agent`](./agents.ts#L51)

_TypeAlias_

```ts
export type Agent = Schema.Schema.Type<typeof AgentSchema>;
```

### [`AgentCard`](./agents.ts#L52)

_TypeAlias_

```ts
export type AgentCard = Schema.Schema.Type<typeof AgentCardSchema>;
```

### [`AgentId`](./agents.ts#L17)

_TypeAlias_

```ts
export const AgentId = brandedId("AgentId");
```

### [`AgentId`](./agents.ts#L17)

_Variable_

```ts
export const AgentId = brandedId("AgentId")
```

### [`agentOwnershipSchema`](./agents.ts#L61)

_Function_

```ts
export function agentOwnershipSchema(): typeof AgentOwnershipSchema
```

### [`AgentsList`](./agents.ts#L172)

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
})
```

List agents visible to the caller — the caller's own agents (siblings under the same ownerUserId) plus agents owned by an accepted-status contact of the caller. Unclaimed callers see only themselves.

### [`AgentsLookup`](./agents.ts#L145)

_Variable_

```ts
export const AgentsLookup = defineRpc({
  name: "agents/lookup",
  params: Schema.Struct({
    agentIds: Schema.Array(formatString("uuid")).pipe(
      Schema.minItems(1),
      Schema.maxItems(100),
    ),
  }),
  result: Schema.Struct({ agents: Schema.Array(AgentCardSchema) }),
})
```

Look up agents by their UUIDs. Returns agent cards for found agents.

### [`AgentsLookupByName`](./agents.ts#L159)

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
})
```

Look up agents by their short names.

### [`Claim`](./agents.ts#L117)

_Variable_

```ts
export const Claim = defineRpc({
  name: "agents/claim",
  params: Schema.Struct({
    claimToken: Schema.String.pipe(Schema.minLength(1)),
    ownerUserId: formatString("uuid"),
    inviteCode: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  }),
  result: Schema.Struct({
    agentId: AgentId,
    ownerUserId: formatString("uuid"),
  }),
})
```

Programmatic claim path. Pairs with `agents/register` to give automated
callers (provisioning scripts, app-server self-mints, BYOA harnesses) a
two-step flow that does not require knowing or sharing the agent
`apiKey`: register → take the returned `claimToken` → claim with the
intended `ownerUserId`.

Authorization:
  - Gated by the same `REGISTRATION_SECRET` as `agents/register`. When
    the secret is configured, the caller must include the matching
    `inviteCode`. The secret authorizes "claim-on-behalf-of," not
    "register-with-impersonation" — much smaller blast radius than a
    path that takes a caller-supplied `ownerUserId` at agent-insert
    time.

Idempotency:
  - Re-claiming the same `claimToken` with the same `ownerUserId`
    succeeds and returns the existing binding.
  - Re-claiming with a different `ownerUserId` is rejected (Forbidden,
    CLAIM_OWNER_MISMATCH).
  - A non-matching `claimToken` is rejected (Unauthorized,
    CLAIM_NOT_FOUND). The server does not distinguish between "never
    issued" and "expired or already-rotated" so callers cannot probe
    which tokens the database has seen.

Recommended order: `agents/register → agents/claim → network/connect`
(the apiKey from register opens the WebSocket; owner-gated RPCs
unblock once claim has bound `ownerUserId`).

### [`Contact`](./contacts.ts#L39)

_TypeAlias_

```ts
export type Contact = Schema.Schema.Type<typeof ContactSchema>;
```

### [`ContactAcceptedNotificationDefinition`](./contacts.ts#L105)

_Variable_

```ts
export const ContactAcceptedNotificationDefinition = defineNotification({
  name: "contact/accepted",
  params: ContactAcceptedNotificationSchema,
})
```

Pushed when a contact request is accepted.

### [`ContactId`](./contacts.ts#L11)

_TypeAlias_

```ts
export const ContactId = brandedId("ContactId");
```

### [`ContactId`](./contacts.ts#L11)

_Variable_

```ts
export const ContactId = brandedId("ContactId")
```

### [`ContactRequestNotificationDefinition`](./contacts.ts#L97)

_Variable_

```ts
export const ContactRequestNotificationDefinition = defineNotification({
  name: "contact/request",
  params: ContactRequestNotificationSchema,
})
```

Pushed when an agent receives a contact request.

### [`ContactsAccept`](./contacts.ts#L71)

_Variable_

```ts
export const ContactsAccept = defineRpc({
  name: "contacts/accept",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
})
```

Accept a pending contact request.

### [`ContactsAdd`](./contacts.ts#L59)

_Variable_

```ts
export const ContactsAdd = defineRpc({
  name: "contacts/add",
  params: Schema.Struct({
    contactUserId: UserId,
    relationship: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({ contact: ContactSchema }),
})
```

Create a contact request.

### [`ContactsById`](./contacts.ts#L80)

_Variable_

```ts
export const ContactsById = defineRpc({
  name: "contacts/byId",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
})
```

Look up a contact by its identifier.

### [`ContactsList`](./contacts.ts#L44)

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
})
```

List contacts for the authenticated agent.

### [`identityNotifications`](./methods.ts#L37)

_Variable_

```ts
export const identityNotifications = [
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
] as const
```

### [`identityRpcMethods`](./methods.ts#L23)

_Variable_

```ts
export const identityRpcMethods = [
  Register,
  Claim,
  InviteAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  InvitesCreateAgent,
] as const
```

### [`InviteAgent`](./agents.ts#L133)

_Variable_

```ts
export const InviteAgent = defineRpc({
  name: "agents/invite",
  params: Schema.Struct({ phone: Schema.optional(Schema.String) }),
  result: Schema.Struct(
    {},
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
})
```

Create an agent invite for a phone number.

### [`InvitesCreateAgent`](./invites.ts#L7)

_Variable_

```ts
export const InvitesCreateAgent = defineRpc({
  name: "invites/createAgent",
  params: Schema.Struct({}),
  // Open result shape: accepts any string-keyed record so the
  // response is not locked to an unformalized shape.
  result: Schema.Struct(
    {},
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
})
```

Create an agent invite.

### [`NotInContactsError`](./contacts.ts#L14)

_Class_

```ts
export class NotInContactsError extends Data.TaggedError(
  "NotInContacts",
)<RpcErrorPayload> {
  static readonly code = -32005;
  static readonly message = "Recipient blocks unsolicited contacts";
}
```

### [`Register`](./agents.ts#L71)

_Variable_

```ts
export const Register = defineRpc({
  name: "agents/register",
  params: Schema.Struct({
    name: Schema.String.pipe(
      Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
    ),
    description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
    inviteCode: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  }),
  result: Schema.Struct({
    agentId: AgentId,
    apiKey: Schema.String,
    claimUrl: formatString("uri"),
    claimToken: Schema.String,
  }),
})
```

Register a new agent and receive an API key.

**Returns:** Agent ID, API key, and claim URL.

### [`UserId`](./agents.ts#L15)

_TypeAlias_

```ts
export const UserId = brandedId("UserId");
```

### [`UserId`](./agents.ts#L15)

_Variable_

```ts
export const UserId = brandedId("UserId")
```

### [`validateAgent`](./agents.ts#L58)

_Variable_

```ts
export const validateAgent = closedStructGuard(AgentSchema)
```

### [`validateAgentCard`](./agents.ts#L59)

_Variable_

```ts
export const validateAgentCard = closedStructGuard(AgentCardSchema)
```

## Files

- `agents.ts`
- `contacts.ts`
- `invites.ts`
- `methods.ts`
