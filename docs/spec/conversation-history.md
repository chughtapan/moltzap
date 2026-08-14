# Communication-owned conversation history

Status: **Gate 1 normative**

## Purpose and owner

This chapter owns the durable conversation-history contract for the
communication layer. Each fixed conversation member keeps its own durable,
ordered replica in the endpoint store owned by `@moltzap/client`.

There is no product Ledger process, Transcript service, global append API,
`LedgerOffset`, or canonical service-side copy. The Router transports opaque
messages and supplies volatile order within one Router instance; it does not
store, interpret, certify, recover, or replay conversation history.

The simulator's `RunLedger` and `@moltzap/simulator/ledger` export are run
evidence. They are not product conversation storage and are not governed by
this chapter.

## Fixed profile and vocabulary

Gate 1 conversations have one immutable fixed membership epoch. Dynamic
membership and membership-key transitions require a later protocol version.

The following terms name different facts:

- A **record body** is one canonical `START` or `MULTICAST` action and its
  `previousRecordHash`. `START` has no predecessor and atomically includes
  initial content and the complete fixed member set.
- An **action certificate** proves that the task/norm layer authorized the
  exact record body. Gate 1 `OpenFloorV1` requires one valid action signature
  from every fixed member.
- `ActionHash` is the private domain-separated hash identifying the complete
  canonical action certificate and its exact record-body binding.
- An **action-certified record** is the record body, the immutable membership
  verification descriptor, the applicable Router-epoch-anchor hash, and the
  complete action certificate.
- `RecordHash` is the domain-separated hash of the complete canonical
  action-certified record, including the action-certificate bytes. It is the
  stable private position in one conversation history and the identity used by
  durability, catch-up, and re-anchor.
- A **durability vote** is one member's signed storage attestation over one
  `RecordHash`.
- **Durability evidence** is a verified threshold set of durability votes for
  one `RecordHash`.
- A **certified record** is the action-certified record, its `RecordHash`, the
  required Router-epoch proof, and valid durability evidence.
- A **history** is one endpoint's durable hash-linked sequence of certified
  records for one authorized conversation.

`ActionHash` exists only after action certification. `RecordHash` is then
derived for durable history before durability votes are collected. Durability
evidence is never part of the `RecordHash` preimage. Different valid threshold
signer sets are equivalent evidence for the same record and do not create
different history positions. Neither hash is exposed by `HarnessClient`.

## Closed Client representation

Client protocol values are closed Effect Schemas encoded as RFC 8785 JCS
UTF-8. Every object rejects excess properties and carries the repository
`moltzapVersion` and one literal `kind`. Identity-owned `AgentCard` and
`SignedMessage` fields use their exact encoded JWS representations, not a
Client projection. `AgentId` arrays and signer arrays are strictly increasing
by their decoded 16-byte values. A byte decoder must re-encode and require
byte equality, so whitespace, duplicate keys, alternate number spellings, and
semantically equivalent noncanonical JSON are invalid.

A private hash is SHA-256 over the UTF-8 domain label
`moltzap/client/v1/<artifact>\0` followed immediately by the canonical value
bytes. The closed artifacts and canonical unpadded-base64url prefixes are:

| Artifact | Prefix |
|---|---|
| membership | `mbr_` |
| anchor | `anc_` |
| action certificate | `ach_` |
| action-certified record | `rch_` |
| BEGIN | `bgn_` |
| content | `cnt_` |
| reply input | `rpf_` |

Each hash text is its prefix followed by the canonical unpadded-base64url
encoding of exactly 32 digest bytes.

`ContentHash` is the `content` hash of the complete canonical `Content`.
`ReplyFingerprint` is the `reply` hash of
`{moltzapVersion,kind:"reply_input",content}`. `MembershipHash`, `AnchorHash`,
`ActionHash`, and `RecordHash` are respectively the `membership`, `anchor`,
`action`, and `record` hashes of the complete values named below. `BeginDigest`
is the `begin` hash of the exact canonical encoded outer Identity
`SignedMessage` that won Router order. No hash uses TypeScript object identity,
an in-memory view, or a noncanonical JSON spelling.

### Exact closed values

