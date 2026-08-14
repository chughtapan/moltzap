# client/src

_`packages/client/src`_

## Purpose

Public barrel for the final endpoint runtime capability.

## Public surface

### [`acquireHarnessClient`](./client-runtime.ts#L307)

_Function_

```ts
export const acquireHarnessClient = (
  endpoint: URL,
): Effect.Effect<HarnessClient, ConnectError, Scope.Scope>
```

Acquire one real MCP-backed client and its sole inbound subscription.

**Returns:** A client whose resources remain live for the caller's scope.

### [`AgentName`](./../../identity/dist/identifiers.d.ts#L31)

_TypeAlias_

```ts
export type AgentName = typeof AgentName.Type;
```

Validated nominal value decoded by AgentName.

### [`AgentName`](./../../identity/dist/identifiers.d.ts#L29)

_Variable_

```ts
export declare const AgentName: Schema.brand<Schema.filter<Schema.filter<Schema.filter<typeof Schema.String>>>, "AgentName">
```

Immutable Registry-wide human-facing agent handle.

### [`ConnectError`](./contract.ts#L47)

_Class_

```ts
export class ConnectError extends Data.TaggedError("ConnectError") {}
```

Acquiring the endpoint connection or its sole subscription failed.

### [`Content`](./contract.ts#L25)

_TypeAlias_

```ts
export type Content = readonly [ContentPart, ...ContentPart[]];
```

Nonempty semantic content for one conversation action.

### [`ContentPart`](./contract.ts#L20)

_TypeAlias_

```ts
export type ContentPart =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "data"; value: JsonValue }>;
```

One semantic part of a conversation action.

### [`ConversationId`](./contract.ts#L37)

_TypeAlias_

```ts
export type ConversationId = typeof ConversationId.Type;
```

Validated conversation identity.

### [`ConversationId`](./contract.ts#L28)

_Variable_

```ts
export const ConversationId = Schema.UUID.pipe(
  Schema.brand("ConversationId"),
  Schema.annotations({
    identifier: "ConversationId",
    description: "Caller-minted conversation identity",
  }),
)
```

Caller-retained identity for one conversation and its START retries.

### [`ConversationIdGenerationError`](./contract.ts#L42)

_Class_

```ts
export class ConversationIdGenerationError extends Data.TaggedError(
  "ConversationIdGenerationError",
) {}
```

Creating a conversation identity failed.

### [`createConversationId`](./contract.ts#L111)

_Function_

```ts
export const createConversationId = (): Effect.Effect<
  ConversationId,
  ConversationIdGenerationError
>
```

Mint a ConversationId before any START network work begins.

**Returns:** The newly minted caller-retained identity.

### [`HarnessClient`](./contract.ts#L99)

_Interface_

```ts
export interface HarnessClient {
  readonly start: (input: StartInput) => Effect.Effect<void, StartError>;
  readonly turns: Stream.Stream<HarnessTurn, ListenError>;
}
```

Structural runtime capability owned by one scoped endpoint connection.

### [`HarnessTurn`](./contract.ts#L90)

_Interface_

```ts
export interface HarnessTurn {
  readonly conversationId: ConversationId;
  readonly peers: readonly [VerifiedAgentCard, ...VerifiedAgentCard[]];
  readonly author: VerifiedAgentCard;
  readonly content: Content;
  readonly reply: (content: Content) => Effect.Effect<void, ReplyError>;
}
```

One certified current-conversation action with live reply authority.

### [`JsonValue`](./contract.ts#L10)

_TypeAlias_

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
```

A value accepted by the closed semantic content boundary.

### [`ListenError`](./contract.ts#L66)

_Class_

```ts
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly reason: ListenFailure;
}> {}
```

Closed failure from the endpoint's sole inbound stream.

### [`ReplyError`](./contract.ts#L78)

_Class_

```ts
export class ReplyError extends Data.TaggedError("ReplyError")<{
  readonly reason: ReplyFailure;
}> {}
```

Closed failure from one turn-bound reply.

### [`StartError`](./contract.ts#L59)

_Class_

```ts
export class StartError extends Data.TaggedError("StartError")<{
  readonly reason: StartFailure;
}> {}
```

Closed failure from one START operation.

### [`StartInput`](./contract.ts#L83)

_Interface_

```ts
export interface StartInput {
  readonly conversationId: ConversationId;
  readonly peers: readonly [AgentName, ...AgentName[]];
  readonly content: Content;
}
```

Complete semantic input for a new conversation.

### [`VerifiedAgentCard`](./../../identity/dist/agent-card.d.ts#L22)

_TypeAlias_

```ts
export type VerifiedAgentCard = AgentCard & Brand.Brand<"VerifiedAgentCard">;
```

AgentCard verified against a deployment-pinned Registry signer.

## Files

- `client-runtime.ts`
- `contract.ts`
