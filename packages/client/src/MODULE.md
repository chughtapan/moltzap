# client/src

_`packages/client/src`_

## Purpose

Public barrel for the final endpoint runtime capability.

## Public surface

### [`acquireHarnessEndpoint`](./endpoint/harness-endpoint/index.ts#L57)

_Function_

```ts
export function acquireHarnessEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope>
```

Acquire one real MCP-backed endpoint and its scoped connection.

**Returns:** An endpoint whose resources remain live for the caller's scope.

### [`AgentAddress (type)`](./transport/wire/values.ts#L242)

_TypeAlias_

```ts
export type AgentAddress = typeof AgentAddress.Type;
```

A validated direct destination.

### [`AgentAddress (value)`](./transport/wire/values.ts#L236)

_Variable_

```ts
export const AgentAddress = addressInput.pipe(
  Schema.filter((value) => parseAgentAddress(value) !== undefined),
  Schema.brand("AgentAddress"),
  Schema.annotations({ identifier: "AgentAddress" }),
)
```

An explicit direct destination using one canonical Registry name.

### [`CollectiveError`](./transport/collectives/forms.ts#L265)

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

### [`ConnectError`](./endpoint/harness-endpoint/capability.ts#L23)

_Class_

```ts
export class ConnectError extends Data.TaggedError("ConnectError")<{
  readonly reason: ConnectFailure;
}> {
  override get message(): string {
    return `connect failed: ${this.reason}`;
  }
}
```

Acquiring the endpoint connection failed.

### [`Content (type)`](./transport/wire/values.ts#L104)

_TypeAlias_

```ts
export type Content = typeof Content.Type;
```

Validated nonempty semantic content.

### [`Content (value)`](./transport/wire/values.ts#L99)

_Variable_

```ts
export const Content = contentStructure.pipe(
  Schema.filter(contentFits),
  Schema.annotations({ identifier: "Content" }),
)
```

Nonempty semantic content whose canonical JSON is at most 32,768 bytes.

### [`ContentPart (type)`](./transport/wire/values.ts#L94)

_TypeAlias_

```ts
export type ContentPart = typeof ContentPart.Type;
```

A validated semantic message part.

### [`ContentPart (value)`](./transport/wire/values.ts#L89)

_Variable_

```ts
export const ContentPart = Schema.Union(
  exactStruct({ type: Schema.Literal("text"), text: wellFormedString }),
  exactStruct({ type: Schema.Literal("data"), value: JsonValue }),
).annotations({ identifier: "ContentPart" })
```

One exact semantic part of a message.

### [`DeliveryAcknowledgeError`](./transport/messaging/errors.ts#L88)

_Class_

```ts
export class DeliveryAcknowledgeError extends Data.TaggedError(
  "DeliveryAcknowledgeError",
)<{
  readonly reason: DeliveryAcknowledgeFailure;
}> {
  override get message(): string {
    return `delivery acknowledgment failed: ${this.reason}`;
  }
}
```

Transport acknowledgment could not complete for one delivery.

### [`DirectMessage`](./transport/messaging/message.ts#L68)

_TypeAlias_

```ts
export type DirectMessage = typeof directMessage.Type;
```

One certified remote-authored direct message.

### [`GroupAddress (type)`](./transport/wire/values.ts#L251)

_TypeAlias_

```ts
export type GroupAddress = typeof GroupAddress.Type;
```

A validated canonical complete group destination.

### [`GroupAddress (value)`](./transport/wire/values.ts#L245)

_Variable_

```ts
export const GroupAddress = addressInput.pipe(
  Schema.filter(isCanonicalGroupAddress),
  Schema.brand("GroupAddress"),
  Schema.annotations({ identifier: "GroupAddress" }),
)
```

A complete fixed-member group address in unsigned ASCII name order.

### [`GroupMessage`](./transport/messaging/message.ts#L70)

_TypeAlias_

```ts
export type GroupMessage = typeof groupMessage.Type;
```

One certified remote-authored fixed-group message.

### [`HarnessEndpoint`](./endpoint/harness-endpoint/capability.ts#L47)

_Interface_

```ts
export interface HarnessEndpoint {
  readonly send: (
    input: SendInput,
    options?: Readonly<{
      failureDelivery?: FailureDelivery;
      idempotencyKey?: string;
    }>,
  ) => Effect.Effect<SendResult, SendError | CollectiveError>;
  readonly messages: Stream.Stream<InboundDelivery, ListenError>;
}
```

Structural runtime capability owned by one scoped endpoint connection.
Every send is one operation or one collective response; the stream yields
inbound items.

A host whose tool returns before the send completes passes
`failureDelivery: "inbound"`: a refused gather, all_gather or response
then completes and its error arrives as an `operationFailed` item on the
stream. A multicast has no operation id, so its failure is always returned.

### [`HistoryExportRecord (type)`](./delivery/history-export.ts#L50)