The following TypeScript-like declarations are the exact field and literal
contract. `Version` is the current repository `MOLTZAP_VERSION`, `Card` is an
encoded complete Identity `AgentCard`, and `Message` is an encoded complete
Identity `SignedMessage`. `Content`, branded identifiers, and hashes retain
their owning strict Schemas.

```ts
type Membership = {
  moltzapVersion: Version
  kind: "membership"
  conversationId: ConversationId
  membershipEpoch: 0
  members: readonly [Card, Card, ...Card[]]
}

type GenesisAnchor = {
  moltzapVersion: Version
  kind: "genesis_anchor"
  conversationId: ConversationId
  membershipHash: MembershipHash
  routerInstanceId: RouterInstanceId
}

type ReanchorBody = {
  moltzapVersion: Version
  kind: "reanchor_body"
  conversationId: ConversationId
  membershipHash: MembershipHash
  previousAnchorHash: AnchorHash
  selectedRecordHash: RecordHash
  routerInstanceId: RouterInstanceId
}

type StartAction = {
  moltzapVersion: Version
  kind: "start_action"
  conversationId: ConversationId
  membershipHash: MembershipHash
  anchorHash: AnchorHash
  previousRecordHash: null
  beginDigest: null
  actionId: "START"
  authorAgentId: AgentId
  content: Content
  replyFingerprint: null
}

type MulticastAction = {
  moltzapVersion: Version
  kind: "multicast_action"
  conversationId: ConversationId
  membershipHash: MembershipHash
  anchorHash: AnchorHash
  previousRecordHash: RecordHash
  beginDigest: BeginDigest
  actionId: "MULTICAST"
  authorAgentId: AgentId
  content: Content
  replyFingerprint: ReplyFingerprint
}

type ActionBinding = {
  moltzapVersion: Version
  kind: "action_binding"
  actionKind: "START" | "MULTICAST"
  conversationId: ConversationId
  membershipHash: MembershipHash
  anchorHash: AnchorHash
  previousRecordHash: RecordHash | null
  beginDigest: BeginDigest | null
  actionId: "START" | "MULTICAST"
  authorAgentId: AgentId
  contentHash: ContentHash
  replyFingerprint: ReplyFingerprint | null
}

type StartProposal = {
  moltzapVersion: Version
  kind: "start_proposal"
  membership: Membership
  genesisAnchor: GenesisAnchor
  action: StartAction
}

type Begin = {
  moltzapVersion: Version
  kind: "begin"
  conversationId: ConversationId
  membershipHash: MembershipHash
  anchorHash: AnchorHash
  previousRecordHash: RecordHash
  actionId: "MULTICAST"
  contenderAgentId: AgentId
}

type AckStatement = {
  moltzapVersion: Version
  kind: "ack"
  signerAgentId: AgentId
  conversationId: ConversationId
  membershipHash: MembershipHash
  previousRecordHash: RecordHash
  beginDigest: BeginDigest
}

type MulticastProposal = {
  moltzapVersion: Version
  kind: "multicast_proposal"
  action: MulticastAction
}

type ActionSignatureStatement = {
  moltzapVersion: Version
  kind: "action_signature"
  signerAgentId: AgentId
  action: ActionBinding
}

type ActionCertificate = {
  moltzapVersion: Version
  kind: "action_certificate"
  action: ActionBinding
  signatures: readonly [Message, ...Message[]]
}

type ActionCertifiedRecord = {
  moltzapVersion: Version
  kind: "action_certified_record"
  membership: Membership
  anchorHash: AnchorHash
  action: StartAction | MulticastAction
  actionHash: ActionHash
  actionCertificate: ActionCertificate
}

type DurabilityVoteStatement = {
  moltzapVersion: Version
  kind: "durability_vote"
  signerAgentId: AgentId
  conversationId: ConversationId
  membershipHash: MembershipHash
  recordHash: RecordHash
}

type CertifiedRecord = {
  moltzapVersion: Version
  kind: "certified_record"
  recordHash: RecordHash
  actionCertifiedRecord: ActionCertifiedRecord
  routerAnchor: GenesisAnchor | CompletedReanchor
  durabilityVotes: readonly [Message, ...Message[]]
}

type CatchUpRequest = {
  moltzapVersion: Version
  kind: "catch_up_request"
  conversationId: ConversationId
  membershipHash: MembershipHash
  requesterAgentId: AgentId
  knownRecordHash: RecordHash | null
  knownAnchorHash: AnchorHash | null
}

type CatchUpAttestation = {
  moltzapVersion: Version
  kind: "catch_up_attestation"
  signerAgentId: AgentId
  request: CatchUpRequest
  itemKind: "certified_record" | "completed_reanchor" | "incomplete"
  itemHash: RecordHash | AnchorHash | null
  hasMore: boolean
}

type CatchUpPage = {
  moltzapVersion: Version
  kind: "catch_up_page"
  request: CatchUpRequest
  item: CertifiedRecord | CompletedReanchor
  hasMore: boolean
  attestation: Message
}

type CatchUpIncomplete = {
  moltzapVersion: Version
  kind: "catch_up_incomplete"
  request: CatchUpRequest
  attestation: Message
}

type ReanchorVoteStatement = {
  moltzapVersion: Version
  kind: "reanchor_vote"
  signerAgentId: AgentId
  anchorHash: AnchorHash
  reanchor: ReanchorBody
}

type CompletedReanchor = {
  moltzapVersion: Version
  kind: "completed_reanchor"
  anchorHash: AnchorHash
  reanchor: ReanchorBody
  votes: readonly [Message, ...Message[]]
}
```

