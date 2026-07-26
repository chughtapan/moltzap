# Layer interfaces and payload shapes

Status: DRAFT (deepening doc; feeds the spec set)

## Purpose & scope

The stack's programmable surface on one page: a small noun vocabulary,
**five ports**, the layers as **laws** over them, and the Effect
realization. The words are the ones infrastructure engineers already
use: an agent performs an **action** in a conversation — `MULTICAST`,
`ALL_GATHER`, `START` — and performing one runs a **protocol** of
**messages** the **transport** delivers in order; conversations keep
an append-only **ledger** of actions read by **offset**; a writer
**locks** the next turn with `begin`, **stages** updates, and
**commits**; identities are **cards** you **look up** in a
**registry**; the firewall is a pair of **hooks**; a plugin **runs**
with a **channel**. If a name needs a glossary, it is the wrong name.

The layering is decomposition, not encapsulation: **one action is
realized by many messages**, the way one packet is realized by many
link frames, and the protocol is the rule for that decomposition. The
transcript records actions; the messages that performed them are not
kept.

One criterion decides what earns a tag:

> **The port test.** A seam earns a `Context.Tag` if and only if two
> implementations must be interchangeable and the conformance suite
> quantifies over the swap. Everything else is a law (a checkable
> property), a decorator (middleware adding a guarantee), a derivation
> (a pure read of port state), or an adapter (an implementation behind
> a port). A tag that exists before its seam is decided is a bet
> against "questions stay questions."

The five swap axes, hence the five ports: **Transport** (production vs
testbed data plane), **Ledger** (storage engine), **Registry** (card
custody), **Signer** (attribution binding), **Harness** (the SPI two
runtimes implement). A sixth port requires a recorded decision showing
its swap axis.

Non-goals: chartered semantics (#765 — collective kinds, quorum,
abort, sealed rounds, presence); wire encodings (control-plane
encoding is recorded, the data wire is `data-plane.md` Q10); the key
model (register item 5); package internals (the map is the v0 plan's
W1).

## Conventions

- **Nouns are branded types**, defined once in `v2/wire`, imported by
  reference. Base representations are realization choices; signatures
  use only the brand.
- **Ports are roots.** A port tag is provided once at a process's
  composition root and named in no leaf code's requirements. Leaf code
  holds plain values the composition built from the roots, exposing
  strictly less authority.
- **Laws are the checkable claims.** Each carries a citation and a
  discharge kind: **(C)** compile-time — the violation is
  unrepresentable; **(P)** property-tested; **(S)** suite — needs a
  second implementation or a case-study program.
- **Refusals are values**, never throws; defects never cross a port.
  Port-internal error unions (`SignError`, `StoreError`,
  `RegistryError`) are closed and region-local; the wire sees only the
  opaque `Refusal` (register item 8 open).

## Nouns

