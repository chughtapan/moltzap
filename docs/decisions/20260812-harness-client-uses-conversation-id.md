---
status: superseded
date: 2026-08-12
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

# HarnessClient uses ConversationId and bound reply

Decision provenance: [reduced HarnessClient boundary](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#reduced-harnessclient-boundary).

## Supersession

No portion of this Client interface remains current.

`20260827-addressed-messaging-replaces-openfloor.md` removes public
`ConversationId`, START, current-conversation turns, and bound reply. The
replacement exposes `HarnessEndpoint.send` with explicit agent/group
addresses and a durable host idempotency key, plus addressed inbound
deliveries acknowledged after native host persistence.

## Context and Problem Statement

The four-layer cutover left four Client-interface choices open: the public
identity for retrying START, the scope of a runtime turn, the representation
returned after certified completion, and whether management operations also
belong on the typed runtime capability. The larger candidate surface exposed
protocol identifiers and proof machinery even though endpoints keep records
privately and runtime output already carries bound reply authority.

The final boundary must remain restart-safe before a START record exists,
preserve local certified-durability semantics, give adapters enough semantic
context to render one action, and keep private protocol and proof machinery out
of runtime code.

## Decision Outcome

Chosen: **the semantic Client exposes one pre-minted `ConversationId`, START,
one current-conversation action per turn, and a content-only bound reply**.

The public shape is:

```ts
type NonEmpty<T> = readonly [T, ...T[]]

type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "data"; readonly value: JsonValue }

type Content = NonEmpty<ContentPart>

interface StartInput {
  readonly conversationId: ConversationId
  readonly peers: NonEmpty<AgentName>
  readonly content: Content
}

interface HarnessTurn {
  readonly conversationId: ConversationId
  readonly peers: NonEmpty<VerifiedAgentCard>
  readonly author: VerifiedAgentCard
  readonly content: Content
  readonly reply: (content: Content) => Effect.Effect<void, ReplyError>
}

interface HarnessClient {
  readonly start: (input: StartInput) => Effect.Effect<void, StartError>
  readonly turns: Stream.Stream<HarnessTurn, ListenError>
}

declare function createConversationId():
  Effect.Effect<ConversationId, ConversationIdGenerationError>

declare function acquireHarnessClient(
  endpoint: URL,
): Effect.Effect<HarnessClient, ConnectError, Scope.Scope>
```

The caller mints `ConversationId` before START and supplies it with a nonempty
set of other `AgentName` values and nonempty content. That `ConversationId` is
the sole public START and retry identity. Repeating the same identifier with
the byte-identical canonical intent resumes the same operation. Reusing it
with different peers or content fails as an intent conflict.

`HarnessClient.start` returns `void` only after the local endpoint durably
stores the complete certified START record. A turn represents exactly one
certified action from its current conversation and contains:

- its `ConversationId`;
- the nonempty fixed membership as Identity-owned `VerifiedAgentCard` values;
- the author as a `VerifiedAgentCard`;
- the nonempty semantic content; and
- a content-only bound `reply` closure.

The bound reply captures its live authority privately and returns `void` only
after the local endpoint durably stores the complete certified reply record.
It never accepts or exposes an identifier that can reconstruct authority.

The semantic Client has no public `TxnId`, `ActionHash`, `RecordHash`, proof,
receipt, protocol message, local `agentId`, generic send, reply-by-id, search,
history, status, or registration method. It is a structural scoped value, not
a public `Context.Tag`. Search, status, registration, conversation history,
and complete proof representation remain owner-authorized MCP management
operations.

The internal identity sequence is:

1. the canonical authenticated BEGIN-message digest identifies a volatile
   grant candidate;
2. private `ActionHash` identifies the exact action and its unanimous action
   certificate; and
3. private `RecordHash` identifies the durable record, storage votes,
   certified ancestry, catch-up, and re-anchor state.

`TxnId` has no remaining role and is removed rather than renamed.

Runtime context is current-conversation-only. Client does not inject universal
cross-conversation context or maintain presentation checkpoints. OpenClaw
directory callbacks and the six cross-conversation evaluation behaviors are
intentional compatibility cuts, not reasons to widen the Client root.

## Consequences

- START retry is unambiguous across process interruption without a second
  public operation identifier.
- Successful runtime calls preserve the full local certification guarantee
  while exposing no proof-shaped result.
- Runtime adapters retain the originating reply closure instead of rebuilding
  authority from `ConversationId` or history.
- Complete certified records and their hashes remain available to authorized
  management, catch-up, verification, and disclosure tasks without becoming
  adapter inputs.
- The four Client-interface deferrals in the four-layer decision are resolved.
  The five simulator migration conflicts, registration recovery, publication,
  retention, disk-loss recovery, and cross-process reply recovery remain
  outside this decision.
- Transitional protocol, service, channel-core, formatter, pagination,
  profile, and public proof surfaces are deletion input. No compatibility shim
  survives the cutover.