_TypeAlias_

```ts
export type HistoryExportRecord = typeof HistoryExportRecord.Type;
```

A validated line of the daemon's history export.

### [`HistoryExportRecord (value)`](./delivery/history-export.ts#L31)

_Variable_

```ts
export const HistoryExportRecord = Schema.Union(
  exactStruct({
    kind: Schema.Literal("inbound"),
    item: InboundItem,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("outbound"),
    input: SendInput,
    outcome: historyExportSendOutcome,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("export-failed"),
    reason: Schema.String,
    at: Schema.DateTimeUtc,
  }),
).annotations({ identifier: "HistoryExportRecord" })
```

One line of the daemon's optional history export: an item as the daemon
published it, a completed `send` invocation with its input and outcome, or
the one line that says the export stopped. Readers decode the file line by
line with this schema rather than copying its shape.

### [`InboundDelivery`](./endpoint/harness-endpoint/capability.ts#L32)

_Interface_

```ts
export interface InboundDelivery {
  readonly item: InboundItem;
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}
```

One inbound item plus its transport-only acknowledgment.

### [`InboundItem (type)`](./transport/collectives/inbound.ts#L108)

_TypeAlias_

```ts
export type InboundItem = typeof InboundItem.Type;
```

A validated inbound item.

### [`InboundItem (value)`](./transport/collectives/inbound.ts#L99)

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

### [`InboundMessage (type)`](./transport/messaging/message.ts#L78)

_TypeAlias_

```ts
export type InboundMessage = typeof InboundMessage.Type;
```

A validated direct or group post.

### [`InboundMessage (value)`](./transport/messaging/message.ts#L73)

_Variable_

```ts
export const InboundMessage = Schema.Union(
  directMessage,
  groupMessage,
).annotations({ identifier: "InboundMessage" })
```

One certified remote-authored post, direct or to a fixed group.

### [`JsonValue (type)`](./transport/wire/values.ts#L67)

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

### [`JsonValue (value)`](./transport/wire/values.ts#L77)

_Variable_

```ts
export const JsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.JsonNumber,
    wellFormedString,
    Schema.Array(JsonValue),
    Schema.Record({ key: wellFormedString, value: JsonValue }),
  ),
).annotations({ identifier: "JsonValue" })
```

Runtime validation for the closed recursive JSON value.

### [`ListenError`](./transport/messaging/errors.ts#L67)

_Class_

```ts
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly reason: ListenFailure;
}> {
  override get message(): string {
    return `listen failed: ${this.reason}`;
  }
}
```

The endpoint's sole inbound subscription failed.

### [`MessageAddressInput (type)`](./transport/wire/values.ts#L256)

_TypeAlias_

```ts
export type MessageAddressInput = typeof MessageAddressInput.Type;
```

A validated explicit destination input.

### [`MessageAddressInput (value)`](./transport/wire/values.ts#L254)

_Variable_

```ts
export const MessageAddressInput = addressInput
```

Either accepted destination input, including noncanonical group order.

### [`MessageTextError`](./transport/collectives/message-text.ts#L43)

_Class_

```ts
export class MessageTextError extends Data.TaggedError("MessageTextError")<{
  readonly operation: StatedOperation;
  readonly detail: string;
}> {
  override get message(): string {
    return `${this.operation} not sent: ${this.detail}`;
  }
}
```

A message text states an operation it does not validly carry, or is plain
text that is not well-formed Unicode. The message names each failing field
so a host can hand it to its model as the tool error.

### [`parseMessageText`](./transport/collectives/message-text.ts#L95)

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

### [`PostId (type)`](./transport/wire/values.ts#L56)

_TypeAlias_

```ts
export type PostId = typeof PostId.Type;
```

A validated author-scoped post identity.

### [`PostId (value)`](./transport/wire/values.ts#L47)

_Variable_

```ts
export const PostId = Schema.String.pipe(
  Schema.filter((value) => isCanonicalIdentifier("pst_", value), {
    identifier: "PostId",
    description: "Canonical author-scoped post identity",
  }),
  Schema.brand("PostId"),
  Schema.annotations({ identifier: "PostId" }),
)
```

Opaque identity minted for one addressed-send invocation.

### [`SendError`](./transport/messaging/errors.ts#L51)

_Class_

```ts
export class SendError extends Data.TaggedError("SendError")<{
  readonly reason: SendFailure;
  readonly detail?: string;
}> {
  override get message(): string {
    return `send failed: ${this.detail ?? sendFailureText[this.reason]}`;
  }
}
```

An addressed send failed before local certification completed. `detail`
names the specific cause when the failing step knows it, such as which
agent is unknown; the message is what a host hands its model.

### [`SendInput (type)`](./transport/collectives/forms.ts#L145)

_TypeAlias_

```ts
export type SendInput = typeof SendInput.Type;
```

Validated input for one send.