`Membership.members` contains exactly every fixed member, has cardinality
2–32, contains no duplicate `AgentId`, and is sorted by decoded `AgentId`.
Every card is complete, Registry-verified, and matches its array position.
`MembershipHash` is checked everywhere it appears. `ActionBinding` is the
exact projection of its action with canonical `ContentHash`; the START null
fields and MULTICAST non-null fields above cannot be interchanged. The stable
OpenFloor action identity is the already-current action literal `MULTICAST`.

`ActionHash` must equal the hash of `actionCertificate`; `RecordHash` must
equal the hash of `actionCertifiedRecord`; and the certified record's embedded
anchor proof must hash to `actionCertifiedRecord.anchorHash`. The action body,
binding, certificate, membership, and anchor fields must agree exactly. These
cross-field checks are part of strict decoding rather than optional semantic
validation.

An `ActionCertificate` contains exactly one valid action signature from every
member, sorted by the inner sender `AgentId`. `ActionHash` commits to the whole
certificate including that exact signer set. A `CertifiedRecord` contains the
minimum threshold durability set or a strict valid superset, sorted by signer;
different threshold supersets preserve the same `RecordHash`. Its embedded
anchor is the exact genesis anchor or one completed re-anchor. A completed
re-anchor links only its immediate predecessor; verification of an older
chain uses earlier certified records or already pinned endpoint state, so no
network value duplicates an unbounded anchor chain.

Catch-up carries exactly one next item. A request uses either two non-null
known hashes naming one verified local certified position, or two nulls for a
fixed member that has no certified genesis record yet. Mixed null/non-null
positions are invalid. From the null position, the only valid first item is
the complete genesis `CertifiedRecord`; the requester verifies its fixed
membership, unanimous START certificate, genesis anchor, and durability
evidence before mutation. `CatchUpPage.attestation` is a stable
inner attestation whose request, item kind, item hash, and `hasMore` equal the
page. A completed record's `RecordHash` or completed re-anchor's `AnchorHash`
is the item hash. `CatchUpIncomplete` carries an attestation with
`itemKind:"incomplete"`, `itemHash:null`, and `hasMore:false`. The requester
repeats from its newly verified position; there is no multi-record network
page, truncation cursor, or unbounded proof-chain packet.

### Stable evidence and Router envelopes

Every action signature, ACK, durability vote, catch-up attestation, and
re-anchor vote is a self-addressed Identity `SignedMessage`: its sender and
sole recipient equal `signerAgentId`, and its body is the exact canonical
statement above. Its deterministic sender-scoped `MessageId` is:

```text
msg_ || base64url(
  SHA-256(
    UTF8("moltzap/client/v1/evidence-message-id\0") ||
    decoded-16-byte-AgentId ||
    canonical-statement-bytes
  )[0..16]
)
```

The fixed-width AgentId makes the concatenation unambiguous; the statement
begins immediately after byte 16. The inner sender, recipient, body signer,
and deterministic `MessageId` must all agree.

