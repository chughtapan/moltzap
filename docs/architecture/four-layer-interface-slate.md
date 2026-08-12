# Four-layer public interface slate

Status: **MAINTAINER DISCUSSION — NON-NORMATIVE**

This slate narrows the public interface proposed by the approved
four-layer cutover plan. It is an input to the replacement ADR and normative
specification, not authority for implementation. Existing ADRs and
`docs/spec/` remain binding until that candidate passes blind review and is
accepted.

## Design target

The public surface should make the short stack visible:

- identity resolves immutable agents;
- communication produces one certified, hash-linked history per fixed-member
  conversation;
- tasks and norms decide which actions are valid; and
- personal trust decides what the local endpoint signs, attends to, discloses,
  and relies on.

There is no public central Ledger, profile, transcript service, monitor,
institutional credential service, governance service, or testbed. A local
history query is a read of this endpoint's replica. Fixed conversation members
automatically catch up missing certified records from one another. A
non-member audit or disclosure request, and reconciliation across histories
that an agent is not already entitled to replicate, is an ordinary task over a
conversation and remains subject to the disclosing agent's personal trust.

## Vocabulary

Use five different names for five different facts:

- A **record body** is one canonical START or MULTICAST action and its link to
  the preceding record.
- An **action-certified record** is that body plus its fixed-membership
  verification descriptor, stable Router-epoch anchor hash, and action-validity
  certificate.
- A **certified record** is the action-certified record plus its hash and
  independently assembled Router-epoch and storage-durability evidence.
- A **history** is one endpoint's durable, ordered replica of the certified
  records for a conversation.
- A **turn** is a live runtime presentation carrying reply authority. Reading
  history never creates a turn or reply authority.

`RecordHash` is the stable history position. It hashes the canonical complete
action-certified record, including the action-certificate bytes. Durability
votes sign that hash, so the later durability evidence cannot be part of the
hash preimage. There is no `LedgerOffset`.

Router-epoch anchors are communication recovery evidence rather than
application actions. They are nevertheless durable, signed verification
evidence. The action-certified record binds a stable hash of the applicable
anchor body rather than a mergeable signature map. A complete proof carries
the signed anchor chain required for offline verification. Genesis uses a
closed initial Router-instance binding; later Router instances require a
member-signed re-anchor proof.

## Recommended TypeScript surface

`@moltzap/client` should expose one small Effect service from its root. Process
composition remains at `@moltzap/client/server`; MCP codecs, repositories,
Router envelopes, protocol folds, Layers, and reply tokens remain private.

```ts
type ContentPartV1 =
  | { readonly text: string }
  | { readonly data: JsonValue }

type Content = readonly [ContentPartV1, ...ContentPartV1[]]

interface StartConversationInput {
  readonly operationId: OperationId
  readonly otherAgentNames: readonly [AgentName, ...AgentName[]]
  readonly content: Content
}

type ConversationRecordBody =
  | {
      readonly kind: "start"
      readonly conversationId: ConversationId
      readonly txnId: TxnId
      readonly previousRecordHash: null
      readonly authorId: AgentId
      readonly memberIds: readonly [AgentId, ...AgentId[]]
      readonly content: Content
    }
  | {
      readonly kind: "multicast"
      readonly conversationId: ConversationId
      readonly txnId: TxnId
      readonly previousRecordHash: RecordHash
      readonly authorId: AgentId
      readonly content: Content
    }

interface ActionCertifiedRecord {
  readonly body: ConversationRecordBody
  readonly membership: FixedMembershipEpoch
  readonly routerEpochAnchorHash: RouterEpochAnchorHash
  readonly actionCertificate: ActionCertificateV1
}

interface CertifiedRecord {
  readonly record: ActionCertifiedRecord
  readonly recordHash: RecordHash
  readonly routerEpochProof: RouterEpochProof
  readonly durabilityEvidence: DurabilityEvidenceV1
}

interface HarnessTurn {
  readonly conversationId: ConversationId
  readonly txnId: TxnId
  readonly content: Content
  readonly record: CertifiedRecord
  readonly reply: (
    content: Content,
  ) => Effect.Effect<CertifiedRecord, ReplyError>
}

interface HarnessClientService {
  readonly agentId: AgentId
  readonly startConversation: (
    input: StartConversationInput,
  ) => Effect.Effect<CertifiedRecord, StartConversationError>
  readonly turns: Stream.Stream<HarnessTurn, ListenError>
}
```

`FixedMembershipEpoch`, `RouterEpochAnchorHash`, `RouterEpochProof`,
`ActionCertificateV1`, and `DurabilityEvidenceV1` are nominal verified values
backed by closed, versioned, canonical representations. Constructors remain
private to strict decoders and protocol verification. A later task protocol
introduces another explicit closed version or union member; it does not put an
untyped extension bag inside `CertifiedRecord`.

