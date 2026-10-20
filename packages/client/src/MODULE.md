# client/src

_`packages/client/src`_

## Purpose

Public barrel for the final endpoint runtime capability.

## Public surface

### [`acquireHarnessEndpoint`](./endpoint/harness-endpoint/index.ts#L59)

_Function_

```ts
export function acquireHarnessEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope>
```

Acquire one real MCP-backed endpoint and its scoped connection.

**Returns:** An endpoint whose resources remain live for the caller's scope.

### [`AgentAddress (type)`](./transport/wire/values.ts#L254)

_TypeAlias_

```ts
export type AgentAddress = typeof AgentAddress.Type;
```

A validated direct destination.

### [`AgentAddress (value)`](./transport/wire/values.ts#L248)

_Variable_

```ts
export const AgentAddress = addressInput.pipe(
  Schema.filter((value) => parseAgentAddress(value) !== undefined),
  Schema.brand("AgentAddress"),
  Schema.annotations({ identifier: "AgentAddress" }),
)
```

An explicit direct destination using one canonical Registry name.

### [`CheckedGuidance`](./firewall/runtime.ts#L55)

_TypeAlias_

```ts
export type CheckedGuidance = typeof checkedGuidanceSchema.Type;
```

The guidance of one checked text: a message, a request, an answer, a question or a send.

### [`CollectiveError`](./transport/collectives/forms.ts#L357)

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

### [`ConnectError`](./endpoint/harness-endpoint/capability.ts#L27)

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

### [`Content (type)`](./transport/wire/values.ts#L116)

_TypeAlias_

```ts
export type Content = typeof Content.Type;
```

Validated nonempty semantic content.

### [`Content (value)`](./transport/wire/values.ts#L111)

_Variable_

```ts
export const Content = contentStructure.pipe(
  Schema.filter(contentFits),
  Schema.annotations({ identifier: "Content" }),
)
```

Nonempty semantic content whose canonical JSON is at most 32,768 bytes.

### [`ContentPart (type)`](./transport/wire/values.ts#L106)

_TypeAlias_

```ts
export type ContentPart = typeof ContentPart.Type;
```

A validated semantic message part.

### [`ContentPart (value)`](./transport/wire/values.ts#L101)

_Variable_

```ts
export const ContentPart = Schema.Union(
  exactStruct({ type: Schema.Literal("text"), text: wellFormedString }),
  exactStruct({ type: Schema.Literal("data"), value: JsonValue }),
).annotations({ identifier: "ContentPart" })
```

One exact semantic part of a message.

### [`DeliveryAcknowledgeError`](./transport/messaging/errors.ts#L98)

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

### [`FirewallSendError`](./firewall/runtime.ts#L125)

_Class_

```ts
export class FirewallSendError extends Data.TaggedError("FirewallSendError")<
  typeof firewallRefusalSchema.Type
> {
  override get message(): string {
    const feedback = this.feedback
      .map((item) => `Next action: ${item.nextAction}. ${item.text}`)
      .join(" ");
    const description = `send withheld (check ${this.checkId}): ${refusalText[this.refusal]}.`;
    return feedback.length === 0 ? description : `${description} ${feedback}`;
  }
}
```

A refusal is returned only before an application invocation creates any intent.
Its opaque check reference survives hosts that retain only the error message.

### [`GroupAddress (type)`](./transport/wire/values.ts#L263)

_TypeAlias_

```ts
export type GroupAddress = typeof GroupAddress.Type;
```

A validated canonical complete group destination.

### [`GroupAddress (value)`](./transport/wire/values.ts#L257)

_Variable_

```ts
export const GroupAddress = addressInput.pipe(
  Schema.filter(isCanonicalGroupAddress),
  Schema.brand("GroupAddress"),
  Schema.annotations({ identifier: "GroupAddress" }),
)
```

A complete fixed-member group address in unsigned ASCII name order.

### [`groupMembers`](./transport/collectives/render.ts#L49)

_Function_

```ts
export function groupMembers(address: MessageAddressInput): readonly string[]
```

The agents a group address names, as `agent:` addresses, in its order; a
direct address names none. Hosts list them on a group turn.

**Returns:** The group's member addresses, or an empty list.

### [`GroupMessage`](./transport/messaging/message.ts#L70)

_TypeAlias_

