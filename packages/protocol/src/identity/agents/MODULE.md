# protocol/identity/agents

_`packages/protocol/src/identity/agents`_

## Purpose

Agent identity descriptors, schemas, and credentials.

## Public surface

### [`Agent`](./types.ts#L52)

_TypeAlias_

```ts
export type Agent = Schema.Schema.Type<typeof AgentSchema>;
```

### [`AgentCard`](./types.ts#L53)

_TypeAlias_

```ts
export type AgentCard = Schema.Schema.Type<typeof AgentCardSchema>;
```

### [`AgentCardSchema`](./types.ts#L45)

_Variable_

```ts
export const AgentCardSchema = AgentSchema.omit("createdAt")
```

### [`AgentId`](./ids.ts#L5)

_TypeAlias_

```ts
export type AgentId = string & Brand.Brand<"AgentId">;
```

### [`AgentId`](./ids.ts#L5)

_Variable_

```ts
export type AgentId = string & Brand.Brand<"AgentId">
```

### [`AgentKey`](./credentials.ts#L20)

_TypeAlias_

```ts
export type AgentKey = Redacted.Redacted<AgentKeyValue>;
```

### [`AgentKey`](./credentials.ts#L20)

_Variable_

```ts
export type AgentKey = Redacted.Redacted<AgentKeyValue>
```

### [`AgentNotFoundError`](./types.ts#L14)

_Class_

```ts
export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFound",
  errorPayloadFields,
) {
  static readonly message = "Agent not found";
}
```

### [`agentOwnershipSchema`](./types.ts#L66)

_Function_

```ts
export function agentOwnershipSchema(): typeof AgentOwnershipSchema
```

### [`AgentsList`](./agents.ts#L10)

_Variable_

```ts
export const AgentsList = defineRpc({
  name: "agent/identity/agents/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    agents: Schema.Array(AgentCardSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [InvalidParamsError],
})
```

### [`InviteCode`](./registration.ts#L16)

_TypeAlias_

```ts
export type InviteCode = Redacted.Redacted<InviteCodeValue>;
```

### [`InviteCode`](./registration.ts#L16)

_Variable_

```ts
export type InviteCode = Redacted.Redacted<InviteCodeValue>
```

### [`Register`](./registration.ts#L20)

_Variable_

```ts
export const Register = defineRpc({
  name: "agent/identity/register",
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

### [`validateAgent`](./types.ts#L63)

_Variable_

```ts
export const validateAgent = closedGuard(AgentSchema)
```

### [`validateAgentCard`](./types.ts#L64)

_Variable_

```ts
export const validateAgentCard = closedGuard(AgentCardSchema)
```

## Files

- `agents.ts`
- `credentials.ts`
- `ids.ts`
- `registration.ts`
- `types.ts`
