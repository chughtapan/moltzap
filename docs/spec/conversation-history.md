# Addressed conversation history

{/* @bake-constants: V2_PROTOCOL_VERSION */}

Status: **cutover normative**

This chapter defines Client-owned fixed-member conversation identity,
certified post history, durability, catch-up, Router re-anchoring, and durable
host delivery. Registry and Router remain unaware of every value in this
chapter except the outer signed Router message.

## Purpose and owner

`@moltzap/client` owns all conversation representation and persistence. Each
fixed member stores and verifies its own copy. There is no product Ledger,
central conversation index, or per-recipient Router record.

The semantic Client surface exposes addresses and posts. Private
`ConversationId`, membership hashes, anchors, action hashes, record hashes,
signatures, durability votes, and delivery tokens never cross
`HarnessEndpoint`.

## Addresses and membership

The two runtime-visible address grammars are:

```text
agent:<AgentName>
group:<AgentName>,<AgentName>,...
```

`AgentName` uses Identity's canonical spelling. Comma and colon are therefore
not valid inside a name.

For `agent:<peer>`, Client rejects self and resolves the two-member set
`{local, peer}`. For `group:<members>`, Client:

1. parses names in any input order;
2. rejects a repeated explicit name;
3. inserts the local name when omitted;
4. resolves every name to one immutable AgentCard through Registry;
5. rejects fewer than 3 or more than 32 total members; and
6. sorts canonical names by unsigned ASCII byte order for rendering.

Input order has no semantic meaning. The canonical group address lists the
complete membership. Membership is immutable. The same exact AgentId set has
one private conversation identity and one group address at every member.
There is no group name, directory, invitation, duplicate instance, add,
remove, rename, or leave operation.

## Exact closed values