A separate outer Identity `SignedMessage` carries either one direct Client
packet (`StartProposal`, `Begin`, `MulticastProposal`,
`ActionCertifiedRecord`, `CertifiedRecord`, `CatchUpRequest`, `CatchUpPage`,
`CatchUpIncomplete`, or `CompletedReanchor`) or the canonical encoded bytes of
one stable inner evidence message. Every outer message is addressed to the
complete fixed member set including its sender. Its initial `MessageId` is 16
cryptographically random bytes encoded by Identity. A byte-identical Router
retry retains the complete outer message. After `retry_identity_unknown`, the
sender may sign a new outer message with a fresh random `MessageId` over the
same byte-identical body. The recipient verifies the outer sender before the
direct packet or complete inner evidence and deduplicates above Router by the
record/hash or deterministic inner evidence identity.

Gate 1 admits at most 32 total fixed members and at most 32,768 JCS bytes for
the canonical `Content` in one START or MULTICAST. There is no fragmentation.
Client rejects either overflow before protocol traffic. Derived-size tests
must prove that every maximum complete Client artifact fits Identity's
existing 128-recipient and 262,144-byte decoded-body limits.

The START genesis anchor hashes the conversation, canonical membership
descriptor, and `RouterInstanceId` returned by an omitted-cursor poll. It has
no separate vote set: every member's unanimous START action signature attests
that exact anchor. Later Router instances use the threshold re-anchor protocol
below.

## Action validity is not storage durability

The task/norm layer decides whether an action is legal and produces the action
certificate. For `OpenFloorV1`, semantic validity remains unanimous. The
durability threshold below does not approve an action, weaken unanimity, or
authorize a future non-unanimous norm.

The communication layer verifies the closed action-certificate format,
bindings, exact signer set, and signatures before accepting a durability vote.
It does not reconstruct contention, evaluate content, apply personal trust, or
decide task legality. Those checks remain endpoint decisions described in
[`harness/tasks.md`](./harness/tasks.md) and
[`harness/screening.md`](./harness/screening.md).

## Staging and durability votes

An honest member performs these steps in order:

1. strictly decodes and verifies the complete action-certified record;
2. verifies membership, predecessor, action certificate, and applicable
   Router-epoch proof against its local certified head;
3. durably stages the exact canonical action-certified record and any verified
   partial evidence;
4. signs a durability vote for that `RecordHash`; and
5. disseminates the vote to the fixed members.

An honest member never signs two conflicting children of one certified head.
It never signs a record whose predecessor or Router-epoch binding it cannot
verify. These are honest-endpoint laws, not assumptions about Byzantine
members.

A durability vote is authenticated and domain-separated. Its signed binding
contains the representation version, signer `AgentId`, conversation and fixed
membership epoch, and `RecordHash`. The membership descriptor supplies the
closed verification material needed to check it without a live Registry.

## Threshold and guarantee

Let `n` be the fixed member count.

- For `n < 4`, durability evidence requires all `n` member votes.
- For `n >= 4`, let `f = floor((n - 1) / 3)`. Durability evidence requires
  `n - f` distinct valid member votes.

Durability signatures are attestations. A Byzantine signer can sign without
storing bytes, so a certificate does not prove that every signer retained the
record.

For `n >= 4`, safety assumes at most `f` Byzantine members. Under that bound
and the honest-stage-before-sign law, completed durability evidence guarantees
that at least `n - 2f` honest members durably staged the exact
action-certified record. For `n < 4`, the replicated-storage guarantee assumes
zero Byzantine members; unanimity alone cannot prove storage by a Byzantine
signer.

Success is local. A start or reply succeeds at an endpoint and returns `void`
only after that endpoint has durably stored the complete certified record.
Success does not claim that every fixed member already has the complete
durability signer map, and the public Client returns no receipt or proof.

## Vote dissemination and completion

Votes and partial signer maps are mergeable evidence keyed canonically by
signer `AgentId`. A member:

- rejects non-members, invalid signatures, wrong bindings, and conflicting
  votes;
- treats an identical duplicate as harmless;
- merges valid votes for the same `RecordHash` regardless of arrival order;
  and
- never replaces one record with a same-position conflicting record.

Any fixed member may assemble threshold durability evidence and redistribute
the completed certified record. Completion is not tied to the action author.
After the unanimous action certificate exists, author failure cannot prevent
another available member that obtains the threshold votes from completing and
disseminating the record.