### [`SendInput (value)`](./transport/collectives/forms.ts#L133)

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

### [`SendResult`](./transport/collectives/forms.ts#L163)

_Interface_

```ts
export interface SendResult {
  readonly operationId?: CollectiveId;
}
```

What a completed send returns: a collecting operation names its id.

## Package subpaths

### `@moltzap/client/service`

#### [`MoltZapService`](./service/index.ts#L24)

_Namespace_

#### [`MoltZapService.StartupError`](./service/index.ts#L26)

_Class_

```ts
  export class StartupError extends Data.TaggedError(
    "MoltZapServiceStartupError",
  )<{
    readonly phase: "configuration" | "storage" | "listener";
  }> {
    /**
     * Names only the failed phase, so the process log says why startup stopped.
     * @returns The startup failure message.
     */
    override get message(): string {
      return `moltzapd startup failed in phase ${this.phase}`;
    }
  }
```

Closed daemon startup phase without configuration or platform detail.

#### [`MoltZapService.layer`](./service/index.ts#L75)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> =
    Layer.scopedDiscard(runDaemon)
```

Complete production process composition for `moltzapd`.

## Files

- `delivery/history-export.ts`
- `delivery/host-delivery.ts`
- `delivery/inbox.ts`
- `delivery/index.ts`
- `delivery/operations.ts`
- `delivery/pass.ts`
- `delivery/README.md`
- `delivery/send-invocations.ts`
- `endpoint/harness-endpoint/capability.ts`
- `endpoint/harness-endpoint/events.ts`
- `endpoint/harness-endpoint/index.ts`
- `endpoint/implementation.ts`
- `endpoint/mcp/auth.ts`
- `endpoint/mcp/event-schemas.ts`
- `endpoint/mcp/event-signing.ts`
- `endpoint/mcp/events.ts`
- `endpoint/mcp/http.ts`
- `endpoint/mcp/index.ts`
- `endpoint/mcp/names.ts`
- `endpoint/mcp/owner-tools.ts`
- `endpoint/mcp/README.md`
- `endpoint/mcp/schemas.ts`
- `endpoint/mcp/tools.ts`
- `endpoint/mcp/webhook.ts`
- `identity/credentials.ts`
- `identity/index.ts`
- `index.ts`
- `README.md`
- `service/activation.ts`
- `service/configuration.ts`
- `service/controller.ts`
- `service/index.ts`
- `service/lifecycle.ts`
- `service/management.ts`
- `service/README.md`
- `service/registration.ts`
- `service/supervision.ts`
- `store/anchors.ts`
- `store/database/index.ts`
- `store/database/schema.ts`
- `store/database/values.ts`
- `store/inbox.ts`
- `store/index.ts`
- `store/queues/deliveries.ts`
- `store/queues/dissemination.ts`
- `store/queues/index.ts`
- `store/queues/outbound.ts`
- `store/queues/README.md`
- `store/README.md`
- `store/reads.ts`
- `store/records.ts`
- `store/rows/index.ts`
- `store/runtime-codec.ts`
- `store/store.ts`
- `store/types.ts`
- `transport/collectives/answer-check.ts`
- `transport/collectives/answer-formats.ts`
- `transport/collectives/failures.ts`
- `transport/collectives/form-grammar.ts`
- `transport/collectives/forms.ts`
- `transport/collectives/inbound.ts`
- `transport/collectives/index.ts`
- `transport/collectives/message-text.ts`
- `transport/collectives/operation.ts`
- `transport/collectives/README.md`
- `transport/collectives/received-request.ts`
- `transport/collectives/request-sends.ts`
- `transport/collectives/shared-answers.ts`
- `transport/collectives/validation.ts`
- `transport/collectives/wire.ts`
- `transport/messaging/address.ts`
- `transport/messaging/certification.ts`
- `transport/messaging/dissemination.ts`
- `transport/messaging/durability.ts`
- `transport/messaging/errors.ts`
- `transport/messaging/evidence.ts`
- `transport/messaging/index.ts`
- `transport/messaging/message.ts`
- `transport/messaging/README.md`
- `transport/messaging/recovery/barrier.ts`
- `transport/messaging/recovery/evidence.ts`
- `transport/messaging/recovery/index.ts`
- `transport/messaging/recovery/persistence.ts`
- `transport/messaging/recovery/README.md`
- `transport/messaging/recovery/reanchor-empty.ts`
- `transport/messaging/recovery/reanchor.ts`
- `transport/messaging/recovery/state.ts`
- `transport/messaging/send.ts`
- `transport/messaging/types.ts`
- `transport/router/index.ts`
- `transport/router/outage.ts`
- `transport/router/types.ts`
- `transport/wire/canonical.ts`
- `transport/wire/codec.ts`
- `transport/wire/index.ts`
- `transport/wire/README.md`
- `transport/wire/schemas.ts`
- `transport/wire/values.ts`
- `transport/wire/verification.ts`
