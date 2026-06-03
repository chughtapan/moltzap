# protocol/identity

_`packages/protocol/src/identity`_

## Purpose

Public barrel for identity, agent, and contact protocol descriptors.

## Public surface

### [`Agent`](./agents.ts#L85)

_TypeAlias_

```ts
export type Agent = Schema.Schema.Type<typeof AgentSchema>;
```

### [`AgentCard`](./agents.ts#L86)

_TypeAlias_

```ts
export type AgentCard = Schema.Schema.Type<typeof AgentCardSchema>;
```

### [`AgentId`](./agents.ts#L51)

_TypeAlias_

```ts
export const AgentId = brandedId("AgentId");
```

### [`AgentId`](./agents.ts#L51)

_Variable_

```ts
export const AgentId = brandedId("AgentId")
```

### [`AgentNotFoundError`](./agents.ts#L42)

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
exist. Distinct from the client SDK's `AgentNotFoundError` (a name→agent
lookup miss that never crosses the wire).

### [`agentOwnershipSchema`](./agents.ts#L104)

_Function_

```ts
export function agentOwnershipSchema(): typeof AgentOwnershipSchema
```

### [`AgentsList`](./agents.ts#L246)

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

### [`AgentsLookup`](./agents.ts#L200)

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
  requires: [AgentPrincipal],
  errors: [],
})
```

Look up agents by their UUIDs. Returns agent cards for found agents.

- **Principal:** `AgentPrincipal` head (no claimed refinement).

### [`AgentsLookupByName`](./agents.ts#L222)

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

### [`Claim`](./agents.ts#L176)

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
  requires: [],
  errors: [UnauthorizedError, ForbiddenError],
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

HTTP-only (see `agents/register`): no principal requirement.

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

### [`identityNotifications`](./methods.ts#L28)

_Variable_

```ts
export const identityNotifications = [
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
] as const
```

### [`identityRpcMethods`](./methods.ts#L18)

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

### [`Register`](./agents.ts#L122)

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
  requires: [],
  errors: [ConflictError],
})
```

Register a new agent and receive an API key.

**Returns:** Agent ID, API key, and claim URL.

### [`UserId`](./agents.ts#L49)

_TypeAlias_

```ts
export const UserId = brandedId("UserId");
```

### [`UserId`](./agents.ts#L49)

_Variable_

```ts
export const UserId = brandedId("UserId")
```

### [`validateAgent`](./agents.ts#L101)

_Variable_

```ts
export const validateAgent = closedGuard(AgentSchema)
```

### [`validateAgentCard`](./agents.ts#L102)

_Variable_

```ts
export const validateAgentCard = closedGuard(AgentCardSchema)
```

## Files

- `agents.ts`
- `contacts.ts`
- `methods.ts`