| Noun | Layer | What it is | Status |
|---|---|---|---|
| `AgentId` | L1 | opaque registry-minted id; survives key rotation | decided |
| `Principal` | L1 | opaque link to the party an agent acts for | linkage depth open |
| `PublicKey` | L1 | the key submitted at registration; its card binds it | decided |
| `AgentCard` | L1 | registry-attested X.509, self-attesting (fields: identity.md) | decided |
| `MessageId` | L1 | client-minted, unique per message; makes a retry identifiable and two identical utterances distinct | decided |
| `Envelope` | L1 | a message's carrier-readable fields: message id, sender, conversation, version, message type (with a lifecycle action's participants), attribution | field set decided; encoding open |
| `Body` | L1 | opaque bytes; nothing below L4 reads them | decided |
| `Message` | L2 | an `Envelope` and a `Body`, signed as one byte string — the unit the transport delivers, byte-exact at every hop | decided |
| `VerifiedMessage` | L1 | only `verify` constructs it — the message plus its resolved `Principal`; holding one is proof it verified | decided |
| `Version` | cross | the protocol CalVer, matched exactly | decided |
| `ConversationId` | L3 | client-minted, collision-free by size | decided |
| `Offset` | L3 | a record's place in the conversation's log; ledger-assigned; never a field of any message type (law L1.6) | decided |
| `MessageType` | L2 | what this message is: an action being recorded (`MULTICAST`, `START`, `ADD`, `LEAVE`) or a protocol step performing one (propose, ack, sign) | v0 set decided; the rest charter-widened |
| `Action` | L3 | what a conversation does — realized by a protocol, recorded in the ledger | v0: `MULTICAST` + lifecycle; the rest chartered |
| `TranscriptRecord` | L3 | a recorded action: the byte-exact message that carried it plus its `Offset` | decided |
| `Delivered` | L2 | what `subscribe` yields: a message, with its `Offset` when it is a recorded action and none when it is a protocol message | decided |
| `PageToken` | L3 | opaque fail-closed token paging list reads; `Page<T>` is items plus the next token | decided |
| `Refusal` | cross | the interim value ("the op did not take effect"), opaque cause | register 8 open |

**Actions and protocols.** An action is what a conversation does; a
protocol is how it gets done, and the machinery is general — the same
engine runs a one-message utterance and a multi-round collective, so
v0 builds it rather than hardcoding a single operation. A plain
utterance is the degenerate protocol; `ALL_GATHER` is a longer one.
The charter widens the *vocabulary* of actions and fixes the
norm-level parameters (quorum rules, timeouts); widening adds arms,
never port methods, and every exhaustive match breaks until the new
arm is handled. The message type rides the envelope so admission and
the membership fold never touch the body.

**What the ledger holds.** One recorded action is one message: the
committing message carries the action's content and the participants'
signature set, so it is self-certifying — a reader verifies the action
happened legitimately from that record alone, without the protocol
messages that produced it. Those are delivered, not kept. The ledger's
write path is therefore one message in, one offset out, and the hash
chain that makes the order tamper-evident is the ledger's own
technique, below the port.

The vocabulary stops at the wire. L4 and L5 carry no nouns here: a
norm bundle binds only its guarantee (tasks.md; law L4.1), the
firewall's rule language is the undesigned firewall plan (open
question 2), and L6's evidence is a derivation. Messages and cards
cross every carrier byte-exact — views read the retained bytes,
nothing re-encodes (law L1.5).

## The five ports

`Effect<A, E>` is success/typed-refusal; the `R` channel is stated in
the realization section.

### Signer (L1; swap axis: the signing implementation)

Attribution is a signature over the message's bytes
(`docs/decisions/20260726-attribution-binds-to-the-message.md`), so
verification needs the message and the card and nothing else. The swap
axis is the implementation — key custody, hardware backing, a future
rotation scheme — not the shape of what is signed.

```ts
/** Offline: the message plus the sender's card is enough — no round
 *  trip, no live sender, no trust in the router. Recipients,
 *  admission, and L6 readers all hold exactly this. */
interface Verifier {
  readonly verify: (message: Message, card: AgentCard) => Effect<VerifiedMessage, Refusal>;
}
/** Signing half — endpoint composition only; the private key is
 *  adapter state. */
interface Signer extends Verifier {
  readonly sign: (conversation: ConversationId, type: MessageType, body: Body) => Effect<Message, SignError>;
}
```

The router's requirements name `Verifier` only — no code in the router
process can sign, which is data-plane.md inv. 2 at compile time
(law L1.4).

### Transport (L2; swap axis: production vs testbed)

The ordered multicast primitive and nothing above it: messages in,
messages out, in one shared order. The swap axis sits exactly at L2 — every
testbed injection is an L2 fault, every observation an L2 delivery
event — so L3 and up are identical under both adapters, and the
charter widens L3 with zero change here. The endpoint holds the client
side; the router and the testbed provide it. Admission lives inside
the providing adapter (data-plane.md).

