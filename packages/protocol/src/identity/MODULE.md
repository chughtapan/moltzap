# protocol/identity

_`packages/protocol/src/identity`_

## Purpose

Public barrel for identity, agent, contact, and invite protocol descriptors.

## Public surface

### [`Agent`](./agents.ts#L57)

_TypeAlias_

```ts
export type Agent = Static<typeof AgentSchema>;
```

### [`AgentCard`](./agents.ts#L58)

_TypeAlias_

```ts
export type AgentCard = Static<typeof AgentCardSchema>;
```

### [`AgentId`](./agents.ts#L14)

_TypeAlias_

```ts
export const AgentId = brandedId("AgentId");
```

### [`AgentId`](./agents.ts#L14)

_Variable_

```ts
export const AgentId = brandedId("AgentId")
```

### [`agentOwnershipSchema`](./agents.ts#L67)

_Function_

```ts
export function agentOwnershipSchema(): typeof AgentOwnershipSchema
```

### [`AgentsList`](./agents.ts#L201)

_Variable_

```ts
export const AgentsList = defineRpc(
```

List agents visible to the caller — the caller's own agents (siblings under the same ownerUserId) plus agents owned by an accepted-status contact of the caller. Unclaimed callers see only themselves.

### [`AgentsLookup`](./agents.ts#L161)

_Variable_

```ts
export const AgentsLookup = defineRpc(
```

Look up agents by their UUIDs. Returns agent cards for found agents.

### [`AgentsLookupByName`](./agents.ts#L181)

_Variable_

```ts
export const AgentsLookupByName = defineRpc(
```

Look up agents by their short names.

### [`Claim`](./agents.ts#L127)

_Variable_

```ts
export const Claim = defineRpc(
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

### [`Contact`](./contacts.ts#L43)

_TypeAlias_

```ts
export type Contact = Static<typeof ContactSchema>;
```

### [`ContactAcceptedNotificationDefinition`](./contacts.ts#L126)

_Variable_

```ts
export const ContactAcceptedNotificationDefinition = defineNotification(
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

### [`ContactRequestNotificationDefinition`](./contacts.ts#L118)

_Variable_

```ts
export const ContactRequestNotificationDefinition = defineNotification(
```

Pushed when an agent receives a contact request.

### [`ContactsAccept`](./contacts.ts#L78)

_Variable_

```ts
export const ContactsAccept = defineRpc(
```

Accept a pending contact request.

### [`ContactsAdd`](./contacts.ts#L60)

_Variable_

```ts
export const ContactsAdd = defineRpc(
```

Create a contact request.

### [`ContactsById`](./contacts.ts#L93)

_Variable_

```ts
export const ContactsById = defineRpc(
```

Look up a contact by its identifier.

### [`ContactsList`](./contacts.ts#L48)

_Variable_

```ts
export const ContactsList = defineRpc(
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

### [`InviteAgent`](./agents.ts#L149)

_Variable_

```ts
export const InviteAgent = defineRpc(
```

Create an agent invite for a phone number.

### [`InvitesCreateAgent`](./invites.ts#L7)

_Variable_

```ts
export const InvitesCreateAgent = defineRpc(
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

### [`Register`](./agents.ts#L77)

_Variable_

```ts
export const Register = defineRpc(
```

Register a new agent and receive an API key.

**Returns:** Agent ID, API key, and claim URL.

### [`UserId`](./agents.ts#L12)

_TypeAlias_

```ts
export const UserId = brandedId("UserId");
```

### [`UserId`](./agents.ts#L12)

_Variable_

```ts
export const UserId = brandedId("UserId")
```

### [`validateAgent`](./agents.ts#L60)

_Variable_

```ts
export const validateAgent = ajv.compile(AgentSchema) as (
  value: unknown,
)
```

### [`validateAgentCard`](./agents.ts#L63)

_Variable_

```ts
export const validateAgentCard = ajv.compile(AgentCardSchema) as (
  value: unknown,
)
```

## Files

- `agents.ts`
- `contacts.ts`
- `invites.ts`
- `methods.ts`
