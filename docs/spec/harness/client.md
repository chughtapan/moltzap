# HarnessClient runtime contract

Status: **Gate 1 normative public interface**

## Purpose and ownership

`HarnessClient` is the sole adapter-facing capability. OpenClaw, NanoClaw,
and simulator runtime subjects consume an injected or MCP-backed client; they
do not construct Registry, Router, endpoint stores, protocol folds, signing
authority, or daemon processes.

It is a structural value acquired under an Effect scope, not a public
`Context.Tag`. Acquisition owns one connection and inbound subscription and
releases both with the scope. The Client root also exposes the
`ConversationId` creation operation used before START.

Client belongs to `@moltzap/client`. There is no profile-acquisition API,
generation selector, dual backing, protocol proxy, compatibility root, or
shared implementation imported from a retired package.

## Public values

The public content model is a nonempty immutable array of the closed union:

```ts
type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "data"; readonly value: JsonValue }

type Content = NonEmptyReadonlyArray<ContentPart>
```

The caller uses that creation operation to mint and retain a `ConversationId`
before starting network work. The Client root exposes no other
conversation-protocol identifier.

The public start and turn shapes are:

```ts
interface StartInput {
  readonly conversationId: ConversationId
  readonly peers: NonEmptyReadonlyArray<AgentName>
  readonly content: Content
}

interface HarnessTurn {
  readonly conversationId: ConversationId
  readonly peers: NonEmptyReadonlyArray<VerifiedAgentCard>
  readonly author: VerifiedAgentCard
  readonly content: Content
  readonly reply: (content: Content) => Effect.Effect<void, ReplyError>
}

interface HarnessClient {
  readonly start: (
    input: StartInput,
  ) => Effect.Effect<void, StartError>
  readonly turns: Stream.Stream<HarnessTurn, ListenError>
}

declare function createConversationId():
  Effect.Effect<ConversationId, ConversationIdGenerationError>

declare function acquireHarnessClient(
  endpoint: URL,
): Effect.Effect<HarnessClient, ConnectError, Scope.Scope>
```

`peers` on `StartInput` names the other fixed conversation members. The Client
resolves every name to a verified immutable card, rejects duplicate or local
identity membership, and orders the resulting fixed membership canonically
before protocol traffic. `peers` on `HarnessTurn` is the nonempty immutable
set of verified other-member cards for that same conversation. `author` is the
verified author of the one action represented by the turn.

One `HarnessTurn` contains exactly one current-conversation certified action.
It is not a conversation transcript, universal context snapshot, checkpoint,
page, protocol message, or proof container. Runtime hosts may build broader
session memory from their own observations without enlarging this shared
boundary.

## Start identity and recovery

The caller pre-mints `ConversationId` and supplies it to `start`. That value is
the sole public identity for START and its retries. The Client persists the
canonical START intent before protocol work. The intent consists only of the
resolved fixed peers and initial content under the Client's closed canonical
encoding.

A repeated `start` with the same `ConversationId` and byte-identical canonical
intent resumes or returns the first locally completed outcome. The same
`ConversationId` with different canonical peers or content fails with a typed
intent-conflict error. Interruption, process restart, and an ambiguous caller
observation never authorize a second START for that identifier.

There is no second operation ID, generated attempt token, receipt ID, or
recovery method. A caller that may retry retains the `ConversationId` and the
original input.

## Bound reply

There is no unbound public `HarnessClient.reply` method. A live turn carries a
reply closure accepting `Content` only. The closure captures the private live
grant, legal-action selection, expiry, and retry state and cannot fall forward
to a newer turn.

At most one live reply authority exists for one conversation at one endpoint.
Different conversations may progress independently. Reading history or
retaining a `ConversationId` cannot create a closure. Cross-process reply
recovery is absent: daemon restart, stream loss, or loss of the closure loses
that opportunity, while the certified history remains intact.

## Completion

`start` and bound `reply` return `void` only after the returning endpoint has
durably stored the complete certified record required by
[`../conversation-history.md`](../conversation-history.md). Router acceptance,
an action certificate, partial durability votes, or completion at another
member is not success.

Proofs, receipts, protocol messages, action hashes, record hashes, membership
descriptors, durability evidence, and local store state are not public Client
results. Complete proof and history inspection are explicit loopback MCP
management operations. They do not change the completion meaning and never
create reply authority.

## Receive and subscription

One scoped Client owns one `subscriptions/listen` stream. Establishment
acknowledgment confirms only stream ownership. Delivery of live reply
authority is transient and at most once: there is no application
acknowledgment, subscription replay, resume cursor, `Last-Event-ID`, or
reconstruction after a lost write.

Every emitted item has the exact `HarnessTurn` shape above and is backed by one
complete certified action plus separately live reply authority. Certified
history discovered by normal delivery, catch-up, search, or re-anchor emits
nothing on its own.

## Public boundary

The acquired `HarnessClient` exposes only `start` and `turns`. The Client root
also exposes `createConversationId` and the scoped
`acquireHarnessClient(endpoint: URL)` operation with the exact results above,
closed content values, verified Identity-owned card types, and closed error
types. It exposes no public `Context.Tag`, local `AgentId`, registration,
status, agent search, conversation search, history, proof retrieval, generic
send, unbound reply, Registry/Router client, endpoint key, store handle, raw
MCP session, protocol message, or protocol fold.

Registration, status, search, history, and proof inspection remain MCP-only
management capabilities described in [`../management.md`](../management.md).
An MCP-backed adapter projects START and transient reply tools into the same
typed `HarnessClient` boundary without adding methods.

## Error boundary

`StartError`, `ListenError`, and `ReplyError` are separate closed typed unions.
They preserve distinct caller actions for intent conflict, connection or
representation incompatibility, registration state, identity or membership
failure, unavailable or expired reply authority, local persistence failure,
durability quorum unavailability, Router restart/re-anchor, and definite
refusal or non-completion.

Unknown `Error`, raw MCP/HTTP decoder details, credentials, private grant
keys, action or record hashes, partial signer maps, and internal protocol state
never become public error payloads. An implementation closes each union before
exporting it; it does not use an open extension bag or catch-all public cause.

## Acceptance criteria

- Compile-time architecture rules allow adapters to import Client public
  values only.
- A caller can persist a `ConversationId` before START and retry the identical
  canonical intent after interruption or process restart.
- Changed peers or content under the same `ConversationId` fail closed.
- `start` and bound `reply` return only `void` after complete local certified
  durability.
- One scoped client owns one subscription and releases it with its scope.
- Every emitted turn contains one current-conversation certified action and a
  distinct live authority; history alone emits nothing.
- Bound reply accepts only content and exposes no identifier or raw token as
  runtime authority.
- No generic send, management method, proof/result object, local identity, or
  network-client escape hatch exists on the public Client.
- Public type canaries pin the exact fields and absence laws in this chapter.

## Deliberate deferrals

Cross-process reply recovery, delivery acknowledgment and replay, daemon-wide
queue and concurrency limits, and plural-action payload mapping. The five
Simulator incompatibilities are current removals owned by
[`../layer-interfaces.md`](../layer-interfaces.md#simulator-cutover), not
Client deferrals.
