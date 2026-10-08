# client/transport/collectives

_`packages/client/src/transport/collectives`_

## Purpose

The collective operations the daemon service composes.

## Public surface

### [`CollectiveError`](./forms.ts#L317)

_Class_

```ts
export class CollectiveError extends Data.TaggedError("CollectiveError")<{
  readonly id: CollectiveId;
  readonly failure: CollectiveFailure;
}> {
  override get message(): string {
    return describeCollectiveFailure(this.failure);
  }
}
```

A gather, all_gather or answer was refused. The message is what a host
hands its model as the tool error: the failed action and its cause, naming
each unreachable member or failing field. The operation id stays in the
error's data, not its message.

### [`groupMembers`](./render.ts#L36)

_Function_

```ts
export function groupMembers(address: MessageAddressInput): readonly string[]
```

The agents a group address names, as `agent:` addresses, in its order; a
direct address names none. Hosts list them on a group turn.

**Returns:** The group's member addresses, or an empty list.

### [`InboundItem`](./inbound.ts#L111)

_TypeAlias_

```ts
export type InboundItem = typeof InboundItem.Type;
```

A validated inbound item.

### [`InboundItem`](./inbound.ts#L102)

_Variable_

```ts
export const InboundItem = Schema.Union(
  multicastItem,
  collectiveRequestItem,
  collectiveResultItem,
  operationFailedItem,
).annotations({
  identifier: "InboundItem",
})
```

One inbound item, discriminated by `kind`. The endpoint consumes the
collective layer's protocol posts, posts whose collective part is malformed
or duplicated, and multicasts that carry nothing besides that part; every
other certified post becomes one item, and the endpoint itself emits
results and failures.

### [`MessageTextError`](./message-text.ts#L50)

_Class_

```ts
export class MessageTextError extends Data.TaggedError("MessageTextError")<{
  readonly operation: StatedOperation;
  readonly detail: string;
}> {
  override get message(): string {
    const action = this.operation === "answer" ? "reply" : "send";
    return `${action} failed: invalid ${this.operation}: ${this.detail}`;
  }
}
```

A message text states an operation it does not validly carry, or is plain
text that is not well-formed Unicode. The message names each failing field
so a host can hand it to its model as the tool error.

### [`parseMessageText`](./message-text.ts#L93)

_Function_

```ts
export const parseMessageText = (
  to: MessageAddressInput,
  text: string,
): Either.Either<SendInput, MessageTextError>
```

Read one message text as the send it states.

**Returns:** The send input, or an error naming each field a stated operation
  gets wrong.

### [`renderCollectiveRequest`](./render.ts#L53)

_Function_

```ts
export function renderCollectiveRequest(
  item: CollectiveRequestItem,
  howToAnswer: string,
): string
```

A question another agent asked: who asked and until when, the question,
its form, and the exact text that answers it. Only the last line differs
by host, since each host's model sends the answer through its own tool.

**Returns:** The text of the model's turn.

### [`renderCollectiveResult`](./render.ts#L75)

_Function_

```ts
export function renderCollectiveResult(item: CollectiveResultItem): string
```

A gather's or all_gather's result: the question and one line per member.

**Returns:** The text of the model's turn.

### [`renderContent`](./render.ts#L22)

_Function_

```ts
export function renderContent(content: Content): string
```

A message's content as the text a model reads: each text part as written,
each data part as JSON, one part per line.

**Returns:** The text a host puts in the model's turn.

### [`SendInput`](./forms.ts#L152)

_TypeAlias_

```ts
export type SendInput = typeof SendInput.Type;
```

Validated input for one send.

### [`SendInput`](./forms.ts#L140)

_Variable_

```ts
export const SendInput = Schema.Union(
  exactStruct({
    to: MessageAddressInput,
    text: wellFormedString,
    collective: Schema.optionalWith(CollectiveOperation, { exact: true }),
  }),
  exactStruct({
    to: MessageAddressInput,
    collectiveResponse: CollectiveResponse,
  }),
).annotations({ identifier: "SendInput" })
```

One send to one address: text with its collective operation, multicast
when `collective` is omitted, or an answer to the request open in that
address's conversation. `parseMessageText` reads both from a message's
text.

### [`SendResult`](./forms.ts#L174)

_Interface_

```ts
export interface SendResult {
  readonly operationId?: CollectiveId;
}
```

What a completed send returns: a collecting operation names its id.

## Files

- `forms.ts`
- `inbound.ts`
- `message-text.ts`
- `render.ts`