```ts
interface Transport {
  /** Deliver one message to the conversation's members, in the one
   *  shared order. Delivery only — nothing is recorded here, and a
   *  protocol's messages never go further than this. */
  readonly send: (message: Message) => Effect<void, Refusal>;
  /** The ordered stream for a conversation, resumable: recorded
   *  actions from `from` onward, then the live tail. Every member
   *  observes one order, which is what lets participants fold a
   *  protocol live — the acks that complete a grant are seen, not
   *  stored, so only recorded actions carry an offset and only they
   *  replay after a gap. */
  readonly subscribe: (conversation: ConversationId, from: Offset) => Stream<Delivered, Refusal>;
}
```

Collective rounds ride this port as ordinary sends — one ack round
replaces gossip because the shared order is equivocation-infeasible
(protocol and diagrams: data-plane.md → The collective transaction).
The `Offset` ack is not a layer leak: delivery order IS the log order —
one ledger-owned order spans L2 and L3, and fan-out is an
optimization over the ledger.

### Ledger (L3; swap axis: storage engine)

Each conversation's transcript is an append-only log of committed
messages — the ledger the collectives decision names. One write verb;
genesis is not special.

```ts
interface Ledger {
  /** One message, one atomic commit; the conversation is the
   *  envelope's. A start message to a fresh id creates the log at
   *  offset zero (laws L3.5, L3.7). */
  readonly append: (message: Message) => Effect<Offset, StoreError>;
  /** A contiguous window starting at `from` inclusive, at most `limit`
   *  records: byte-exact, gated by the entitlement predicate. Offsets
   *  are dense and the ledger never clamps `limit` silently, so a
   *  short window means the head was reached. */
  readonly read: (conversation: ConversationId, from: Offset, limit: number, scope: Scope) => Effect<readonly TranscriptRecord[], StoreError>;
  readonly list: (of: AgentId, page: PageToken) => Effect<Page<ConversationId>, StoreError>;
}
/** The one entitlement seam. v0 checks membership; witness, operator,
 *  horizon, and monitor policy (registers 3/4/6) are future predicate
 *  values, not new methods. */
type Scope = (record: TranscriptRecord) => Effect<boolean>;
```

Members reach the ledger directly — appending a completed action and
reading history are both L3 acts, carried as control-plane calls
(control-plane.md → Op families). The router is not involved: it
delivers messages and records nothing. Admission therefore runs at
the ledger's front door — attribution verifies, the sender exists and
is active, the sender is a member or this is a `START` to a fresh id,
the version matches exactly, and the grant precedes — since the
delivery adapter is not on the append path.

### Registry (L1 material + L7 mechanism; swap axis: card custody)

```ts
interface Registry {
  /** Operator-gated; the caller must be the operator arm. */
  readonly register: (caller: Caller, key: PublicKey, principal: Principal) => Effect<AgentCard, RegistryError>;
  /** The card is the directory entry; no thinner projection. */
  readonly lookup: (id: AgentId) => Effect<AgentCard, RegistryError>;
  readonly list: (page: PageToken) => Effect<Page<AgentCard>, RegistryError>;
}
```

`Caller` is a two-arm value (`identity | operator`) with one minter in
the router composition (law L7.1). Per-request authentication derives
its caller through `lookup`, so "L7 reconfigures L1" is an
institutional fact change at the directory — revocation the zero
policy (law L7.3;
`20260724-l7-is-policy-attached-to-identity.md`). v0's fact set is the
single active bit; the lookup surface grows facts when the vocabulary
lands, without a new port.

### Harness (L4 SPI; swap axis: the two runtimes)

The port is the SPI: a runtime plugs in by implementing `run`, and
everything it can do arrives as the **channel** — plain values, no
authority in its requirements. It cannot sign, send raw, append, read
out of scope, or touch firewall state, because it holds none of those
and can acquire none. "Plugins are pure consumers" (channels.md → Acceptance) is this type.