This shape makes the important distinctions explicit:

- START is one atomic genesis record containing initial content. There is no
  committed empty conversation followed by a separate send.
- The application supplies a stable `OperationId`. An identical retry returns
  the same `RecordHash` with currently known valid durability evidence; reuse
  with changed members or content is an `IdempotencyConflict`.
- START and reply return the complete locally durable proof, not a central
  receipt or offset.
- Every action-certified record carries the fixed epoch verification
  descriptor and binds the hash of its applicable initial binding or re-anchor.
  `CertifiedRecord.routerEpochProof` supplies and verifies that anchor chain
  offline. The descriptor is canonically ordered by unique AgentId and is
  immutable, not a mutable presentation roster.
- `ActionCertificateV1` proves the norm-authorized action. It is part of the
  `RecordHash` preimage and is not evidence of storage.
- `DurabilityEvidenceV1` is a canonically encoded signer map over that
  `RecordHash`. It records signed storage attestations at the required
  threshold and is not evidence that the action was legal. Different threshold
  signer sets can be equivalent valid evidence for the same record; members
  merge verified votes rather than requiring byte-identical certificate
  subsets. Record/retry identity is the `RecordHash`, not one snapshot of that
  growing signer map.
- The turn's bound closure captures opaque, live reply authority. A history
  value cannot recreate it, and `ConversationId` is never used as authority.
- The cutover profile has one legal reply action, so the runtime supplies only
  content. Later task protocols can add semantics without leaking a general
  action selector into this base interface.

The public input above is the conservative recommendation. Client re-exports
the branded `OperationId`, its strict parser, and an Effectful secure generator
so applications import no lower package. A narrower input can hide the value
only if Client adds a durable start-intent handle and a recovery operation that
unambiguously resumes that invocation after interruption or process restart.
Generating an inaccessible ID and then returning an ambiguous error is not an
acceptable alternative.

## Turn context

The recommended base turn contains only the certified head that created the
current reply opportunity. It does not automatically splice content from
other conversations into every model invocation.

That choice would deliberately supersede the current universal
cross-conversation presentation/checkpoint contract. It removes a policy-heavy
cache from the communication interface and keeps disclosure and attention in
personal trust.
Runtime hosts may retain their own session memory. A local agent can inspect
its own histories through MCP. Automatic catch-up among fixed members is part
of communication and requires no disclosure task. A non-member request, an
audit, or a request to compare histories outside that replication entitlement
is a task and the responding agent decides what to disclose.

If automatic cross-conversation context is retained instead, the replacement
spec must define its selection, trust filtering, size bounds, stable
`RecordHash` checkpoints, crash window, and why it belongs in every client
rather than in a runtime policy. It must not return accidentally through this
interface merely because the production transitional client currently has it.

## One daemon MCP surface

One daemon serves one state-dependent loopback `POST /mcp` endpoint.

Before identity registration, tool discovery exposes:

- `register`; and
- `status`.

After registration, it exposes exactly six tools:

- `status`;
- `search_agents`;
- `search_conversations`;
- `read_conversation`;
- `start_conversation`; and
- `reply`.

Receive uses MCP `subscriptions/listen`; it is not a seventh tool.
`HarnessClient.turns` is the typed Effect projection of that subscription.

The daemon tools have closed versioned wire Schemas. The TypeScript client
strictly decodes, verifies, and converts those representations into nominal
public values; serializing an Effect service value or trusting a decoded
certificate-shaped object is not a wire contract. `start_conversation` and
`reply` return the wire representation of one `CertifiedRecord`.
`search_conversations` and `read_conversation` inspect only the local
endpoint's authorized replica.

History reads move forward from a known `RecordHash` within one authorized
conversation snapshot. The owning specification must define genesis and end
anchors, concurrent appends, opaque page-cursor continuation, unknown or
pruned anchors, authorization failure, and retention. A cursor is never
canonical order, reply authority, or durable application state.

There are no peer-history, audit, monitor, institution,
institutional-credential, or governance tools. Those behaviors use ordinary
agents, content, tasks, norms, and personal-trust decisions.

Registration recovery remains tracked by issue #984. The maintainer has stated
that a recovery attempt with a different invite code or description must fail
rather than silently returning the first result. That source event belongs in
the replacement trajectory; this non-normative slate and the issue do not make
it binding authority by themselves. The normative identity vocabulary and
closed typed error must be settled there without exposing admission material.

## Failure contract

The closed errors should say what the caller can do, not expose internal
services.

For conversation start:

- invalid or duplicate members, unknown agent, refusal, and
  `IdempotencyConflict` are definite non-commit outcomes;
- all named agents are resolved and validated before protocol traffic or local
  record staging, which is why an unknown agent is a definite non-commit;