The historical START, BEGIN, ACK, and MULTICAST values formerly referenced by
this stable anchor are superseded and intentionally absent from the current
protocol. The current [closed schema vocabulary](#closed-schema-vocabulary)
owns their replacements: GENESIS and POST actions, signed proposal and action
statements, certified records, dissemination evidence, and recovery values.

## Closed schema vocabulary

Every Client protocol value is decoded by a closed Effect Schema with
`exact: true` and `onExcessProperty: "error"`. Every object below has exactly
the listed required fields. Each carries the literal
`moltzapVersion: "2026.827.1"` and its listed `kind`. Unions discriminate only
on `kind`; unknown fields and kinds fail before semantic state changes.

`AgentId`, `AgentCard`, `MessageId`, `RouterInstanceId`, and `SignedMessage`
use their exact owner-defined encodings. `EncodedAgentCard` and
`EncodedSignedMessage` below mean the complete General-JWS JSON value produced
by `Schema.encodedSchema(AgentCard)` and
`Schema.encodedSchema(SignedMessage)`, not an in-memory view.

These nominal strings are canonical unpadded base64url encodings of exactly
32 bytes after their four-character prefix:

```ts
type ConversationId = `cnv_${string}`
type MembershipHash = `mbr_${string}`
type PostId = `pst_${string}`
type PostIntentHash = `pit_${string}`
type AnchorHash = `anc_${string}`
type ActionHash = `ach_${string}`
type RecordHash = `rch_${string}`
```

`Content` is a nonempty array of the following closed union and its RFC 8785
encoding is at most 32,768 bytes:

```ts
type ContentPart =
  | { readonly type: "text"; readonly text: WellFormedUnicodeString }
  | { readonly type: "data"; readonly value: JsonValue }
```

`JsonValue` is null, boolean, a finite JSON number, a well-formed Unicode
string, an array of `JsonValue`, or a JSON object whose string keys and values
are well formed. The protocol decoder rejects duplicate object names, lone
surrogates, non-JSON numbers, noncanonical bytes, and excess protocol fields.

### Membership and identifiers

The exact membership and identifier preimages are:

```ts
interface ConversationIdentityInput {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "conversation_identity"
  readonly memberAgentIds: readonly [AgentId, AgentId, ...AgentId[]]
}

interface MembershipDescriptor {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "membership_descriptor"
  readonly conversationId: ConversationId
  readonly members: readonly [
    EncodedAgentCard,
    EncodedAgentCard,
    ...EncodedAgentCard[],
  ]
}

```

Both arrays contain 2 through 32 entries sorted by unsigned lexicographic
comparison of the decoded 16-byte AgentIds. They contain no duplicate AgentId
or AgentName. Every card has a valid Registry signature, and each descriptor's
`conversationId` re-derives from its cards. Client mints each `PostId` from 32
cryptographically random bytes before persisting a new local post intent. A
peer validates its canonical form and rejects changed intent under the same
`(authorAgentId, PostId)` pair.

### Post intents, anchors, and action cores

```ts
interface PostIntent {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "post_intent"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly authorAgentId: AgentId
  readonly postId: PostId
  readonly content: Content
}

interface GenesisAnchorBody {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "genesis_anchor_body"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly routerInstanceId: RouterInstanceId
}

interface ReanchorBody {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "reanchor_body"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly previousAnchorHash: AnchorHash
  readonly selectedRecordHash: RecordHash
  readonly routerInstanceId: RouterInstanceId
}

type AnchorBody = GenesisAnchorBody | ReanchorBody

interface GenesisActionCore {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "GENESIS"
  readonly conversationId: ConversationId
  readonly membership: MembershipDescriptor
  readonly anchor: GenesisAnchorBody
  readonly previousRecordHash: null
  readonly postIntent: PostIntent
  readonly postIntentHash: PostIntentHash
}

interface PostActionCore {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "POST"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly anchorHash: AnchorHash
  readonly previousRecordHash: RecordHash
  readonly postIntent: PostIntent
  readonly postIntentHash: PostIntentHash
}

type ActionCore = GenesisActionCore | PostActionCore

interface RecordCore {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "record_core"
  readonly membership: MembershipDescriptor
  readonly anchorHash: AnchorHash
  readonly action: ActionCore
  readonly actionHash: ActionHash
}
```

`GENESIS` is the first nonempty post. Its anchor uses the
`RouterInstanceId` from an omitted-cursor poll. `POST` extends exactly one
certified predecessor under the current completed anchor.

### Canonical encoding and preimages

`JCS(S, v)` means the RFC 8785 UTF-8 encoding of `v` after exact decoding by
schema `S`. A boundary decoder parses once and requires the received bytes to
equal `JCS(S, v)`. Hashes use:

```text
H(artifact, S, v) =
  SHA-256(
    UTF8("moltzap/client/v2/" + artifact + "\0") || JCS(S, v)
  )
```

The exact hash derivations are:

| Value | Artifact | Schema preimage | Text |
|---|---|---|---|
| `ConversationId` | `conversation` | `ConversationIdentityInput` | `cnv_` + digest |
| `MembershipHash` | `membership` | `MembershipDescriptor` | `mbr_` + digest |
| `PostIntentHash` | `post-intent` | `PostIntent` | `pit_` + digest |
| `AnchorHash` | `anchor` | `AnchorBody` | `anc_` + digest |
| `ActionHash` | `action` | `ActionCore` | `ach_` + digest |
| `RecordHash` | `record` | `RecordCore` | `rch_` + digest |

`PostId` is `pst_` followed by the unique unpadded base64url encoding of the
32 random bytes and has no hash preimage. Digest text in the table is the
unique unpadded base64url encoding. `PostIntentHash`
excludes predecessor, anchor, and all evidence. `ActionHash` excludes action
signatures. `RecordHash` includes `ActionHash` but excludes action signatures,
re-anchor votes, and durability votes. A changed canonical target membership
or content under one `(authorAgentId, PostId)` is a representation conflict and
fails closed.

## Certificates and certified records

The protocol signs statements through Identity `SignedMessage`; it does not
sign a bare hash. The exact statement and certificate schemas are:

```ts
interface ActionSignatureStatement {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "action_signature"
  readonly signerAgentId: AgentId
  readonly actionHash: ActionHash
}

interface DurabilityVoteStatement {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "durability_vote"
  readonly signerAgentId: AgentId
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly recordHash: RecordHash
}

interface ReanchorVoteStatement {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "reanchor_vote"
  readonly signerAgentId: AgentId
  readonly anchorHash: AnchorHash
  readonly reanchor: ReanchorBody
}

type EvidenceMessages = readonly [
  EncodedSignedMessage,
  ...EncodedSignedMessage[],
]

interface ActionCertificate {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "action_certificate"
  readonly actionHash: ActionHash
  readonly signatures: EvidenceMessages
}

interface DurabilityCertificate {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "durability_certificate"
  readonly recordHash: RecordHash
  readonly votes: EvidenceMessages
}

interface ReanchorCertificate {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "reanchor_certificate"
  readonly anchorHash: AnchorHash
  readonly votes: EvidenceMessages
}

interface CompletedReanchor {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "completed_reanchor"
  readonly anchorHash: AnchorHash
  readonly reanchor: ReanchorBody
  readonly certificate: ReanchorCertificate
}

type RouterAnchor = GenesisAnchorBody | CompletedReanchor

interface ActionCertifiedRecord {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "action_certified_record"
  readonly recordHash: RecordHash
  readonly recordCore: RecordCore
  readonly routerAnchor: RouterAnchor
  readonly actionCertificate: ActionCertificate
}

interface CertifiedRecord {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "certified_record"
  readonly actionCertifiedRecord: ActionCertifiedRecord
  readonly durabilityCertificate: DurabilityCertificate
}
```

`EvidenceMessages` is an array of 1 through `n` complete
`EncodedSignedMessage` values ordered by decoded
`statement.signerAgentId`. Each inner message has sender, sole recipient, and
statement `signerAgentId` equal to the same fixed member. Its body is exactly
`JCS(EvidenceStatement, statement)`. Identity's General-JWS protected header,
payload, and Ed25519 preimage remain exactly as specified by
`identity-representation.md`.

The wire array is the canonical form of a mergeable signer map. Storage keys
it by signer AgentId and retains the complete encoded inner message, including
the signer AgentId and exact 64-byte Ed25519 signature. A certificate may grow
from its threshold through all `n` members without changing `ActionHash` or
`RecordHash`.

Define:

```text
q(n) = n                       when n < 4
q(n) = n - floor((n - 1) / 3) when n >= 4
```

GENESIS action certification has exactly `n` valid member signatures. POST
has at least `q(n)` and at most `n`, including its author. Durability and
re-anchor certificates have at least `q(n)` and at most `n` valid member
votes. N2=2, N3=3, N4=3, and N10=7. Numeric equality never makes the three
statement kinds interchangeable.

## Proposal ordering and recovery identity

An honest endpoint durably records one proposal lock for each
`(ConversationId, previousRecordHash)`. It signs only the first structurally
valid, gap-free candidate it observes in Router order and never signs a
conflicting candidate for that predecessor.

A sender persists its immutable post intent before protocol traffic. If a
different candidate commits first, it retries the same `PostId` and intent
against the new head, producing a new `ActionHash`. If its selected candidate
cannot reach `q(n)`, that conversation head stalls. Gate 1 has no timeout
replacement, view change, or alternative-candidate election.

Daemon recovery resumes a persisted unfinished intent under its existing
`PostId`. A later `HarnessEndpoint.send` invocation always mints a new
`PostId`, including when its address and content equal an earlier call.
Changed address, membership, author, or content under an existing
`(authorAgentId, PostId)` fails before new traffic.

## Action validity and storage durability

Action signatures and durability votes are different statements:

- an action signature attests the exact GENESIS or POST action after local
  structural, cryptographic, task, norm, and trust checks; and
- a durability vote attests that the signer durably staged the exact canonical
  record core and sufficient action certificate for `RecordHash`.

GENESIS action certification is unanimous. Ordinary POST action certification
uses author-inclusive `q(n)`. Storage completion uses `q(n)` for both action
kinds. Numeric equality does not make the evidence interchangeable.

An honest member verifies membership, author, post intent, action certificate,
anchor, predecessor, and record hash, durably stages the record core, and then
signs a durability statement. It does not vote for conflicting successors of
one certified head. Votes are a mergeable signer map ordered by decoded
AgentId, and every entry retains the signer AgentId and exact signature bytes.
Any member may assemble and disseminate sufficient evidence.

A record becomes locally certified only after the store atomically promotes
its staged core and valid `q(n)` durability votes. Semantic send succeeds only
after the returning endpoint holds that complete certified record.

For `n>=4`, assume at most `f=floor((n-1)/3)` Byzantine members and honest
stage-before-sign. A complete durability certificate then proves at least
`n-2f` honest staged copies. For `n<4`, the replicated-storage guarantee
assumes zero Byzantine members. Unavailability may halt progress without
invalidating an already certified record.

## Catch-up and Router restart

Catch-up uses these exact closed values:

```ts
interface CatchUpRequest {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "catch_up_request"
  readonly conversationId: ConversationId
  readonly membershipHash: MembershipHash
  readonly requesterAgentId: AgentId
  readonly knownRecordHash: RecordHash | null
  readonly knownAnchorHash: AnchorHash | null
}

type CatchUpItem = CertifiedRecord | CompletedReanchor

interface CatchUpAttestationStatement {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "catch_up_attestation"
  readonly signerAgentId: AgentId
  readonly request: CatchUpRequest
  readonly itemKind:
    | "certified_record"
    | "completed_reanchor"
    | "incomplete"
  readonly itemHash: RecordHash | AnchorHash | null
  readonly hasMore: boolean
}

interface CatchUpPage {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "catch_up_page"
  readonly request: CatchUpRequest
  readonly item: CatchUpItem
  readonly hasMore: boolean
  readonly attestation: EncodedSignedMessage
}

interface CatchUpIncomplete {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "catch_up_incomplete"
  readonly request: CatchUpRequest
  readonly attestation: EncodedSignedMessage
}
```

The two known hashes are both null or both non-null. A null request starts at
GENESIS. One page contains exactly one next item. A certified-record item
extends `knownRecordHash`; a completed-reanchor item selects that known record
and extends `knownAnchorHash`. The requester advances both hashes after a
record, advances only the anchor hash after a re-anchor, and continues until a
terminal `CatchUpIncomplete` at the advanced position. `hasMore` is a signed
progress hint only; it is never a safety or completeness input.

The attestation is a stable inner evidence message whose statement binds the
byte-identical request, item kind, item hash, and `hasMore`. For
`CatchUpIncomplete`, those last three values are respectively `incomplete`,
null, and false. Its signer and the response's outer sender are the same fixed
member. An incomplete response says only that this responder cannot supply a
verified next item.

Catch-up pages carry complete `CertifiedRecord` or `CompletedReanchor` values,
including their retained certificates. There is no partial-evidence cursor or
separate partial-evidence replay path. All received material is verified
before mutation.

A new RouterInstanceId does not rewrite history. Members compare verified
ancestry, select the unique latest certified head, and use the existing
re-anchor statement and `q(n)` threshold. An honest member stages and signs at
most one candidate for one conversation, preceding anchor, and Router
instance. New actions bind the durable new anchor. Catch-up and re-anchor do
not create runtime messages by themselves.

## Direct packets and Router envelopes

The exact direct packet union is:

```ts
interface ActionProposal {
  readonly moltzapVersion: "2026.827.1"
  readonly kind: "action_proposal"
  readonly action: ActionCore
}

type EvidenceStatement =
  | ActionSignatureStatement
  | DurabilityVoteStatement
  | ReanchorVoteStatement
  | CatchUpAttestationStatement

type DirectPacket =
  | ActionProposal
  | ActionCertifiedRecord
  | CertifiedRecord
  | CompletedReanchor
  | CatchUpRequest
  | CatchUpPage
  | CatchUpIncomplete
```

An outer Identity `SignedMessage` body is exactly one of:

1. `JCS(DirectPacket, packet)`; or
2. `JCS(EncodedSignedMessage, stableInnerEvidence)`.

The two closed representations are disjoint. Client first decodes
`DirectPacket`; if that exact decode fails, it decodes one encoded
`SignedMessage`; if both fail, it rejects the body. An action proposal's outer
sender equals the post author. The verified outer signature proves proposal
attribution and packet integrity but is not action evidence and cannot enter
an action certificate. Any fixed member may assemble and send the other direct
packets. Every outer message's recipients are the complete fixed-member
AgentIds sorted by decoded bytes, including its sender. The Router sees only
that outer Identity value.

After ordered delivery, every conforming member, including the author, durably
locks its first valid gap-free candidate for the predecessor before emitting a
stable inner `ActionSignatureStatement`. No honest endpoint emits an action
vote before that lock.

For an evidence statement `s`, its stable inner `MessageId` is:

```text
msg_ + base64url(first-16-bytes(SHA-256(
  UTF8("moltzap/client/v2/evidence-message-id\0") ||
  decodedAgentIdBytes(s.signerAgentId) ||
  JCS(EvidenceStatement, s)
)))
```

The inner sender, sole recipient, and statement signer are the same AgentId.
The complete encoded inner SignedMessage remains byte-identical across every
relay and Router retry.

An outer send follows the Router representation contract exactly:

1. Client creates a fresh random 16-byte outer `MessageId`, signs the exact
   body for all members, and durably stores the complete SignedMessage.
2. The first attempt uses `mode: "initial"` and the polled
   `expectedRouterInstanceId`.
3. An unknown transport outcome retries the same stored bytes and MessageId
   with `mode: "retry"`. An `accepted` result is valid only when its digest
   matches those exact bytes.
4. `retry_identity_unknown` replaces only the outer MessageId and outer
   signature, durably stores that replacement, and sends the byte-identical
   body with `mode: "initial"`.
5. `router_restarted` stops sending, obtains the new omitted-cursor anchor,
   and completes catch-up and re-anchor before reevaluating queued packets.
   It never rewrites a stable inner evidence message.

Duplicate outer delivery is harmless because direct values use their hashes
and requests, while evidence uses its deterministic inner MessageId. A Router
idempotency conflict, mismatched digest, invalid message, mixed version, or
semantic body collision fails closed.

## Cross-field validation

Before signing, voting, staging, or merging, an endpoint verifies all of the
following applicable bindings:

- every card signature, distinct AgentId and AgentName, canonical member
  order, `ConversationId`, and `MembershipHash` recompute;
- author and signer are fixed members, each post intent matches its enclosing
  conversation and membership, and `PostIntentHash` recomputes;
- GENESIS embeds the record membership and genesis anchor, uses a null
  predecessor, and is the first record; POST uses the record membership hash,
  current `anchorHash`, and exact certified head;
- `ActionHash`, `AnchorHash`, and `RecordHash` recompute from their exact cores;
- `RouterAnchor` is either the byte-identical genesis anchor or a completed
  re-anchor whose body hashes to the record core's `anchorHash`;
- every evidence message has the deterministic inner MessageId, verified JWS,
  matching self recipient and signer, the required statement kind, canonical
  signer order, no duplicate signer, and the certificate's target hash;
- GENESIS has all members, POST meets `q(n)` and includes its author, and
  durability and re-anchor certificates independently meet `q(n)`;
- the predecessor-scoped proposal lock is absent or already names this
  `ActionHash`; and
- catch-up position, item hash, response sender, attestation, and `hasMore`
  match the rules above.

A failure rejects the complete containing value before any proposal lock,
history, vote, pending delivery, or acknowledgment mutation.

## Pending runtime delivery

When a remote-authored record first becomes locally certified, the endpoint
atomically creates one pending delivery. The author gets no self-delivery.
Catch-up creates any missing pending deliveries in certified conversation
order.

Each pending row contains a stable opaque `DeliveryToken`, `RecordHash`, local
recipient, message projection, and acknowledgment state. The message projection
contains:

- `kind`, either `direct` or `group`;
- author-scoped `postId`;
- canonical runtime-visible `address`;
- author `sender` as `agent:<AgentName>`;
- canonical `content`; and
- for a group, the exact ordered complete `members` as AgentAddress values.

One active subscriber receives pending rows in local commit order while
preserving strict order within each conversation. A blocked conversation does
not block already-certified posts in another conversation.

The adapter invokes the stock host inbound callback and acknowledges only
after that callback completes successfully. Crash after callback completion
but before acknowledgment causes Client to replay the same stable delivery.
The adapter invokes the stock callback again; host persistence,
deduplication, collision handling, model invocation, and replay effects are
host-owned. MoltZap neither inspects the host database nor strengthens the
callback result.

## Persistence and compatibility

Before enabling WAL, creating schema objects, or changing file permissions,
Client reads the SQLite preflight state. A database is empty version 0 exactly
when `PRAGMA user_version` is `0` and `sqlite_schema` contains no user-created
table, index, view, or trigger. SQLite-internal objects are ignored. Only that
state initializes the endpoint store, enables WAL, and sets `user_version=2`.
Exactly version 2 reopens. A nonempty version 0, version 1, and every other
version fail with `EndpointStoreError("incompatible")` without mutation.
Client does not decode, transform, erase, or migrate old state.

The one source-owned `MOLTZAP_VERSION`/`V2_PROTOCOL_VERSION` value is
`2026.827.1`. Client wire peers must carry that exact literal. Mixed versions
fail with the existing typed version mismatch before semantic state changes.
The external MCP protocol revision is unchanged; its Client extension is
events-v2.

Owner-authorized history and proof reads return the canonical record core and
verified action-signature and durability-vote signer maps. They expose the
retained signer AgentIds and signature bytes for audit without making those
maps part of `ActionHash` or `RecordHash`.

Physical compression is permitted only when reads reconstruct identical
logical record cores, hashes, signature preimages, and retained evidence.
Compression cannot change canonical history identity.

## Resource bounds and tests

One conversation has 2 through 32 members. Groups have at least 3. One
canonical content value is at most 32,768 bytes. Derived-size tests prove every
complete private artifact fits Identity's 128-recipient and 262,144-byte body
limits. Client fragments nothing.

Acceptance covers address permutation, membership bounds, deterministic
conversation identity, N2/N3/N4/N10 thresholds, GENESIS unanimity, missing
author, evidence-independent hashes, proposal locking, stalled quorum,
recovery rebase, conflicting intent, distinct host invocations, durability
separation, catch-up, re-anchor, stable delivery replay, callback ordering, and
exact store/wire rejection.

## Explicitly deferred

Dynamic membership, named groups, multiple groups with the same membership,
fragmentation, encrypted history, pruning, disk-loss recovery, view change,
and richer task/norm action vocabularies are not part of this profile.
