# protocol/identity/agents

_`packages/protocol/src/identity/agents`_

## Purpose

Agent identity descriptors, schemas, and credentials.

## Public surface

### [`Agent`](./types.ts#L52)

_TypeAlias_

```ts
export type Agent = Schema.Schema.Type<typeof agentSchema>;
```

Represents agent values.

### [`AgentCard`](./types.ts#L54)

_TypeAlias_

```ts
export type AgentCard = Schema.Schema.Type<typeof agentCardSchema>;
```

Represents agent card values.

### [`agentCardSchema`](./types.ts#L44)

_Variable_

```ts
export const agentCardSchema = agentSchema.omit("createdAt")
```

Validates and decodes agent card values.

### [`agentId`](./ids.ts#L8)

_Variable_

```ts
export const agentId: Schema.Schema<AgentId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("AgentId"),
  Schema.annotations({ description: "Branded AgentId" }),
)
```

Validates and decodes agent id values.

### [`AgentId`](./ids.ts#L6)

_TypeAlias_

```ts
export type AgentId = string & Brand.Brand<"AgentId">;
```

Represents agent id values.

### [`agentKey`](./credentials.ts#L23)

_Variable_

```ts
export const agentKey: Schema.Schema<AgentKey, string> =
  Schema.Redacted(agentKeyValue)
```

Validates and decodes agent key values.

### [`AgentKey`](./credentials.ts#L21)

_TypeAlias_

```ts
export type AgentKey = Redacted.Redacted<AgentKeyValue>;
```

Represents agent key values.

### [`agentName`](./name.ts#L6)

_Variable_

```ts
export const agentName: Schema.Schema<AgentName, string> = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(32),
  Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
  Schema.brand("AgentName"),
  Schema.annotations({
    description:
      "Lowercase wire-safe identity name (3–32 characters, alphanumeric ends)",
  }),
)
```

Validates and decodes agent name values.

### [`AgentName`](./name.ts#L4)

_TypeAlias_

```ts
export type AgentName = string & Brand.Brand<"AgentName">;
```

Wire-safe agent name shared by registration input and agent records.

### [`AgentNotFoundError`](./types.ts#L16)

_Class_

```ts
export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFound",
  errorPayloadFields,
) {
  static readonly message = "Agent not found";
}
```

Reports agent not found failures.

### [`agentOwnershipSchema`](./types.ts#L65)

_Function_

```ts
export function agentOwnershipSchema(): typeof agentOwnershipSchemaValue
```

Executes the agent ownership schema operation.

**Returns:** The agent ownership schema result.

### [`agentsList`](./agents.ts#L35)

_Variable_

```ts
export const agentsList = defineRpc({
  name: "agent/identity/agents/list",
  params: Schema.Struct({
    limit: listLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(agentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [InvalidParamsError],
})
```

Defines the `agent/identity/agents/list` RPC contract.

### [`agentsSearch`](./agents.ts#L20)

_Variable_

```ts
export const agentsSearch = defineRpc({
  name: "agent/identity/agents/search",
  params: Schema.Struct({
    query: Schema.optional(Schema.String),
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(agentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AuthenticatedAgent, ActiveAgent],
  errors: [InvalidParamsError],
})
```

Search agent cards visible to the active agent. The wire contract permits
omitted and blank queries; query interpretation and pagination policy belong
to the handler.

### [`inviteCode`](./registration.ts#L20)

_Variable_

```ts
export const inviteCode: Schema.Schema<InviteCode, string> =
  Schema.Redacted(inviteCodeValue)
```

Validates and decodes invite code values.

### [`InviteCode`](./registration.ts#L18)

_TypeAlias_

```ts
export type InviteCode = Redacted.Redacted<InviteCodeValue>;
```

Represents invite code values.

### [`register`](./registration.ts#L24)

_Variable_

```ts
export const register = defineRpc({
  name: "agent/identity/register",
  params: Schema.Struct({
    name: agentName,
    description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
    inviteCode: Schema.optional(inviteCode),
  }),
  result: Schema.Struct({
    agentId: agentId,
    apiKey: agentKey,
  }),
  requires: [],
  errors: [ConflictError],
})
```

Defines the `agent/identity/register` RPC contract.

### [`validateAgent`](./types.ts#L57)

_Variable_

```ts
export const validateAgent = closedStructGuard(agentSchema)
```

Provides the validate agent runtime value.

### [`validateAgentCard`](./types.ts#L59)

_Variable_

```ts
export const validateAgentCard = closedStructGuard(agentCardSchema)
```

Provides the validate agent card runtime value.

## Files

- `agents.ts`
- `credentials.ts`
- `ids.ts`
- `name.ts`
- `registration.ts`
- `types.ts`