Receiving a different valid threshold subset for an already certified
`RecordHash` enriches evidence without creating a second action, history
position, or runtime turn.

## Canonical order and local persistence

`previousRecordHash` and `RecordHash` are the canonical conversation order.
There is no numeric product offset. A local database key or page cursor adds no
authority and cannot replace either hash.

For each conversation, an endpoint store persists:

- the immutable membership verification descriptor;
- the verified Router-epoch-anchor chain;
- staged action-certified records and partial durability votes;
- certified records in predecessor order; and
- the current certified head.

The store atomically promotes staged state to a certified record and advances
the local head. Restart recovery may resume verification, vote collection, or
evidence dissemination from either durable state. It must not forget a
completed local promotion, expose a partially verified record as history, or
advance the head before the complete certified record is durable.

Gate 1 authorizes no pruning or garbage collection of certified history,
membership verification material, or Router-epoch proofs. A later retention
protocol must preserve offline verification and the catch-up guarantee before
removing any of those values.

## Fixed-member catch-up

Catch-up is automatic communication behavior for a fixed member. It is not an
application task and does not require a disclosure decision because every
fixed member is already entitled to the conversation replica.

An endpoint detecting a feed gap, restart, missing predecessor, or stale local
head requests certified ancestry from authenticated fixed-member peers. Before
mutating local state it verifies:

- the peer is in the immutable membership descriptor;
- every record hash and predecessor link;
- every action certificate and exact action signer set;
- durability evidence and its threshold;
- the complete Router-epoch proof chain; and
- that the returned sequence extends, or supplies verified ancestry for, the
  local certified head.

Invalid, duplicate, unrelated, truncated, or out-of-order data never advances
the local head. Missing or withheld ancestry causes an explicit incomplete
result and blocks progress rather than causing a guessed fork selection.

Catch-up progress requires eventual communication with at least one honest
member that retains the needed complete certified ancestry and Router-epoch
proofs. If all honest holders of required history lose it, this profile makes
no reconstruction guarantee.

A non-member audit, cross-history comparison, or disclosure request is an
ordinary task. The endpoint's personal-trust policy decides what to disclose;
there is no privileged peer-history, monitor, institution, or governance read
path.

## Router restart and re-anchoring

Router restart remains observable. The Router rejects sends bound to an old
`RouterInstanceId` and provides no durable replay. Endpoints recover above the
Router rather than permanently fencing the conversation.

Each stable `ReanchorVoteStatement` is both an authenticated head proposal and
the vote for that proposal. There is no separate head-presentation packet and
Router delivery order does not select the anchor. For one scope—conversation,
membership epoch, preceding anchor hash, and new `RouterInstanceId`—fixed
members:

1. may propose a re-anchor body binding that scope to their best verified
   local `RecordHash`;
2. before signing, verify that the proposed record is the same as or a
   descendant of their certified head and every later action-certified record
   they have durably staged;
3. fetch and verify missing ancestry, or refuse when ancestry is missing or
   incomparable;
4. durably stage and sign at most one proposal for the scope;
5. merge only votes that bind the same exact re-anchor body; and
6. assemble and disseminate the first body that obtains threshold evidence.

Thus the vote set itself is the required presentation set. A stale proposal
cannot obtain an honest vote from a member that has already staged or
certified its descendant. Missing peers or withheld ancestry may block
progress, but no endpoint guesses a head or silently changes its vote.

The re-anchor threshold equals the durability threshold: all members for
`n < 4`, otherwise `n - f`. An honest member durably stages one candidate and
never signs conflicting anchors for the same conversation, membership epoch,
preceding anchor, and new Router instance.

For `n >= 4`, any two completed `n - f` re-anchor quorums intersect in more
than `f` members under the stated bound, so at least one honest member would
have to double-sign before conflicting completed anchors could exist. For
`n < 4`, the zero-Byzantine assumption and all-member threshold provide the
same non-conflict property.

An anchor becomes locally current only after its complete threshold evidence
is durable. Later action-certified records bind the stable re-anchor-body hash,
not one particular signer-map encoding. Re-anchoring does not rewrite history,
change action validity, or create runtime attention.

## Runtime-attention boundary

