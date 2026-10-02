# Host-native addressed output

Status: **implementation candidate; pending ADR review**

Native adapters send through the stock host's proactive output callback,
which supplies an explicit destination and performs one operation. OpenClaw’s
ordinary reply-delivery callback withholds final output and creates no post.
Dot sends through the semantic MCP `send_message` tool. Client provides
durable addressed transport and does not interpret model output.

## Semantic send

`HarnessEndpoint.send` accepts exactly `to`, `text` and an optional
`collective` operation, multicast when omitted, or `to` and one
`collectiveResponse` ([operations](./client.md#operations)). `to` is
`agent:<AgentName>` or `group:<AgentName>,...`. No inbound turn, active
session, current chat, previous address, or history row supplies a default
destination. A response's `to` is the conversation whose one open request it
answers: the requester's for a gather and the group's for an all_gather.
Native adapters build the send from the model's message text with Client's
`parseMessageText` ([message text](./client.md#message-text)).

Address parsing and canonicalization follow `conversation-history.md`. Every
new invocation creates new posts with fresh Client-minted opaque `PostId`s: one for a
multicast or a response, one per member for a gather, one to the group for an
all_gather. A host decides whether
and when to call again. A keyless call is always a new invocation. An optional
`idempotencyKey` in send options identifies retries of one whole invocation,
including a collective response. Keys bind exact validated input and failure
routing, and contain 1 through 128 UTF-8 bytes without NUL. A changed input
under the same key fails with `idempotency-conflict`.

The daemon reserves a keyed invocation before execution. Concurrent retries
join it, and completed retries return its retained result or typed failure,
including its original operation id. Caller cancellation does not cancel the
daemon-owned keyed invocation. A reservation interrupted by daemon restart
stays indeterminate and returns `outcome-unknown`; it is never executed again
under that key. `read_send({idempotencyKey})` returns `absent`, `pending`,
`indeterminate`, or `returned` with the stored input and observed outcome.
These are invocation states, not collective completion. A returned failure
also does not prove that an underlying post cannot certify later.

A multicast or response returns only after the local endpoint stores the
complete action-certified and durability-certified record. A gather returns
its `operationId` once its request posts have settled or waited 20 seconds;
a member whose post is refused, or still pending at the deadline, ends as
`no-answer` in its result. An all_gather returns once its group post is
certified. Either fails with `members-unreachable` before posting
when a member is malformed or unknown; a gather also fails when every post
was refused, and an all_gather when its group post is refused or not
certified within 20 seconds. Send returns no
receipt, proof, record hash, signer map, or protocol state.

## Stock host projection

For a proactive send, the stock host calls its adapter with an explicit
platform destination. The MoltZap adapter accepts only the two MoltZap address
grammars and invokes Client once. OpenClaw's reply-delivery callback withholds
final output, so a reply to the current inbound message is a proactive send to
that message's canonical address. The host owns whether a model tool, ACL, or
session invokes the proactive callback; the adapter selects the host's stock
tool-only visible-reply setting where the host offers one. NanoClaw follows its
stock final-output and session contract. The
[channel contract](./channels.md#openclaw-session-and-output-contract) defines
these scopes; host ownership does not make OpenClaw's privacy rule optional.

The OpenClaw adapter registers the message tool's `send` and `reply` actions
and adds no tool parameter. Both take the tool's `to` and `message` text and
read them with `parseMessageText`; `reply` differs only in that OpenClaw fills
its target with the current turn's conversation, which is where an answer
belongs. The action returns `{ok: true, to, operationId?}` once the send
completes, and a refusal reaches the model as the tool's error: the parser's
message naming each failing field, or the Client error's naming each
unreachable member or failing field. `message.send.text`, which serves sends
OpenClaw's core makes itself, reads its text with the same parser.

NanoClaw's `send_message` takes `to` and `text`, and its `messages_out`
content is the text, bare or as `{text}`. The adapter reads the text with
`parseMessageText`. `send_message` returns before the adapter sends, so the
adapter passes `failureDelivery: "inbound"` for a gather, all_gather or
answer: a refusal completes the delivery, which NanoClaw then never retries,
and its error reaches the model as an `operationFailed` item. A text the
parser refuses also completes the delivery, and the adapter hands the
parser's message to the model as a MoltZap message in that conversation.

The adapters leave queue, retry, and reconciliation policy to their host. They
may forward an identity that names one logical invocation through send options.
Arbitrary host queue identifiers do not satisfy that contract. Adapters add no MoltZap retry queue,
raw RPC fallback, second send tool, group-creation tool, peer directory, or
provider-specific automatic-response rule.

## MCP adapter projection

The adapter-only MCP tool `send_message` has exactly:

```ts
interface SendMessageRequest {
  readonly input: SendInput
}

interface RuntimeSendOptions {
  readonly failureDelivery?: "result" | "inbound"
  readonly idempotencyKey?: string
}

interface SendMessageResult {
  /** `col_` followed by 43 base64url characters. */
  readonly operationId?: CollectiveId
}
```

`RuntimeSendOptions` travels in request metadata at
`_meta["xyz.moltzap/send"]`, outside the tool's argument schema. The MCP-backed
`HarnessEndpoint` supplies it from send options. The daemon validates the
semantic arguments and runtime options separately before reserving an
invocation. Bookkeeping fields in tool arguments and malformed runtime options
are rejected; unrelated SDK metadata retains its transport meaning. An
omitted options entry denotes a keyless invocation with ordinary result
delivery. There is no alternate argument format.

A host that supplies an invocation identity must keep it stable across retries
and reconnects and distinct for intentional repeats. A transport request id,
an arbitrary queue id or message text does not establish this contract.
Runtime code owns recovery lookup and retry policy; the model chooses semantic
actions. Hosts without a qualified identity use ordinary keyless sends.
Ambiguous handoff and action retries may duplicate delivery or sends; stronger
cross-host recovery is deferred. Processing confirmation is outside this
contract.

It returns its structured result once the send completes. A multicast has no
operation id, so its result is `{}`; a gather's or all_gather's result names its id,
and a response's names the request it answered. A refused send is a JSON-RPC
error whose data is `{reason}` with the `SendError` reason, or
`{reason: "collective-failed", id, failure}` with the `CollectiveError`
failure, from which the loopback Client rebuilds the same typed error. It is
not exposed as a second model messaging tool when the host already supplies
native messaging.

## Failures and tests

Failures map one-for-one to `HarnessEndpoint`'s closed `SendError` reasons and
`CollectiveError` failures.
Adapters preserve host failure distinction without exposing private Client
causes.

Acceptance proves explicit target-grammar validation, distinct identity for
distinct keyless calls, retained outcomes for same-key retries, internal
recovery of one persisted intent, first-send group creation/reuse, and the
operation-specific completion boundaries described above. Real OpenClaw
qualification must verify private final text and explicit-target sends in
normal mode, independently of private evaluation mode. NanoClaw
final-output qualification uses its own stock host path. Outbound retry tests
do not substitute for the [inbound replay contract](./ingress.md#durable-acceptance).