```ts
interface Harness {
  /** The engine drives; the harness responds. Dispatch is the moment
   *  the agent generates, and the engine only dispatches while it
   *  holds the grant — PCC as an interface, not a discipline
   *  (`docs/decisions/20260726-the-engine-dispatches.md`). */
  readonly dispatch: (request: DispatchRequest) => Effect<Body, never>;
  readonly run: (channel: Channel) => Effect<void, never>; // R = never
}
/** What the engine hands the harness: the conversation, the action
 *  being performed, and whatever context the firewall attached. */
interface DispatchRequest {
  readonly conversation: ConversationId;
  readonly action: Action;
  readonly context: FirewallContext;
}
interface Channel {
  /** Lock the next turn (PCC): resolves only when the group's write
   *  discipline grants this writer the conversation. Hold the open
   *  transaction before generating. TTL-bounded — never a session. */
  readonly begin: (conversation: ConversationId) => Effect<Txn, Refusal>;
  /** Derived: fresh id + start message, autocommitted (law L3.7). */
  readonly startConversation: (members: readonly AgentId[], body: Body) => Effect<ConversationId, Refusal>;
  /** The attention stream only; a withheld message stays in the log. */
  readonly inbound: Stream<InboundMessage, Refusal>;
}
/** Holding an open Txn IS holding the turn; commit and abort consume
 *  it — at most one commit per lock, by construction. */
interface Txn {
  /** Stage one part of the action being assembled. A collective's
   *  contributions are updates; participant carriage is chartered. */
  readonly update: (type: MessageType, body: Body) => Effect<void, Refusal>;
  /** Atomic commit: the staged unit lands at one offset; the lock
   *  releases. */
  readonly commit: () => Effect<Offset, Refusal>;
  /** Release without effect. */
  readonly abort: () => Effect<void, Refusal>;
  /** Autocommit sugar for the plain message: one update + commit. */
  readonly send: (body: Body) => Effect<Offset, Refusal>;
}
/** A verified message plus whatever context the firewall attaches;
 *  enrichment is additive and firewall-defined. */
interface InboundMessage { readonly message: VerifiedMessage; readonly context: FirewallContext }
```

**Who drives.** The engine runs an action's protocol autonomously and
the harness supplies only content, when dispatched. Acknowledging
another member's proposal is a firewall decision — the engine prepares
it, the outbound hook decides whether it goes, and refusing is
withholding — and signing is a computation, so neither needs a
participant-side verb. There is one dispatch per participant per
action, not one model turn per protocol step
(`docs/decisions/20260726-the-engine-dispatches.md`).

**Where norms attach.** Under the recorded hypothesis
(`20260724-norms-are-mcp-skill-bundles.md`) a pinned norm bundle runs
endpoint-side as an MCP server. Its read-only tools are projection
queries over the folds; its committing tools **compile to
transactions through this same channel** — the compile step consumes
`begin`/`update`/`commit`, crosses the outbound firewall hook as a
tool call first, and adds no port. Legal moves are computed from
ledger state and enforced at the hooks; the model-visible tool
surface need not change.

## Transactions (the turn is a write lock)

The transcript is a **pessimistic database**, and PCC is its lock
discipline — one interface, lock first. `begin` acquires the
conversation's write lock: it resolves only when the group's write
discipline grants this writer the next turn, so
observe-before-generate (data-plane.md inv. 5) is simply holding an
open `Txn` before generating. `update` stages entries; `commit` lands
the staged unit atomically at one offset and releases the lock;
`abort` releases without effect. A plain message is the autocommit
case (`begin` then `Txn.send`). The lock is TTL-expiring
per-conversation coordination state — never a session.

The store supplies atomicity, isolation, and the lock discipline; it
**never judges completeness** — when to commit, and whether the
quorum suffices, is the committer's call under the task's norms. That
line is what keeps this the opposite of the rejected escrow model.