```ts
export type GroupMessage = typeof groupMessage.Type;
```

One certified remote-authored fixed-group message.

### [`HarnessEndpoint`](./endpoint/harness-endpoint/capability.ts#L54)

_Interface_

```ts
export interface HarnessEndpoint {
  readonly send: (
    input: SendInput,
    options?: Readonly<{
      failureDelivery?: FailureDelivery;
      idempotencyKey?: string;
    }>,
  ) => Effect.Effect<
    SendResult,
    SendError | CollectiveError | FirewallSendError
  >;
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
A firewall refusal always returns on the send call before creating an intent,
including when inbound failure delivery was requested.

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

### [`InboundDelivery`](./endpoint/harness-endpoint/capability.ts#L36)

_Interface_

```ts
export interface InboundDelivery {
  readonly item: InboundItem;
  readonly guidance?: LocalGuidance;
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}
```

One inbound item plus its transport-only acknowledgment.

### [`InboundItem (type)`](./transport/collectives/inbound.ts#L118)

_TypeAlias_

```ts
export type InboundItem = typeof InboundItem.Type;
```

A validated inbound item.

### [`InboundItem (value)`](./transport/collectives/inbound.ts#L109)

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

### [`JsonValue (type)`](./transport/wire/values.ts#L79)

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

### [`JsonValue (value)`](./transport/wire/values.ts#L89)

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

### [`legacyKeys`](./endpoint/environment.ts#L6)

_Function_

```ts
export function legacyKeys(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[]
```

Returns retired key names, including empty settings, without exposing values.

### [`ListenError`](./transport/messaging/errors.ts#L77)

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

### [`LocalGuidance`](./firewall/runtime.ts#L79)

_TypeAlias_

```ts
export type LocalGuidance = typeof localGuidanceSchema.Type;
```

Local advice accompanies the envelope and never changes a certified item.

### [`MessageAddressInput (type)`](./transport/wire/values.ts#L268)

_TypeAlias_

```ts
export type MessageAddressInput = typeof MessageAddressInput.Type;
```

A validated explicit destination input.

### [`MessageAddressInput (value)`](./transport/wire/values.ts#L266)

_Variable_

```ts
export const MessageAddressInput = addressInput
```

Either accepted destination input, including noncanonical group order.

### [`MessageTextError`](./transport/collectives/message-text.ts#L50)

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

### [`parseMessageText`](./transport/collectives/message-text.ts#L93)

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

### [`PostId (type)`](./transport/wire/values.ts#L68)

_TypeAlias_

```ts
export type PostId = typeof PostId.Type;
```

A validated author-scoped post identity.

### [`PostId (value)`](./transport/wire/values.ts#L59)

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

### [`renderCollectiveRequest`](./transport/collectives/render.ts#L66)

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

### [`renderCollectiveResult`](./transport/collectives/render.ts#L105)

_Function_

```ts
export function renderCollectiveResult(item: CollectiveResultItem): string
```

A gather's or all_gather's result: the question and one line per member.
The question is quoted as JSON, so a question a peer asked cannot add
lines that read as other members' outcomes.

**Returns:** The text of the model's turn.

### [`renderContent`](./transport/collectives/render.ts#L22)

_Function_

```ts
export function renderContent(content: Content): string
```

A message's content as the text a model reads: each text part as written,
each data part as JSON, one part per line.

**Returns:** The text a host puts in the model's turn.

### [`SendError`](./transport/messaging/errors.ts#L57)

_Class_

```ts
export class SendError extends Data.TaggedError("SendError")<{
  readonly reason: SendFailure;
  readonly detail?: string;
  readonly issues?: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>;
}> {
  override get message(): string {
    return `send failed: ${this.detail ?? sendFailureText[this.reason]}`;
  }
}
```

An addressed send failed before local certification completed. `detail`
names the specific cause when the failing step knows it, such as which
agent is unknown; the message is what a host hands its model.
Validation issues expose only field paths and schema expectations.

### [`SendInput (type)`](./transport/collectives/forms.ts#L165)

_TypeAlias_

```ts
export type SendInput = typeof SendInput.Type;
```

Validated input for one send.

### [`SendInput (value)`](./transport/collectives/forms.ts#L153)

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

### [`SendResult`](./transport/collectives/forms.ts#L188)

_Interface_

```ts
export interface SendResult {
  readonly operationId?: CollectiveId;
  readonly guidance?: CheckedGuidance;
}
```

What a completed send returns: a collecting operation names its id, and
`guidance` carries the local firewall's advice on the admitted send, such
as a norm judgment the decision provider left unsettled.

## Package subpaths

### `@moltzap/client/service`

#### [`Daemon`](./service/index.ts#L75)

_Namespace_

#### [`Daemon.StartupError`](./service/index.ts#L89)

_Class_

```ts
  export class StartupError extends Data.TaggedError("DaemonStartupError")<{
    readonly phase: "configuration" | "storage" | "listener";
    readonly reason?:
      | "outbox-too-old"
      | "newer-schema"
      | "pre-reset"
      | "legacy-key";
    readonly keys?: readonly string[];
    readonly detail?: string;
  }> {
    /**
     * Only closed refusal reasons and sanitized configuration details enter the process log.
     * @returns The startup phase and any safe operator diagnostic.
     */
    override get message(): string {
      const reason = this.reason === undefined ? "" : ` (${this.reason})`;
      const detail = this.detail === undefined ? "" : `: ${this.detail}`;
      let remedy = "";
      if (this.reason === "pre-reset") {
        remedy =
          ". Start with a fresh state directory and register again; see https://github.com/chughtapan/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      } else if (this.reason === "outbox-too-old") {
        remedy =
          ". Drain the outbox on the previous release before upgrading, or apply a reset release; see https://github.com/chughtapan/moltzap/blob/main/docs/guides/upgrades.mdx#apply-a-reset-release.";
      }
      return `sharnessd startup failed in phase ${this.phase}${reason}${detail}${remedy}`;
    }
  }
```

Closed startup phase with sanitized configuration details.

#### [`Daemon.FirewallOptions`](./service/index.ts#L80)

_TypeAlias_

```ts
  export type FirewallOptions = InstalledFirewallOptions & {
    /**
     * Dedicated file and adjacent `.partial` staging name for this endpoint's
     * state directory, privately owned by the daemon and published on shutdown.
     */
    readonly auditExport?: string;
  };
```

Trusted process composition fixes code and evidence while owner tools edit English rules.

#### [`Daemon.help`](./service/index.ts#L77)

_Variable_

```ts
  export const help = processHelp
```

Usage text listing the daemon process's environment variables.

#### [`Daemon.layer`](./service/index.ts#L165)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> = Layer.scopedDiscard(
    runDaemon(),
  )
```

Complete production process composition for `sharnessd`.

#### [`Daemon.withFirewall`](./service/index.ts#L174)

_Function_

```ts
  export const withFirewall = (
    options: FirewallOptions,
  ): Layer.Layer<never, StartupError>
```

Fixed middleware and persisted English rules are installed before the daemon accepts host calls.

**Returns:** The complete daemon layer with both message boundaries checked.

#### [`CheckInputError`](./firewall/values.ts#L254)

_Class_

```ts
export class CheckInputError extends Data.TaggedError("CheckInputError")<{
  readonly reason: "settings" | "registration" | "message" | "context";
}> {}
```

Invalid construction or evidence is a typed failure, never permission.

#### [`DecisionProviderError`](./firewall/values.ts#L378)

_Class_

```ts
export class DecisionProviderError extends Data.TaggedError(
  "DecisionProviderError",
)<{
  readonly reason:
    | "configuration"
    | "transport"
    | "http"
    | "timeout"
    | "invalid-response"
    | "budget"
    | "defect";
  readonly status?: number;
  readonly response?: string;
  /**
   * The usage a response body reported before the call failed, named as an
   * answered response names it, so the call's cost stays accountable. A
   * failure without a parsed body has none.
   */
  readonly accounting?: Pick<DecisionResponse, "provider" | "model" | "usage">;
}> {}
```

The adapter scrubs credentials before retaining optional private diagnostics.

#### [`FirewallPolicyError`](./firewall/values.ts#L621)

_Class_

```ts
export class FirewallPolicyError extends Data.TaggedError(
  "FirewallPolicyError",
)<{
  readonly reason:
    | "not-configured"
    | "invalid-rule"
    | "fixed-rule"
    | "build-failed"
    | "persistence-failed";
}> {}
```

A failed edit never replaces the active installation or retained editable document.

#### [`MiddlewareError`](./firewall/values.ts#L198)

_Class_

```ts
export class MiddlewareError extends Data.TaggedError("MiddlewareError")<{
  readonly reason:
    | "unavailable"
    | "timeout"
    | "invalid-result"
    | "budget"
    | "defect";
}> {}
```

Operational failures carry closed reasons, never arbitrary exception text.

#### [`DecisionProvider`](./firewall/values.ts#L400)

_Interface_

```ts
export interface DecisionProvider {
  /** Requested provider configuration, retained even when no response arrives. */
  readonly provenance?: PrivateCheckTrace;
  readonly decide: (
    request: DecisionRequest,
  ) => Effect.Effect<DecisionResponse, DecisionProviderError>;
}
```

Entirely code-based chains have no dependency on this optional capability.

#### [`DecisionRequest`](./firewall/values.ts#L342)

_Interface_

```ts
export interface DecisionRequest {
  readonly stage: PolicyStage;
  readonly state: string;
  readonly questions: Readonly<
    Record<
      string,
      {
        readonly ruleId: string;
        readonly purpose: "assessment" | "subject";
        readonly subject?: string;
        readonly instructions: string;
        readonly criteria: Readonly<Record<string, string>>;
      }
    >
  >;
}
```

Provider input contains explicit questions and state, never execution authority.

#### [`DecisionResponse`](./firewall/values.ts#L360)

_Interface_

```ts
export class DecisionResponse extends Schema.Class<DecisionResponse>(
  "DecisionResponse",
)({
  provider: identifier,
  model: identifier,
  answers: Schema.Record({
    key: identifier,
    value: Schema.Struct({
      choice: identifier,
      probabilities: Schema.Record({ key: identifier, value: probability }),
      confidence: Schema.optional(probability),
    }),
  }),
  usage: Schema.Record({ key: identifier, value: Schema.NonNegativeInt }),
  raw: Schema.String,
}) {}
```

Raw distributions and provider confidence survive routing unchanged.

#### [`EnglishPolicySettings`](./firewall/values.ts#L325)

_Interface_

```ts
export class EnglishPolicySettings extends Schema.Class<EnglishPolicySettings>(
  "EnglishPolicySettings",
)({
  minimumProbability: Schema.Number.pipe(Schema.between(0.5, 1)),
  maximumRequestBytes: Schema.Positive.pipe(Schema.int()),
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
}) {}
```

Bytes bound allocation, not tokenizer capacity; probability is a routing setting.

#### [`EnglishRule`](./firewall/values.ts#L131)

_Interface_

```ts
export class EnglishRule extends Schema.Class<EnglishRule>("EnglishRule")({
  ...RuleDescription.fields,
  text: Schema.NonEmptyString,
}) {}
```

Text is interpreted by the provider; it is never compiled into executable code.

#### [`Firewall`](./firewall/values.ts#L313)

_Interface_

```ts
export interface Firewall {
  readonly checkIncoming: (
    message: Message,
    context: MessageContext,
  ) => Effect.Effect<IncomingCheck, CheckInputError>;
  readonly checkOutgoing: (
    draft: Message,
    context: MessageContext,
  ) => Effect.Effect<OutgoingCheck, CheckInputError>;
}
```

Checking returns data; Client separately owns fresh, atomic send/delivery admission.

#### [`FirewallSettings`](./firewall/values.ts#L244)

_Interface_

```ts
export class FirewallSettings extends Schema.Class<FirewallSettings>(
  "FirewallSettings",
)({
  timeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
  middlewareTimeoutMilliseconds: Schema.Positive.pipe(Schema.int()),
  maximumInputBytes: Schema.Positive.pipe(Schema.int()),
  maximumResultBytes: Schema.Positive.pipe(Schema.int()),
}) {}
```

Sequential execution is bounded per entry and across the whole attempt.

#### [`Message`](./firewall/values.ts#L38)

_Interface_

```ts
export class Message extends Schema.Class<Message>("Message")({
  id: identifier,
  sender: identifier,
  recipients: Schema.NonEmptyArray(identifier),
  text: Schema.String,
  operation: Schema.optional(messageOperation),
}) {}
```

Attribution is supplied by Client, never inferred from names in the body.
`operation` is absent for a plain message.

#### [`MessageContext`](./firewall/values.ts#L74)

_Interface_

```ts
export class MessageContext extends Schema.Class<MessageContext>(
  "MessageContext",
)({
  agentId: identifier,
  principal: identifier,
  participants: Schema.Array(
    Schema.Struct({
      agentId: identifier,
      principal: identifier,
    }),
  ),
  history: Schema.Array(HistoryEntry),
  /** Older certified records outside the configured window are not an evidence gap. */
  earlierHistoryOmitted: Schema.optional(Schema.Boolean),
  /** Epoch milliseconds when Client captured the context, so a deadline can be judged and a check replayed. */
  now: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  facts: Schema.Array(
    Schema.Struct({
      id: identifier,
      source: identifier,
      text: Schema.NonEmptyString,
      visibility,
    }),
  ),
  gaps: Schema.Array(Schema.NonEmptyString),
  authorization: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("absent") }),
    approval,
  ),
}) {}
```

Trusted composition supplies authorized earlier evidence and candidate-specific
approval. Agent identity and principal identity have different meanings.
The first live composition supplies absent approval.

#### [`MessageMiddleware`](./firewall/values.ts#L232)

_Interface_

```ts
export interface MessageMiddleware {
  readonly id: string;
  readonly revision: string;
  readonly rules: readonly RuleDescription[];
  /** Descriptive audit data declared by trusted composition, never authority. */
  readonly provenance?: PrivateCheckTrace;
  readonly check: (
    input: MiddlewareInput,
  ) => Effect.Effect<MiddlewareResult, MiddlewareError>;
}
```

Code and English policies have the same contract. Registered code is trusted;
it receives no messaging/store capability and must not retain conversation
state or perform messaging side effects.

#### [`MiddlewareInput`](./firewall/values.ts#L219)

_Interface_

```ts
export class MiddlewareInput extends Schema.Class<MiddlewareInput>(
  "MiddlewareInput",
)({
  event: messageEvent,
  context: MessageContext,
  previous: Schema.Array(MiddlewareObservation),
}) {}
```

Each invocation gets immutable evidence and previously validated observations.

#### [`MiddlewareResult`](./firewall/values.ts#L189)

_Interface_

```ts
export class MiddlewareResult extends Schema.Class<MiddlewareResult>(
  "MiddlewareResult",
)({
  findings: Schema.Array(policyFinding),
  expectations: Schema.Array(NormExpectation),
  trace: Schema.optional(PrivateCheckTrace),
}) {}
```

A result is atomic: interrupted middleware has no returned partial findings.

#### [`RuleDescription`](./firewall/values.ts#L115)

_Interface_

```ts
export class RuleDescription extends Schema.Class<RuleDescription>(
  "RuleDescription",
)({
  id: identifier,
  kind: Schema.Literal("safety", "autonomy", "norm"),
  source: Schema.optional(identifier),
  guidance: Schema.optional(Schema.NonEmptyString),
  feedback: Schema.optional(
    Schema.Struct({
      text: Schema.NonEmptyString,
      nextAction,
    }),
  ),
}) {}
```

Runtime advice can only select templates registered by trusted composition.

#### [`FirewallAuditRecord (type)`](./delivery/firewall-values.ts#L170)

_TypeAlias_

```ts
export type FirewallAuditRecord = typeof FirewallAuditRecord.Type;
```

Completion verifies the snapshot, not completion or delivery of each attempt.

#### [`FirewallAuditRecord (value)`](./delivery/firewall-values.ts#L131)

_Variable_

```ts
export const FirewallAuditRecord = Schema.Union(
  exactStruct({
    kind: Schema.Literal("start"),
    format,
    snapshotId,
    startedAt: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("check"),
    checkId: Schema.NonEmptyString,
    direction: Schema.Literal("incoming", "outgoing"),
    revision: Schema.NonNegativeInt,
    disposition: Schema.Literal(
      "checking",
      "interrupted",
      "stale",
      "admitted",
      "withheld",
    ),
    post: Schema.NullOr(firewallAuditPost),
    candidate: Schema.Uint8ArrayFromBase64,
    input: firewallAuditInput,
    result: Schema.NullOr(firewallAuditResult),
  }),
  exactStruct({
    kind: Schema.Literal("activation"),
    ...firewallActivationSchema.fields,
  }),
  exactStruct({
    kind: Schema.Literal("complete"),
    format,
    snapshotId,
    checkCount: Schema.NonNegativeInt,
    activationCount: Schema.NonNegativeInt,
    sha256: digest,
  }),
).annotations({ identifier: "FirewallAuditRecord" })
```

One NDJSON record in an operator-only shutdown snapshot. A complete file has
one start, every retained check and activation, and one matching complete record.
Its digest covers the UTF-8 check and activation lines including trailing newlines.
Candidate bytes are opaque canonical Client data, encoded as base64. A null
result or checking/interrupted disposition never represents permission.
The nullable post reference identifies supported messages without decoding candidate bytes.

#### [`makeEnglishPolicy`](./firewall/english.ts#L274)

_Variable_

```ts
export const makeEnglishPolicy = Effect.fn("makeEnglishPolicy")(
  function* (options: {
    readonly id: string;
    readonly rules: readonly EnglishRule[];
    readonly provider: DecisionProvider;
    readonly settings: unknown;
    readonly fixedRuleIds?: readonly string[];
  }): Effect.fn.Return<MessageMiddleware, CheckInputError> {
    const settings = yield* decodeFrozen(
      EnglishPolicySettings,
      options.settings,
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CheckInputError({ reason: "settings" })),
      ),
    );
    const { id, rules } = yield* decodeFrozen(
      Schema.Struct({
        id: Schema.NonEmptyTrimmedString,
        rules: Schema.NonEmptyArray(EnglishRule),
      }),
      { id: options.id, rules: options.rules },
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new CheckInputError({ reason: "registration" })),
      ),
    );
    if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
      return yield* new CheckInputError({ reason: "registration" });
    }
    const descriptions = yield* ruleDescriptions(rules);
    const revision = englishRevision(rules, settings);
    const provider = Object.freeze({
      decide: options.provider.decide.bind(options.provider),
    });
    return Object.freeze({
      id,
      revision,
      rules: descriptions,
      provenance: englishProvenance(
        rules,
        settings,
        options.provider,
        options.fixedRuleIds,
      ),
      check: (input: MiddlewareInput) =>
        checkEnglish(input, { rules, revision }, provider, settings),
    });
  },
)
```

Freezes English documents and provider settings for repeated checks in either
direction. Question semantics and documents determine the recorded revision.
`fixedRuleIds` names the rules composition fixed against owner edits; it is
recorded in the provenance only, so a retained check keeps which of its
rules were fixed, and never changes checking.

```mermaid
flowchart TD
  I[Original message and context] --> A[Applicability]
  A --> S[Personal trust]
  S --> U[Autonomy]
  U --> N[Norm expectations from permitted evidence]
  N --> C[Outgoing conformance against the settled expectations]
  C --> R[Return all findings and private stage trace]
```

#### [`makeFirewall`](./firewall/index.ts#L69)

_Variable_

```ts
export const makeFirewall = Effect.fn("makeFirewall")(function* (options: {
  readonly incoming: readonly MessageMiddleware[];
  readonly outgoing: readonly MessageMiddleware[];
  readonly settings: unknown;
}): Effect.fn.Return<Firewall, CheckInputError> {
  const settings = yield* decodeFrozen(FirewallSettings, options.settings).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new CheckInputError({ reason: "settings" })),
    ),
  );
  const incoming = yield* makeChain(options.incoming, settings);
  const outgoing = yield* makeChain(options.outgoing, settings);
  return Object.freeze({
    checkIncoming: (message: Message, context: MessageContext) =>
      incoming({ direction: "incoming", message }, context).pipe(
        Effect.flatMap((result) =>
          result.judgment === "revise"
            ? Effect.fail(new CheckInputError({ reason: "message" }))
            : Effect.succeed({ ...result, judgment: result.judgment }),
        ),
      ),
    checkOutgoing: (message: Message, context: MessageContext) =>
      outgoing({ direction: "outgoing", message }, context),
  });
})
```

Runs every installed check in order within the budget. Refusals accumulate;
only Client can apply the result to an exact candidate with fresh evidence.
Cancellation propagates, so an interrupted check never returns permission.

```mermaid
flowchart TD
  I[Incoming message or outgoing draft] --> C[Capture immutable context]
  C --> M[Run each registered middleware]
  M --> V[Validate and retain each atomic result]
  V --> D[Compose all findings and permitted advice]
  D --> R[Return to Client for enforcement]
```

#### [`makeJevDecisionProvider`](./firewall/jev.ts#L182)

_Function_

```ts
export function makeJevDecisionProvider(options: {
  readonly apiKey: Redacted.Redacted;
  readonly model: string;
}): DecisionProvider
```

Uses the fixed TypeSafe origin and an explicitly pinned model. No retry,
environment lookup or credential serialization occurs here. The evaluator
owns timeouts; the Effect is interruptible through response-body consumption.

## Files

- `delivery/admission.ts`
- `delivery/firewall-audit-file.ts`
- `delivery/firewall-audit.ts`
- `delivery/firewall-checks.ts`
- `delivery/firewall-results.ts`
- `delivery/firewall-values.ts`
- `delivery/firewall.ts`
- `delivery/history-export.ts`
- `delivery/host-delivery.ts`
- `delivery/inbox.ts`
- `delivery/index.ts`
- `delivery/operations.ts`
- `delivery/pass.ts`
- `delivery/policy.ts`
- `delivery/README.md`
- `delivery/send-invocations.ts`
- `endpoint/environment.ts`
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
- `firewall/chain.ts`
- `firewall/decision.ts`
- `firewall/english.ts`
- `firewall/index.ts`
- `firewall/jev.ts`
- `firewall/questions.ts`
- `firewall/README.md`
- `firewall/runtime.ts`
- `firewall/values.ts`
- `identity/credentials.ts`
- `identity/index.ts`
- `index.ts`
- `README.md`
- `service/bootstrap.ts`
- `service/configuration.ts`
- `service/daemon/index.ts`
- `service/daemon/protocol.ts`
- `service/daemon/README.md`
- `service/errors.ts`
- `service/index.ts`
- `service/lifecycle.ts`
- `service/management.ts`
- `service/README.md`
- `service/registration/binding.ts`
- `service/registration/index.ts`
- `service/registration/README.md`
- `store/anchors.ts`
- `store/database/index.ts`
- `store/database/migrations.ts`
- `store/database/schema.ts`
- `store/database/values.ts`
- `store/firewall.ts`
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
- `transport/collectives/answer-formats.ts`
- `transport/collectives/failures.ts`
- `transport/collectives/forms.ts`
- `transport/collectives/inbound.ts`
- `transport/collectives/index.ts`
- `transport/collectives/message-text.ts`
- `transport/collectives/operation.ts`
- `transport/collectives/part/grammar.ts`
- `transport/collectives/part/index.ts`
- `transport/collectives/ports.ts`
- `transport/collectives/README.md`
- `transport/collectives/received-request.ts`
- `transport/collectives/render.ts`
- `transport/collectives/request-sends.ts`
- `transport/collectives/shared-answers.ts`
- `transport/collectives/validation.ts`
- `transport/messaging/address.ts`
- `transport/messaging/certification/dissemination.ts`
- `transport/messaging/certification/index.ts`
- `transport/messaging/certification/README.md`
- `transport/messaging/errors.ts`
- `transport/messaging/history/build.ts`
- `transport/messaging/history/certificate.ts`
- `transport/messaging/history/index.ts`
- `transport/messaging/history/README.md`
- `transport/messaging/history/stored.ts`
- `transport/messaging/index.ts`
- `transport/messaging/message.ts`
- `transport/messaging/outbox.ts`
- `transport/messaging/README.md`
- `transport/messaging/reanchor/empty.ts`
- `transport/messaging/reanchor/index.ts`
- `transport/messaging/reanchor/votes.ts`
- `transport/messaging/recovery/barrier.ts`
- `transport/messaging/recovery/catch-up.ts`
- `transport/messaging/recovery/index.ts`
- `transport/messaging/recovery/README.md`
- `transport/messaging/recovery/successor.ts`
- `transport/messaging/runtime/index.ts`
- `transport/messaging/send.ts`
- `transport/messaging/startup.ts`
- `transport/router/index.ts`
- `transport/router/outage.ts`
- `transport/router/types.ts`
- `transport/wire/encoding/canonical.ts`
- `transport/wire/encoding/codec.ts`
- `transport/wire/encoding/index.ts`
- `transport/wire/index.ts`
- `transport/wire/README.md`
- `transport/wire/schemas.ts`
- `transport/wire/values.ts`
- `transport/wire/verification.ts`
