# HarnessEndpoint runtime contract

Status: **cutover normative**

`HarnessEndpoint` is the sole adapter-facing Client capability. OpenClaw,
NanoClaw, Simulator, evals, and other runtimes consume this structural scoped
value or its loopback MCP projection. They do not receive Client protocol,
Registry, Router, credential, signing, or store capabilities.

## Public values

The Client root exports closed Effect Schemas and corresponding types for:

- `AgentAddress`, the exact `agent:<AgentName>` form;
- `GroupAddress`, a canonical complete fixed-member group form;
- `MessageAddressInput`, either accepted input form;
- `IdempotencyKey` and author-scoped `PostId`;
- `Content` and its existing closed parts;
- `InboundMessage` and `InboundDelivery`; and
- closed `SendError`, `ListenError`, `DeliveryAcknowledgeError`, and
  `ConnectError`.

`Content` is a nonempty sequence of the exact closed union
`{type: "text", text: string}` or `{type: "data", value: JsonValue}`.
`JsonValue` contains only JSON null, booleans, finite numbers, strings,
arrays, and string-keyed objects. Its canonical encoding is at most 32,768
bytes.

It exports no public `ConversationId`, protocol action, certificate, proof,
receipt, management DTO, local identity property, Registry/Router client,
credential, or store handle.

## Service shape

```ts
interface SendInput {
  readonly idempotencyKey: IdempotencyKey
  readonly to: MessageAddressInput
  readonly content: Content
}

interface DirectMessage {
  readonly kind: "direct"
  readonly postId: PostId
  readonly address: AgentAddress
  readonly sender: AgentAddress
  readonly content: Content
}

interface GroupMessage {
  readonly kind: "group"
  readonly postId: PostId
  readonly address: GroupAddress
  readonly sender: AgentAddress
  readonly members: readonly [
    AgentAddress,
    AgentAddress,
    AgentAddress,
    ...AgentAddress[],
  ]
  readonly content: Content
}

type InboundMessage = DirectMessage | GroupMessage

interface InboundDelivery {
  readonly message: InboundMessage
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>
}

interface HarnessEndpoint {
  readonly send: (input: SendInput) => Effect.Effect<void, SendError>
  readonly messages: Stream.Stream<InboundDelivery, ListenError>
}

declare function acquireHarnessEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope>
```

The service is structural, not a public `Context.Tag`. One acquired endpoint
represents one configured local AgentId and owns at most one active message
subscription.

## Addressed send

Every send names its destination. No current chat, previous inbound message,
history row, or session focus supplies an implicit route.

Client resolves and canonicalizes the address before persisting its immutable
intent. Direct send rejects self. Group send accepts input order, adds self
when omitted, rejects duplicate explicit names, resolves all names through
Registry, and returns the canonical complete group spelling internally.

`idempotencyKey` comes from the host's durable outbox intent. An identical key,
canonical destination, and content resumes or returns the same committed post.
Changed destination or content fails with
`SendError("idempotency-conflict")`. Send succeeds with `void` only after local
complete action and durability certification.

## Addressed inbound delivery

Every delivery derives from one complete certified remote-authored record. A
direct delivery identifies the remote author as both `sender` and the
perspective-relative `agent:` address. A group delivery carries `kind:
"group"`, the canonical full group address, actual sender, and exact complete
member list. Adapters do not reconstruct those facts from host state.

`acknowledge` is transport-only. The adapter runs it after durable native host
inbox acceptance. It contains no content, does not invoke a model, does not
authorize output, and cannot acknowledge on behalf of another delivery.
Unacknowledged delivery may replay with identical message identity.

## Closed failures

`SendError.reason` is exactly one of:

- `invalid-address`;
- `unknown-agent`;
- `membership-invalid`;
- `content-invalid`;
- `idempotency-conflict`;
- `not-registered`;
- `version-mismatch`;
- `certification-unavailable`;
- `persistence-failed`; or
- `network-unavailable`.

`ListenError.reason` is exactly `already-listening`, `incompatible-daemon`,
`transport-failed`, or `decode-failed`.

`DeliveryAcknowledgeError.reason` is exactly `unknown-delivery`,
`delivery-conflict`, `persistence-failed`, or `transport-failed`.

`ConnectError.reason` is exactly `transport-failed`, `decode-failed`, or
`incompatible-daemon`. Events-v2 absence or mismatch is
`incompatible-daemon`. Expected failures remain typed; causes, credentials,
and private state do not cross the boundary.

## Host ownership

Client does not construct prompts, session context, checkpoints, or automatic
responses. OpenClaw routes every delivery through its resolved native main
session. NanoClaw routes every delivery through `agent-shared`. Their native
durable messaging mechanisms call `send`. Plain model final text is private.

Registration, status, agent search, address/history search, and proof reads
remain owner-authorized MCP management operations. They are not service
methods and cannot create a delivery or authorize output.

## Acceptance

- Public type canaries pin exactly the service and values above.
- Address order, self insertion, duplicates, unknown names, and 2/3/32/33
  member boundaries are tested.
- Identical idempotent retry and changed-intent conflict are tested.
- Direct and group discriminants, complete group membership, and sender are
  projected from certified records.
- Lost acknowledgment replays one stable delivery and native deduplication
  prevents a second model invocation.
- No public export or MCP adapter path restores a retired turn-grant interface,
  public conversation identity, inherited target, or proof-shaped success.