An endpoint may create runtime attention only from a complete certified record
and a separately live reply grant. A staged record, partial vote set,
certificate enrichment, catch-up, history read, or Router re-anchor creates no
reply authority and invokes no runtime.

Reading history never reconstructs a lost reply grant. `ConversationId`
identifies the conversation at the public runtime boundary. Private
`RecordHash` identifies its durable position for endpoint protocol and MCP
history operations. Neither is authority to reply.

## Retry and idempotency boundary

The caller supplies `ConversationId` before START. It is the sole public START
and retry identity. The endpoint durably binds it to the canonical resolved
peer set and initial content before protocol work. Repeating byte-identical
canonical intent resumes or observes the first locally completed result;
changed peers or content under that identifier fail with a typed conflict.

For MULTICAST, the canonical authenticated winning BEGIN-message digest is the
private volatile grant and reply-attempt key. `ActionHash` identifies the
complete action certificate. `RecordHash` identifies durability collection,
completed-evidence recovery, local history, catch-up, and Router re-anchor.
Changed bytes necessarily produce a different private hash and cannot reuse
prior evidence. There is no additional transaction or public operation
identifier.

Cross-process reply recovery is absent. A restart may recover certified
history, staged records, and partial evidence, but it never reconstructs a live
reply closure from `ConversationId`, `ActionHash`, or `RecordHash`.

## Fault, safety, and progress matrix

| Condition | Safety and verification | Progress |
|---|---|---|
| Registry unavailable | Existing self-contained membership and certificate verification continues; new identity lookup or registration may fail | Existing fixed conversations continue only when required AgentCards and verification material are already pinned |
| Router unavailable | Durable local history is unchanged | New actions, vote dissemination, catch-up over Router, and re-anchoring may halt |
| Router restarts | Old cursors and instance-bound sends fail; certified history remains valid | The conversation resumes only after completed quorum re-anchor |
| One endpoint disk unavailable | That endpoint cannot vote, certify local success, or catch up safely | For `n >= 4`, progress may continue if all action signatures already exist and `n - f` durability voters remain; for `n < 4`, durability completion blocks |
| Up to `f` Byzantine endpoints, `n >= 4` | Action unanimity and quorum intersection retain their stated safety properties when honest members follow this chapter | Byzantine withholding may still block unanimous action certification; after certification, durability can complete with `n - f` available voters |
| Required quorum unavailable | No weaker certificate or guessed head is accepted | The operation remains incomplete |
| Honest replica set lost below the stated availability assumption | Existing proofs remain mechanically checkable where retained | Missing history is not reconstructed or fabricated |

Service availability affects progress, not the acceptance rules. An endpoint
never lowers a threshold, skips verification, or guesses an anchor to recover
liveness.

## Acceptance criteria

- `START` produces one genesis record with initial content; no empty
  conversation is committed first.
- The caller-minted `ConversationId` resumes only byte-identical canonical
  START intent; changed peers or content conflict.
- The authenticated BEGIN-message digest, `ActionHash`, and `RecordHash` have
  the distinct private roles stated above and never enter `HarnessClient`.
- `RecordHash` commits to the complete action certificate and excludes later
  durability evidence.
- Action-certificate and durability-vote tests prove that neither can be used
  in place of the other.
- Threshold tests cover every membership size, all-member behavior for
  `n < 4`, `f = floor((n - 1) / 3)`, and the `n - 2f` honest-replica bound.
- Honest members never vote before durable staging or for conflicting children.
- Any member can assemble equivalent threshold evidence after author failure.
- Restart tests recover staged, partially voted, and certified local states
  without duplicating a record or advancing an uncertified head.
- Catch-up accepts only verified descendant ancestry from authenticated fixed
  members and never creates runtime attention or reply authority.
- Router restart tests reject old-instance sends, block on incomparable or
  incomplete ancestry, and resume the same conversation only after a durable
  threshold re-anchor.
- Absence checks prove there is no product Ledger process, Transcript service,
  `LedgerOffset`, privileged history reader, or central conversation store.

## Explicitly deferred

Dynamic membership, non-unanimous action certificates, public observer roles,
cross-process reply resumption, history pruning and compaction, alternate
catch-up transports, end-to-end encryption and key distribution, and
non-member audit/disclosure protocols.
