# protocol/identity/agents

_`packages/protocol/src/identity/agents`_

## Purpose

Agent identity descriptors, schemas, and credentials.

## Public surface

### [`Agent`](./types.ts#L55)

_TypeAlias_

```ts
export type Agent = Schema.Schema.Type<typeof agentSchema>;
```

Represents agent values.

### [`AgentCard`](./types.ts#L57)

_TypeAlias_

```ts
export type AgentCard = Schema.Schema.Type<typeof agentCardSchema>;
```

Represents agent card values.

### [`agentCardSchema`](./types.ts#L47)

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

### [`AgentNotFoundError`](./types.ts#L15)

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

### [`agentOwnershipSchema`](./types.ts#L68)

_Function_

```ts
export function agentOwnershipSchema(): typeof agentOwnershipSchemaValue
```

Executes the agent ownership schema operation.

**Returns:** The agent ownership schema result.

### [`agentsList`](./agents.ts#L14)

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
  requires: [AgentPrincipal, ActiveAgent],
  errors: [InvalidParamsError],
})
```

Defines the `agent/identity/agents/list` RPC contract.

### [`inviteCode`](./registration.ts#L19)

_Variable_

```ts
export const inviteCode: Schema.Schema<InviteCode, string> =
  Schema.Redacted(inviteCodeValue)
```

Validates and decodes invite code values.

### [`InviteCode`](./registration.ts#L17)

_TypeAlias_

```ts
export type InviteCode = Redacted.Redacted<InviteCodeValue>;
```

Represents invite code values.

### [`register`](./registration.ts#L23)

_Variable_

```ts
export const register = defineRpc({
  name: "agent/identity/register",
  params: Schema.Struct({
    name: Schema.String.pipe(
      Schema.pattern(new RegExp("^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$")),
    ),
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

### [`validateAgent`](./types.ts#L60)

_Variable_

```ts
export const validateAgent = closedStructGuard(agentSchema)
```

Provides the validate agent runtime value.

### [`validateAgentCard`](./types.ts#L62)

_Variable_

```ts
export const validateAgentCard = closedStructGuard(agentCardSchema)
```

Provides the validate agent card runtime value.

## Files

- `agents.ts`
- `credentials.ts`
- `ids.ts`
- `registration.ts`
- `types.ts`