The lock disciplines **effect, at collective granularity**: the
leader's lock covers the whole transaction, and round entries — acks,
contributions, signatures — are ordinary effect-free sends outside
the lock (their carriage is the charter's), so agreement precedes
generation at the granularity of the collective, not of every round
message. The rounds (data-plane.md → The collective transaction) are
this interface realized among distrusting parties: propose/ack
realize `begin`, the contribution round realizes `update`s, the
signature round and commit message realize `commit`. The correctness skeleton is
recorded there and in the collectives record: the txn id is the hash
of its BEGIN message; the grant and a commit's effect are **folds over
the shared order** (the acks are the grant's certificate; validity is
computed identically by every same-pinned party; the store never
judges); supersession is order-resolved, restart abandons the in-flight
transaction and re-syncs from committed state, and one-effective-commit-per-txn-id makes retries
harmless — the norm compile step's idempotency key. Parameters — ack
and quorum rules, lock TTLs, abort authority, participant-update
carriage, next-leader selection, overlapping transactions, the
lock-grant wire signal — are the charter's. TypeScript cannot enforce
linear consumption of the handle, so at-most-one-commit-per-lock has
a suite-law residual (L3.9). PCC's instrument lives inside the
Transport adapter, in no signature.

## Flows

The send path — every arrow a call, every refusal before commitment:

```mermaid
sequenceDiagram
  participant P as Harness plugin
  participant E as Protocol engine
  participant F as Outbound hook (L5)
  participant T as Transport (L2)
  participant L as Ledger (L3)
  P->>H: begin(conversation) — lock the turn
  H->>T: lock request (PCC, carriage chartered)
  T-->>P: Txn — the turn is held
  P->>H: txn.send(body) — or updates then commit, or a committing tool call
  H->>S: admit
  S->>T: sign(conversation, type, body) then send(Message)
  T->>T: admission: verify, member or fresh start, version
  T->>L: append(Message)
  T-->>P: Offset — the commit ack
  T--)T: fan out to membership (optimization over the ledger)
```

Receive and recovery — push is convenience, the log is truth:

```mermaid
flowchart LR
  T[Transport] -- "subscribe(conv, offset)" --> V[verify] --> IH[Inbound hook] --> A[Plugin]
  L[Ledger] -. "read(conv, offset) — control-plane call, after any miss" .-> V
  L --- T
  A -- "advance owned offset" --> A
```

Resuming from an owned offset is observationally identical to never
disconnecting (law L2.5). The collective-round flow is drawn once at
its owner: data-plane.md → The collective transaction.

## Not ports

- **The firewall (L5)** contributes only its **hooks**: two
  directional gates on the agent's boundary — inbound for everything
  reaching attention (delivered messages, tool results), outbound for
  everything the agent does (sends, tool calls;
  `20260724-firewall-two-directions.md`) — with the guarantees of laws
  L5.1–L5.3 and L5.6. Not a port: the suite asserts *expressibility*
  (arena's and bench's rulesets both expressible), never
  *equivalence* — two agents' firewalls are intentionally different.
  Everything inside the hooks is the undesigned firewall plan (open
  question 2); v0's contacts-keyed gate is a stopgap behind them
  (`endpoints/contacts.md`), not accepted design.
- **Entitlement (L3)** is the `Scope` predicate on `Ledger.read`;
  future read-scope decisions change the value, not the port.
- **Derivations** are pure functions over port state, in a shared,
  pinned, content-addressed fold library (it is trusted computing
  base — findings cite it by hash): `applyAction` (total over the action vocabulary)
  and `membersAt` — one fold, two sites: the router folds lifecycle
  entries for delivery sets, the endpoint runs the identical fold to
  know the room. `Channel.startConversation` is a derivation.
  `evidence` = `verify` over `read`, packaged as a recomputation
  certificate (law L6.1; register 3 open;
  `20260724-monitors-are-deterministic-contracts.md`). Materializing
  hot folds is realization freedom.
- **The CLI** is a driver over `Registry` plus ledger reads, not a
  port (control-plane.md).
- **L8** has no interface; it is realized through the stack (open).

## Laws

Kinds per Conventions; citations name the governing doc.

| # | Law | Kind | Cite |
|---|---|---|---|
| L1.1 | `verify(sign(c,k,b), lookup(sender))` ≈ the verified view — verify-after-sign is identity | P | identity.md inv. 1 |
| L1.2 | `verify : (message, card) → VerifiedMessage` — no round trip, no live sender; L6 readers hold the same shape | C | identity.md → Verification duties |
| L1.3 | Any alteration of envelope or body ⇒ `verify` refuses | P | identity.md inv. 4 |
| L1.4 | Only the endpoint composition names `Signer`; the router names `Verifier` only | C | identity.md inv. 2; data-plane.md inv. 2 |
| L1.5 | Messages and cards cross every carrier byte-exact: views read the retained bytes, nothing re-encodes | C+P | identity.md → Byte preservation; data-plane.md inv. 13 |
| L1.6 | `Offset` is a field of no message type (types-check canary) | C | identity.md → Not message fields |
| L2.1 | All members observe the same records in the same order | S | data-plane.md inv. 3 |
| L2.2 | `subscribe` carries messages byte-exact with attribution intact | P | data-plane.md inv. 2, 13 |
| L2.3 | Admission reads `Envelope` only; no Transport operation takes a `Body` | C | data-plane.md inv. 1 |
| L2.4 | `subscribe` is a read-only stream; a response is a fresh `send` | C | data-plane.md inv. 14 |
| L2.5 | Over recorded actions, `subscribe(c, o)` ≈ `read(c, o)` — resuming at an offset equals never disconnecting; an in-flight protocol is abandoned, not replayed | P | control-plane.md guarantee 4; sessionless |
| L2.6 | One send, one byte-image, identical to every member (equivocation robustness) | S | data-plane.md inv. 7 |
| L3.1 | `read(c, offset(append(f)), …)` contains exactly the appended message's record; offsets are dense and `from` is inclusive | P | control-plane.md guarantees 2, 3 |
| L3.2 | `append` returns an `Offset` ⇒ the action is committed (atomic, durable, ordered); every refusal precedes commitment; `Transport.send` records nothing | P | data-plane.md inv. 4; control-plane.md guarantee 1 |
| L3.3 | `append` takes one message — one entry, one commit; a collective commits as one unit (its transaction rides the message's body) | C+P | control-plane.md guarantee 9 |
| L3.4 | No update, delete, or rewrite operation exists on any port | C | control-plane.md guarantee 6 |
| L3.5 | A start message to a used id refuses with no side effect; to a fresh id it creates the log at offset zero | P | lifecycle-rides-l3 |
| L3.6 | `membersAt` ≈ the fold of lifecycle actions at or before the offset; no membership write exists | C+P | data-plane.md inv. 8; control-plane.md guarantee 5 |
| L3.7 | No create operation exists anywhere; `Channel.startConversation` is a derived term (fresh id, sign start, send) | C | lifecycle-rides-l3 |
| L3.8 | Every recorded action belongs to a transaction whose `begin` preceded it — holding the open `Txn` is the proof (typestate) — except a `START` to a fresh id, which has no conversation to lock; a protocol's messages need no grant and are never recorded | C | data-plane.md inv. 5 |
| L3.9 | `commit`/`abort` consume the `Txn`: at most one commit per lock (linearity residual) | S | data-plane.md → Implementation notes |
| L3.10 | Admission refusals never mutate membership | C+P | data-plane.md inv. 9 |
| L5.1 | The hooks hold no signing authority; the message and its attribution pass through unaltered | C | screening.md inv. 2 |
| L5.2 | A withheld inbound message stays out of attention while `read` is unchanged — the firewall filters attention, never the record | P | screening.md inv. 2, acceptance |
| L5.3 | Verdicts are agent-local; no interface emits one outward | C | screening.md inv. 3; contacts.md inv. 5 |
| L5.4 | A change to the agent's trust data is a local act with immediate effect and zero network involvement | P | contacts.md inv. 4 |
| L5.5 | No router-side interface accepts, stores, or serves any L5 trust data | C | contacts.md inv. 1 |
| L5.6 | An illegal committing action is refused at the outbound hook before compilation begins — refusal never strands an in-flight round | P | screening.md inv. 5 |
| L4.1 | No port has a task sort; norms enter only as firewall and turn configuration, shape unbound (tasks.md open question 1); same-version agreement is two endpoints pinning one bundle digest | C | tasks.md inv. 1–3; data-plane.md inv. 10 |
| L6.1 | `evidence` = the recipient's `verify` over `read`, post facto; no monitor port, principal, or caller arm exists | C | identity.md → Verification duties; enforcement.md |
| L7.1 | `register` requires the operator arm; `Caller` has two arms and one minter | C | control-plane.md inv. 3, 7 |
| L7.2 | `list` ≈ per-id `lookup`; cards only, no thinner projection | P | directory-serves-cards |
| L7.3 | An institutional fact change (revocation the zero policy) changes what `lookup` returns and what callers can be derived — no consequence op | P | layers.md → L7; l7-is-policy-attached-to-identity |
| X.1 | Version exact-match refuses before any state change, on every recorded action | C+P | protocol-version-carriage |
| X.2 | Swap `TransportLive` for `TransportTestbed`: observationally equivalent, no other binding changes; every injection stays inside the tolerated failure envelope | S | data-plane.md inv. 11 |
| X.3 | No signature names a lease, socket, connection, or session | C | sessionless-network |

## Effect realization (recorded standard)

The normative surface is the nouns, ports, turns, and laws above; this
mapping is v2's standard realization.

- **One `Context.Tag` per port**, ids `moltzap/v2/port/<Name>`:
  `TransportTag`, `LedgerTag`, `RegistryTag`, `SignerTag` (endpoint) /
  `VerifierTag` (router), `HarnessTag`. The v1 idiom (`Context.Tag`
  class + `Layer.effect`), re-implemented never imported.
- **One `Layer` per adapter**: `TransportLive` (requires Verifier only — it records nothing), `TransportTestbed` (same tag; adds envelope-level
  observation and a closed `FaultProfile` sum over data-plane.md's
  tolerated-fault envelope), `LedgerLive`, `RegistryLive`,
  `SignerLive`, `HarnessOpenClaw` /
  `HarnessNanoClaw`. Law X.2's swap is choosing the Transport `Layer`.
- **Decorators are `Layer<Port, never, Port>`**: `withEntitlement(scope)`
  wraps `Ledger.read`; `withFirewall(rules)` wraps the harness mount
  (the rules value is firewall-plan territory, opaque here).
  Configuration flows down as decorator and adapter parameters, never
  as a lower port depending on an upper tag.
- **Compositions**: `RouterComposition` holds Ledger, Registry,
  Verifier, and provides Transport; `EndpointComposition` holds
  Signer, the Transport client, a control-plane client for reads, and
  whatever state its firewall implementation owns. Leaf code holds
  values (`Channel`, `Txn`, `Caller`, `Scope`); folds and transaction
  handles are plain values with no tag.
- **Three static checks** under the W1 boundary machinery: no exported
  function outside a composition names a port tag in its
  requirements; `Harness.run` is authority-free and `Channel` contains
  no port-typed field; a `Layer` at stack level N requires only tags
  at levels ≤ N.

```mermaid
flowchart TB
  subgraph Endpoint["EndpointComposition"]
    HP[Harness plugin] -- "Channel (values only)" --> CH[begin / stage / commit]
    CH --> FH[Firewall hooks] --> SG[Signer]
    SG --> TC[Transport client]
    TC -- subscribe --> VF1[Verifier] --> FH
  end
  subgraph Router["RouterComposition (provides Transport)"]
    TL[TransportLive] --> VF2[Verifier]
    TL --> LG[Ledger + entitlement decorator]
    RG[Registry] --> VF2
  end
  TB[TransportTestbed] -. "swap: one Layer binding (X.2)" .- TL
  TC -- "wire (Q10, open)" --- TL
```

## Acceptance criteria

- Name closure: every v0-plan interface sketch maps to exactly one
  port, decorator, derivation, value, or law here, and nothing here
  lacks a plan anchor.
- Every law carries a citation and a discharge kind; the suite
  discharges each (P) and (S) law; the (C) laws are pinned by the
  static checks and canaries.
- Both case studies (bench, arena) are expressible as programs over
  `Channel` plus firewall configuration, with no port tag in their
  requirements.
- A cold implementer can build each port from its section plus the
  cited laws, without this session's history.

## Open questions

1. **Derived conformance machinery.** A reified signature value can
   generate the property corpus instead of hand-writing each (P)/(S)
   law. Default: adopt the law-table format now; W8 decides the
   generator. Escalation: W8 / `v2/conformance`.
2. **The firewall plan.** Phasing recorded
   (`docs/decisions/20260724-firewall-starts-as-mcp-middleware.md`):
   the hooks are realized as MCP middleware interception with
   inherited observability, built first; screening logic is deferred —
   v0 plugs in only the contacts stopgap and the institutional-fact
   check, and the rule vocabulary stays undesigned with the proposal
   drafts as inputs. Escalation: `endpoints/screening.md`.
3. **Does the Effect mapping graduate to a decision record?** Default:
   recorded standard until an implementation PR would deviate.
4. **Promote-a-law-to-a-port cost.** A future charter decision may
   need a merged-away seam; the promotion refactor is the accepted
   price of the port test. Escalation: charter #765.
5. **Resume-position persistence** (channels.md Q2): the ports take
   `Offset`/`PageToken` values and bind no persistence; the endpoint
   composition decides durability under the W6.S2 spec item.
6. **The L6 monitor**, if one ever exists, arrives as a wider `Scope`
   value, not a new port or caller arm (register 3).
7. **The transaction's message shape.** A committed collective rides one
   message; whether contributions are embedded or referenced, the
   signature-set encoding, and any transaction-kind envelope
   vocabulary are the charter's. Nothing here binds them;
   `MessageType`'s payload side is where they will land.

## References

- Alternative standardization drafts (inputs to this revision):
  `v2/drafts/layer-interface-proposals/`.
- `docs/architecture/layers.md`;
  `docs/decisions/20260723-eight-layer-stack.md` — the stack and the
  layering rules the static checks mechanize.
- `docs/spec/{identity,data-plane,control-plane}.md`,
  `docs/spec/endpoints/*`, `docs/spec/enforcement.md` — the
  guarantee-level obligations behind each law.
- `docs/decisions/20260724-{collectives-are-ledger-transactions,norms-are-mcp-skill-bundles,firewall-two-directions,monitors-are-deterministic-contracts,l7-is-policy-attached-to-identity}.md`
  — the layer models this contract realizes;
  `docs/decisions/20260723-{lifecycle-rides-l3,eval-plane-is-testbed,interim-signature-profile,protocol-version-carriage,directory-serves-cards}.md`;
  `docs/decisions/20260721-{sessionless-network,single-credential}.md`.
- `v2/drafts/v0-implementation-plan-20260723.md` — the workstream
  sketches this standardization renames into ports, values, and laws.
- v1 Effect idiom precedent: `packages/server/src/message/layer.ts`,
  re-implemented never imported.