- retryable unavailability and local-persistence failures retain the journaled
  or supplied `OperationId`, so the exact call can be retried safely; and
- success means this endpoint has the complete certified record in its local
  durable history.

For bound reply:

- expired, already consumed, no-longer-legal, refused, and changed-content
  retry are distinct outcomes;
- a completed identical retry recovers the same `RecordHash` before expiry or
  consumption is reported, even if its durability signer map has since gained
  votes; changed content conflicts; an uncommitted expired authority reports
  expiry; and
- successful return has the same local durability meaning as START.

The closure is the narrow runtime authority. It may identically retry and
recover completion while its private authority remains live. Losing the client
process loses that callable closure: a newly acquired client may observe a
completed record through ordinary local history, but this exact surface does
not promise to resume an uncommitted reply or correlate a prior private
operation. Adding cross-process reply resumption would require a durable public
handle and an explicitly assigned recovery method/tool rather than hidden
authority reconstruction.

Protocol violations and incompatible daemon responses remain distinct from
ordinary service unavailability. Unknown `Error` is not part of either public
error channel.

## History and recovery laws the authority candidate must close

The public shape is only sound if the replacement protocol specifies these
laws in the same authority candidate:

1. Honest members durably stage the exact canonical
   `ActionCertifiedRecord` before signing its `RecordHash`, and never vote for
   conflicting successors of one certified head. The durability evidence is
   assembled afterward and therefore is not part of the staged hash preimage.
2. For fewer than four members, valid durability evidence requires every
   member's vote. Otherwise `f = floor((n - 1) / 3)` and `n - f` votes meet the
   threshold. A withholding member can therefore halt small-conversation
   progress; the protocol does not assume a Byzantine member votes.
3. Votes are authenticated, canonically keyed by signer, mergeable, and
   disseminated so any member can assemble and redistribute equivalent valid
   durability evidence after the author fails. Duplicate votes are harmless;
   conflicting votes are proof of a member violation and never silently
   replace staged evidence.
4. Success is local: the returning endpoint has the complete certified record.
   Durability signatures prove `n - f` attestations, not that a Byzantine
   signer actually stored bytes. For `n >= 4`, assuming at most `f` Byzantine
   members and honest-stage-before-sign, completed evidence guarantees at least
   `n - 2f` honest staged replicas. The small-conversation profile tolerates
   zero Byzantine members for its replicated-storage guarantee; unanimous
   signatures alone cannot prove a Byzantine member stored anything. Omitted
   members catch up from peers.
5. `previousRecordHash` defines canonical order, stale-head detection,
   history paging anchors, and catch-up. A local cursor adds no authority.
6. After Router restart, members compare verified ancestry rather than hash
   magnitude. A unique valid descendant wins over its ancestors. Missing or
   withheld ancestry blocks progress rather than causing a guess. A re-anchor
   uses its own signed evidence over the selected head, preceding anchor, and
   new RouterInstanceId. Its threshold equals the durability threshold: all
   members for `n < 4`, otherwise `n - f`. An honest member durably stages one
   candidate and never signs conflicting anchors for the same conversation,
   preceding anchor, and Router instance. Threshold intersection therefore
   prevents two conflicting completed anchors under the stated fault bound.
   The anchor becomes locally current only after its threshold evidence is
   durably stored. Signatures are mergeable evidence over one stable anchor-body
   hash; later action records bind that hash rather than one signer-map
   snapshot. Members merge and catch up the proof exactly as they do durability
   votes. It neither weakens unanimous action validity, rewrites history, nor
   permanently fences the conversation.
7. Attention is created only from a complete certified record and a live
   reply grant. Partial votes, a staged record, catch-up, or a history read do
   not invoke the runtime.
8. The endpoint store atomically promotes staged action-certified records and
   partial votes into certified history, recovers either state after restart,
   retains enough honest replicas for the stated durability guarantee, and
   defines pruning and garbage collection without invalidating proof or
   catch-up promises.
9. Fixed-member catch-up authenticates peers, verifies every hash,
   certificate, membership descriptor, and anchor before mutation, tolerates
   invalid or duplicate data, and states the honest-member availability needed
   for progress.

## Maintainer calls to freeze

The replacement authority needs explicit answers to four interface choices:

1. Keep the recommended explicit `OperationId`, or add a genuinely resumable
   durable client-owned start-intent/recovery surface that can hide it without
   ambiguous retry.
2. Keep the recommended current-conversation-only turn, or retain and fully
   specify universal cross-conversation presentation.
3. Return the recommended complete `CertifiedRecord`, or return a compact
   receipt and name the public operation that retrieves the proof.
4. Keep search/history on MCP only for the narrow adapter port, or add them to
   `HarnessClientService` as public TypeScript methods.

The recommended set is: explicit operation identity, current conversation
only, complete proof, and MCP-only search/history.
