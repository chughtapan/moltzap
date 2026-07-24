# Layer interfaces — Proposal B: the journal and its folds

Status: DRAFT (alternative proposal; peer to `docs/spec/layer-interfaces.md`)
Bias: flows over services
Spec basis: `docs/architecture/layers.md`, `docs/spec/{identity,data-plane,control-plane}.md`,
`docs/spec/endpoints/{channels,contacts,screening,tasks}.md`, `v2/VISION.md`,
the 2026-07-21/23 decision records, `v2/drafts/v0-implementation-plan-20260723.md` (W3–W6, W8).

## Summary

Proposal A standardizes the stack as a **noun table plus a service catalog**: ~13 payload
nouns defined once, and ~16 per-layer per-party services, each a `Context.Tag` with
request/response methods (`membershipAt(...) -> AgentId[]`, `screen(...) -> GateVerdict`,
`append(...) -> Position`, `awaitAdmission(...) -> AdmittedTurn`). This proposal keeps A's
decided nouns unchanged — they are fixed by the spec — but standardizes the **surface** as
one abstraction: an **ordered append-only journal read as an Effect `Stream`, folded**. A
conversation is a fold over its transcript; membership is that fold sampled at a `Position`;
recovery is re-reading the `Stream` from an endpoint-owned `Position`; observe-before-generate
is a fold over a `Stream` of admission events; gates are `Stream` transducers that partition
attention without touching the record. Structurally: everything A models as a distinct service
method — the conversation index, the access scope, both firewall gates, the reply guard, the
turn observer, the conversation initiator — collapses into a **library of pure folds and
stream transducers** over a handful of resource ports, because each is a way of reading or
transforming the one journal, not a stateful service of its own.

## Modules

Five modules. They are interface-vocabulary groupings across the eight stack layers, not new
packages: the physical component-to-package map is inherited from the v0 plan's W1 (`v2/wire`,
`v2/identity`, `v2/server`, `v2/plane`, `v2/channel`, `v2/testbed-plane`, `v2/cli`) and not
re-litigated here. Each module names its public surface, its dependencies, and its error
channel (uniformly typed `Refusal`; see Errors).

1. **Journal** (`v2/wire` alphabet + `v2/server` storage + shared fold library).
   The spine. Owns (a) the payload **alphabet** the journal is written in — every decided
   noun; (b) the `Journal` port — append as the transactional write, read as an ordered
   `Stream<TranscriptRecord>` from a `Position`; (c) the **fold library** — pure functions
   deriving `ConversationState`/membership from the lifecycle sub-stream, run identically at
   router and endpoint; (d) `AccessScope`, the single entitlement predicate over reads.
   Depends on: the alphabet only. Realizes: L3 storage guarantees, the derived conversation
   index, durable-then-deliver, in-band lifecycle. Error channel: `Refusal`.

2. **Identity** (`v2/identity`, router + endpoint).
   Attribution as a `Stream` stage and cards as a resource. Owns `Verifier` (verify one frame
   from published material alone — the same interface recipients and L6 readers hold),
   `Author` (attribute at emit), `CardSource` (resolve/enumerate cards), `Registry` (L7
   operator-gated mint; the card is the directory entry). Binding-neutral: interim
   request-signature and target per-frame present the identical `verify` shape. Depends on:
   the alphabet. Realizes: L1 identity, L7 institutional trust. Error channel: `Refusal`.

3. **Plane** (`v2/plane` production + `v2/testbed-plane`, router + endpoint seams).
   The flows over the journal. Owns `Ship` (the endpoint's send — one attributed frame to a
   committed `Position`), `Delivery` (the endpoint's receive — a `Stream<TranscriptRecord>`
   resumable from an endpoint-owned `Position`, one-way), `Admission` (a content-blind
   `Stream` transducer that verifies and scopes frames before durability), and `Turns` (the
   PCC discipline as a `TurnState` machine folded from a `Stream<AdmissionEvent>` — the
   guarantee-level observe-before-generate signal, no lease named). Depends on: Journal,
   Identity. Realizes: L2 ordered multicast, L3 turn discipline. Error channel: `Refusal`.

4. **Gate** (`v2/channel` screening, endpoint).
   Attention as a partition. Owns `InboundGate` and `OutboundGate` — `Stream` transducers that
   split the delivery/send flow into an **attention** stream and a **diverted** stream, so a
   refused frame stays in the journal and only attention is filtered — plus `ContactBook`, the
   endpoint's trust data held in a `SubscriptionRef` so a standing change takes effect on the
   next frame, network-free. `NormBundle` (L4) enters here as gate configuration, never as a
   service. Depends on: the alphabet, Identity (verified attribution as input). Realizes: L5
   personal trust; consumes L4 norms. Error channel: `Refusal` (gate verdicts are values, not
   errors).

5. **Endpoint** (`v2/channel` core + `v2/cli`, endpoint).
   The composition root. Wires the module streams into fibers: `Channel` (the composed inbound
   `Stream` and outbound `Sink`, plus the endpoint-owned `SubscriptionRef<Position>` recovery
   cursor), the `HarnessPlugin` SPI (a `Stream`/`Sink` pair the harness supplies), and
   `Initiator` (mint a fresh `ConversationId`, emit CONVERSATION-START through the ordinary
   outbound path — no provisioning). Depends on: Plane, Gate, Identity, Journal. Realizes: the
   endpoint region; L4 task plumbing has no module. Error channel: `Refusal`.

L6 mints no module: a monitor is a `Stream` consumer — `Journal.read` piped through
`Verifier.verify` — reusing the recipient's verification path; `Evidence` is derived, and how
a monitor obtains a global `AccessScope` is register-3 open (below). L8 has no interface.

## Interfaces

Effect idiom, unchanged from v1 precedent (`packages/server/src/message/layer.ts`): each port
is a `Context.Tag` class, each realization a `Layer.effect`. The divergence is the **shape**
each port exposes — `Stream`/`Sink`/`SubscriptionRef` and pure fold functions — not the
Tag/Layer mechanism. Signatures carry typed error channels; no bodies (architecture).

### The alphabet (decided nouns; `v2/wire`; imported by reference)

```ts
import { Brand, Effect, Stream, Sink, SubscriptionRef, Scope, HashSet, Option } from "effect";

// Identity (L1). Opaque, branded; survive key rotation.
type AgentId       = string & Brand.Brand<"AgentId">;         // registry-minted
type PrincipalRef  = string & Brand.Brand<"PrincipalRef">;    // opaque linkage (depth open)
interface Card { readonly bytes: Uint8Array }                 // X.509 container; self-attesting
interface PublicKeyMaterial { readonly bytes: Uint8Array }

// Framing (L1). The frame is one encoded unit, byte-exact at every hop.
type EncodedFrame  = Uint8Array & Brand.Brand<"EncodedFrame">;
type Body          = Uint8Array & Brand.Brand<"Body">;        // opaque, never read below L4
type ProtocolVersion = string & Brand.Brand<"ProtocolVersion">; // CalVer, exact match

// The carrier-readable view. Lifecycle markers and addressing are envelope-level, so the
// content-blind plane and the fold both read them without touching the body.
interface Envelope {
  readonly sender: AgentId;
  readonly conversation: ConversationId;
  readonly protocol: ProtocolVersion;
  readonly attribution: Attribution;          // opaque proof, binding-neutral (register 5)
}
interface Attribution { readonly bytes: Uint8Array }
interface EnvelopeDraft { readonly conversation: ConversationId; readonly recipients: ReadonlyArray<AgentId> }

// A value the type system marks as verified: carries the principal attribution resolved to.
interface Attributed<A> { readonly value: A; readonly principal: PrincipalRef }

// Addressing + record (L3).
type ConversationId = string & Brand.Brand<"ConversationId">; // client-minted, collision-free by size
type Position       = bigint & Brand.Brand<"Position">;       // store-assigned; NEVER inside the frame
type Cursor         = string & Brand.Brand<"Cursor">;         // opaque, fail-closed paging token
interface TranscriptRecord { readonly frame: EncodedFrame; readonly position: Position }

// In-band lifecycle (L3, v0 vocabulary). A content-blind projection of envelope fields; the
// exact envelope encoding is open (identity.md "field set decided; encoding open").
type LifecycleEntry =
  | { readonly _tag: "Start";     readonly conversation: ConversationId; readonly founder: AgentId }
  | { readonly _tag: "MemberAdd"; readonly member: AgentId; readonly by: AgentId }
  | { readonly _tag: "Leave";     readonly member: AgentId };

// One transactional journal append. v0: MULTICAST only. Internal shape is OPAQUE and the fold
// never inspects it; the op vocabulary beyond Multicast is chartered (#765) and widens this union.
type CollectiveUnit = { readonly _tag: "Multicast"; readonly frame: EncodedFrame };

// L5 trust posture and verdict.
interface LimitConstraints { readonly bytes: Uint8Array }     // endpoint-opaque; shared DSL deferred
type Standing =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny" }
  | { readonly _tag: "Limit"; readonly constraints: LimitConstraints };
type GateVerdict =
  | { readonly _tag: "Admit" }
  | { readonly _tag: "AdmitUnderLimits"; readonly limits: LimitConstraints }
  | { readonly _tag: "Refuse"; readonly standing: Standing };

// L4 norm bundle — a value gates read; no plane representation.
interface NormBundle { readonly id: string; readonly version: ProtocolVersion }

// The one interim refusal value. Wire projection is open (register 8); this is the error-channel value.
type RefusalReason = { readonly _tag: "NotInEffect" };        // v0 single arm; register 8 widens
interface Refusal { readonly _tag: "Refusal"; readonly reason: RefusalReason }
```

### Module 1 — Journal

```ts
// The append-only, totally-ordered per-conversation record, read as a Stream. One journal,
// three views: append (the transactional write), read (an ordered Stream from a Position),
// fold (pure derivation). The PCC turn discipline wraps append from ABOVE (Plane.Turns); the
// journal exposes a transaction, never a lease.
interface Journal {
  // Append one collective unit as one transaction; Position assigned at commit-time,
  // contiguous, returned only after durability. (Storage guarantees 1, 2, 9.)
  readonly append: (unit: CollectiveUnit) => Effect.Effect<Position, Refusal>;

  // Genesis: creates the transcript with this frame as entry zero, atomic iff the id is
  // unused; reuse refuses with no side effect. (lifecycle-rides-l3; storage guarantee 5.)
  readonly appendGenesis: (frame: EncodedFrame) => Effect.Effect<Position, Refusal>;

  // Read: an ordered Stream of records from an endpoint-owned Position forward. A bounded
  // window and an open-ended live tail are the SAME Stream, resumable, never connection-state.
  // Scoped by AccessScope. (Storage guarantees 3, 4, 7, 8.)
  readonly read: (
    conversation: ConversationId,
    from: Position,
    scope: AccessScope,
  ) => Stream.Stream<TranscriptRecord, Refusal>;

  // The conversations an identity belongs to, as a paged Stream (Cursor internal).
  readonly conversations: (
    of: AgentId,
    scope: AccessScope,
  ) => Stream.Stream<ConversationId, Refusal>;
}

// A conversation is a fold over its transcript. This is the accumulator: membership plus
// phase, "as of" a Position. Nothing here is a service; it is how you READ the journal.
interface ConversationState {
  readonly members: HashSet.HashSet<AgentId>;
  readonly phase: "HalfOpen" | "Open" | "Closed";
  readonly at: Position;
}

// The pure fold step over the v0 lifecycle vocabulary — total and exhaustive (a fourth entry
// type, when #765 adds one, is a compile error here until handled).
declare const stepConversation: (s: ConversationState, e: LifecycleEntry) => ConversationState;

// foldConversation = run stepConversation over the lifecycle sub-stream. membershipAt = the
// same fold sampled at a Position. The ROUTER runs this to compute delivery sets; the
// ENDPOINT runs the identical fold to know the room. One fold, two sites — no index service.
declare const foldConversation: (
  lifecycle: Stream.Stream<LifecycleEntry, Refusal>,
) => Effect.Effect<ConversationState, Refusal>;

declare const membershipAt: (
  journal: Journal,
  conversation: ConversationId,
  at: Position,
  scope: AccessScope,
) => Effect.Effect<HashSet.HashSet<AgentId>, Refusal>;

// Content-blind projection of a record's envelope into a lifecycle entry, if any. Reads
// envelope fields only (invariant: never the body). The projection's field encoding is open.
declare const readLifecycle: (record: TranscriptRecord) => Option.Option<LifecycleEntry>;

// The single entitlement predicate over reads. v0 checks membership only; a witness, operator,
// or horizon policy plugs in here without changing any Stream shape (registers 3/4/6 open).
interface AccessScope {
  readonly admits: (
    reader: AgentId,
    conversation: ConversationId,
    at: Position,
  ) => Effect.Effect<boolean>;
}
```

### Module 2 — Identity

```ts
// Attribution verification, binding-neutral: interim request-signature and target per-frame
// present the SAME shape, so the migration (register 5) changes no downstream flow. Used as a
// Stream stage: Stream.mapEffect(Verifier.verify). Recipients and L6 readers hold this identically.
interface Verifier {
  readonly verify: (frame: EncodedFrame) => Effect.Effect<Attributed<Envelope>, Refusal>;
}

// Attribute a frame at emit; frames leave the harness already attributable, nothing downstream
// can add or repair it.
interface Author {
  readonly attribute: (envelope: EnvelopeDraft, body: Body) => Effect.Effect<EncodedFrame, Refusal>;
}

// The one card resource both regions consume. Issued-at cache and single refetch on failure
// are realization, not interface. Enumerate is the directory read (the card IS the entry).
interface CardSource {
  readonly resolve: (agent: AgentId) => Effect.Effect<Card, Refusal>;
  readonly enumerate: (from: Cursor) => Stream.Stream<Card, Refusal>;
}

// L7 institutional trust: operator-gated minting. Revocation is the registry ceasing to vouch,
// observed by the next resolve — no revocation op in the signature (register 5 open).
interface Registry {
  readonly register: (
    key: PublicKeyMaterial,
    principal: PrincipalRef,
  ) => Effect.Effect<Card, Refusal>;
}
```

### Module 3 — Plane

```ts
// The endpoint's send. One attributed frame to its committed Position; ack (the Position)
// only after durability, every refusal before it. Modeled as an Effect so the outbound Stream
// terminates via Stream.mapEffect(Ship.send); "the outbound sink" is that mapEffect. One-way:
// nothing is written back on any receive path.
interface Ship {
  readonly send: (frame: EncodedFrame) => Effect.Effect<Position, Refusal>;
}

// The endpoint's receive. A Stream of records resumable from an endpoint-owned Position — the
// sessionless bound made a type: the resume token is a Position, never a connection. Delivery
// is best-effort push OVER this Stream; the Stream (backed by Journal.read) is the source of truth.
interface Delivery {
  readonly from: (
    conversation: ConversationId,
    position: Position,
  ) => Stream.Stream<TranscriptRecord, Refusal>;
}

// Router-side admission as a content-blind Stream transducer applied BEFORE durability: verify
// attribution, sender exists and is active, sender is a member (or a genesis to a fresh id).
// Failing frames divert to the error channel before they reach Journal.append. Envelope only.
interface Admission {
  readonly transduce: (
    frames: Stream.Stream<EncodedFrame, Refusal>,
  ) => Stream.Stream<Attributed<Envelope>, Refusal>;

  // The version predicate is one content-blind stage of the transducer: exact match, refuse
  // before any state change. Exposed for the conformance corpus.
  readonly versionMatch: (envelope: Envelope) => boolean;
}

// The PCC turn discipline as a guarantee-level state machine TYPE. No lease, socket, or
// connection appears; "Revoked" is bounded-timeout expiry at guarantee level, not a lease event.
type TurnState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Awaiting"; readonly conversation: ConversationId }
  | { readonly _tag: "Admitted"; readonly conversation: ConversationId; readonly at: Position }
  | { readonly _tag: "Spent";    readonly conversation: ConversationId };

// The guarantee-level admission signal. Its WIRE carriage is the charter's (#765, turn-signal
// carriage); this type is the observe-before-generate guarantee (data-plane.md inv. 5), not the wire.
type AdmissionEvent =
  | { readonly _tag: "Granted"; readonly conversation: ConversationId }
  | { readonly _tag: "Revoked"; readonly conversation: ConversationId };

interface Turns {
  // Observe-before-generate as a Stream, not an await: the endpoint watches this and the
  // harness may generate only while the folded TurnState is Admitted. Resumable; TTL-bounded.
  readonly admissions: (
    conversation: ConversationId,
  ) => Stream.Stream<AdmissionEvent, Refusal>;

  // The exhaustive fold turning the event stream into the current permission.
  readonly stepTurn: (s: TurnState, e: AdmissionEvent) => TurnState;

  // The reply-guard, as a pure transducer: at most one frame passes per Admitted turn, others
  // held until the next admission. Absorbs A's ReplyGuard service into the flow.
  readonly gateByTurn: (
    state: SubscriptionRef.SubscriptionRef<TurnState>,
  ) => <E, R>(outbound: Stream.Stream<EncodedFrame, E, R>) => Stream.Stream<EncodedFrame, E | Refusal, R>;
}
```

### Module 4 — Gate

```ts
// Screening is a Stream transducer, not a request/response call. It PARTITIONS the delivery
// flow into an attention stream (what the agent sees) and a diverted stream (refused) — the
// record stays in the journal; only attention is filtered (screening.md inv. 2-3). The verdict
// rides each item as a value; refusal is not an error here.
interface Screened {
  readonly record: Attributed<Envelope>;
  readonly verdict: GateVerdict;
}

interface InboundGate {
  readonly screen: (
    delivered: Stream.Stream<Attributed<Envelope>, Refusal>,
    contacts: SubscriptionRef.SubscriptionRef<ContactBook>,
    norms: ReadonlyArray<NormBundle>,
  ) => Effect.Effect<
    readonly [attention: Stream.Stream<Screened, Refusal>, diverted: Stream.Stream<Screened, Refusal>],
    never,
    Scope.Scope
  >;
}

// Outbound: a transducer over the send flow; refused sends never reach Ship. Send-when-expected
// and norm adherence are the rule inputs (L4 norms + turn state as context).
interface OutboundContext {
  readonly norms: ReadonlyArray<NormBundle>;
  readonly turn: TurnState;
}
interface OutboundGate {
  readonly screen: (
    outbound: Stream.Stream<EncodedFrame, Refusal>,
    context: OutboundContext,
  ) => Stream.Stream<EncodedFrame, Refusal>;
}

// The endpoint's trust data as a SubscriptionRef so gate transducers observe a standing change
// on the next frame, with zero network involvement. Default posture applies absent a record.
interface ContactBook {
  readonly standing: (agent: AgentId) => Standing;
  readonly defaultPosture: "Open" | "Closed";
}
declare const setStanding: (
  ref: SubscriptionRef.SubscriptionRef<ContactBook>,
  agent: AgentId,
  standing: Standing,
) => Effect.Effect<void>;
```

### Module 5 — Endpoint

```ts
// An inbound item after screening + enrichment: the screened record plus the annotations the
// harness prompt wants (sender standing, norm text). Enrichment is additive, never a floor.
interface Enriched {
  readonly screened: Screened;
  readonly standing: Standing;
}
// What the harness wants to send: a body plus addressing; the channel frames and ships it.
interface Outgoing { readonly conversation: ConversationId; readonly body: Body }

// The channel is a composition of fibers wiring the module streams end to end. It owns the
// recovery cursor as endpoint state — a SubscriptionRef<Position>, advanced only after the
// harness durably accepts a record (peek-then-commit). Recovery = re-read from here. No session.
interface Channel {
  readonly inbound: Stream.Stream<Enriched, Refusal>;              // delivery -> verify -> gate -> enrich
  readonly outbound: (out: Outgoing) => Effect.Effect<Position, Refusal>; // gate -> turn-gate -> ship
  readonly cursor: SubscriptionRef.SubscriptionRef<Position>;     // endpoint-owned; never plane state
}

// The harness SPI: a Stream/Sink pair. The plugin consumes the enriched inbound stream and
// emits outgoing values; it owns prompt formatting and batching and never touches the wire.
interface HarnessPlugin {
  readonly consume: (inbound: Stream.Stream<Enriched, Refusal>) => Effect.Effect<void, never, Scope.Scope>;
  readonly produce: () => Stream.Stream<Outgoing>;
}

// Conversation initiation: mint a fresh id (collision-free by size), emit CONVERSATION-START
// through the ordinary outbound path. No provisioning — genesis is just the first frame. Pure
// composition over Author + Ship; A's ConversationInitiator service dissolves into this.
interface Initiator {
  readonly initiate: (
    members: ReadonlyArray<AgentId>,
    body: Body,
  ) => Effect.Effect<ConversationId, Refusal>;
}
```

### The ports (Context.Tags needing a Layer)

Ten resource ports plus one consumer-supplied SPI. Everything else above — `stepConversation`,
`foldConversation`, `membershipAt`, `readLifecycle`, `InboundGate`/`OutboundGate` transducers,
`Turns.stepTurn`/`gateByTurn`, `Initiator`, `Channel` — is a **pure fold or stream combinator**,
constructed from the ports, holding no Layer of its own.

```ts
class JournalTag     extends Context.Tag("moltzap/v2/Journal")<JournalTag, Journal>() {}
class VerifierTag    extends Context.Tag("moltzap/v2/Verifier")<VerifierTag, Verifier>() {}
class AuthorTag      extends Context.Tag("moltzap/v2/Author")<AuthorTag, Author>() {}
class CardSourceTag  extends Context.Tag("moltzap/v2/CardSource")<CardSourceTag, CardSource>() {}
class RegistryTag    extends Context.Tag("moltzap/v2/Registry")<RegistryTag, Registry>() {}
class ShipTag        extends Context.Tag("moltzap/v2/Ship")<ShipTag, Ship>() {}
class DeliveryTag    extends Context.Tag("moltzap/v2/Delivery")<DeliveryTag, Delivery>() {}
class AdmissionTag   extends Context.Tag("moltzap/v2/Admission")<AdmissionTag, Admission>() {}
class TurnsTag       extends Context.Tag("moltzap/v2/Turns")<TurnsTag, Turns>() {}
class ContactBookTag extends Context.Tag("moltzap/v2/ContactBook")<ContactBookTag, SubscriptionRef.SubscriptionRef<ContactBook>>() {}
class HarnessPluginTag extends Context.Tag("moltzap/v2/HarnessPlugin")<HarnessPluginTag, HarnessPlugin>() {} // consumer-supplied SPI
```

The **layering rule** is a graph property exactly as in A, and stronger here: a `Layer`
building a level-N port requires only tags at levels <= N. Because the interpretive work
(membership, screening, turns) is pure folds rather than ports, the port graph is smaller and
its acyclicity is easier to check — the folds cannot introduce an upward edge because they are
not in the dependency graph at all. The production and testbed planes are the SAME ports
(`ShipTag`, `DeliveryTag`, `AdmissionTag`, `TurnsTag`) under two `Layer`s;
implementation-swap equivalence (data-plane.md inv. 11) is one `Layer` substitution.

## Data flow

Three flows share one journal. ASCII; every arrow is a `Stream`/`Sink`/`Effect` edge, every
side-branch names the `Refusal` that diverts there.

```
OUTBOUND (endpoint -> router)                         Refusals (diverted before durability)
  harness.produce : Stream<Outgoing>
      | Stream.map(frame via Author.attribute) ......> Refusal (cannot attribute)
      v
  OutboundGate.screen (transducer, norms+turn) .....> refused sends dropped (agent-local)
      v
  Turns.gateByTurn(cursor of TurnState) ............> held until next Admitted  (reply-guard)
      v
  Stream.mapEffect(Ship.send)
      |                                    [ wire seam / Q10, in-process here ]
      v
  Admission.transduce (router, envelope-only) ......> Refusal (attribution / not-member /
      |   verify . versionMatch . member?               version mismatch) BEFORE durability
      v
  Journal.append(CollectiveUnit)  --commit-> Position (ack)     [durable-then-deliver]


INBOUND (router -> endpoint)                          The record NEVER leaves the journal
  Journal (committed record)
      | fan-out is an optimization over the store
      v
  Delivery.from(conversation, cursor.get) : Stream<TranscriptRecord>   <-- resumes from Position
      | Stream.mapEffect(Verifier.verify) .........> Refusal (bad attribution) -> divert, keep record
      v
  InboundGate.screen(contacts, norms)  == Stream.partition ==>
      |                                               \
   attention: Stream<Screened>                     diverted: Stream<Screened>  (refused;
      |  enrich (standing, norm text)                          still in the journal, unseen)
      v
  harness.consume : Stream<Enriched>
      |  on durable accept: SubscriptionRef.set(cursor, record.position)   (peek-then-commit)
      v
  RECOVERY = re-run Delivery.from(conversation, cursor.get); resuming at a Position is
            semantically identical to never disconnecting (sessionless).


ADMISSION-OBSERVE (the fold that authorizes generation)
  Turns.admissions(conversation) : Stream<AdmissionEvent>   (Granted / Revoked; TTL-bounded)
      | Stream.scan(TurnState.Idle, Turns.stepTurn)
      v
  SubscriptionRef<TurnState> ----> read by Turns.gateByTurn (outbound) and by the harness:
                                   generate ONLY while Admitted.  (observe-before-generate)


CONVERSATION-AS-FOLD (one fold, two sites)
  Journal.read(conversation, 0, scope) : Stream<TranscriptRecord>
      | Stream.filterMap(readLifecycle)          (content-blind; envelope only)
      v
  Stream.scan(ConversationState.empty, stepConversation) --sample at Position--> membershipAt
      router: membershipAt -> delivery set      endpoint: membershipAt -> "who is in the room"
```

L6 monitor: `Journal.read(conv, 0, monitorScope) |> Stream.mapEffect(Verifier.verify)` — the
recipient's own verification path over recorded frames; `Evidence` is the verified stream.
`monitorScope` is the open register-3 seam.

## Errors

One typed error value crosses every port boundary: `Refusal` in the Effect/Stream error
channel (`Effect<A, Refusal>`, `Stream<A, Refusal>`). Defects never cross a port boundary — a
subscriber registry isolates them, and streams fail with `Refusal`, never throw. Three tagged
unions are the exhaustive discriminants implementations must handle; each is a compile-time
`switch`-to-`never`:

- **`Refusal.reason`** — v0: `{ _tag: "NotInEffect" }` only. The register-8 taxonomy widens
  this union; no signature binds its wire projection. This is the ONLY error-channel value.
- **`GateVerdict`** — `Admit | AdmitUnderLimits | Refuse`. A verdict is a **value on a record**,
  not an error: it rides the `Screened` item so the diverted partition still carries the record.
- **`AdmissionEvent`** / **`TurnState`** — `Granted | Revoked` folded to
  `Idle | Awaiting | Admitted | Spent`. Exhaustive; a fifth state (were #765 to add one) is a
  compile error at every fold site.

Two more closed unions are decode-boundary, not error-channel: `LifecycleEntry`
(`Start | MemberAdd | Leave`, widened by #765) and `CollectiveUnit` (`Multicast`, widened by
#765). Their exhaustive folds are where a new charter op forces a handler.

## Dependencies

| Library | Version | License | Why this one |
|---|---|---|---|
| `effect` | 3.22.0 | MIT | The mandated realization substrate (constraint 4); workspace-pinned, the version v1 uses. `Stream`, `Sink`, `Queue`, `SubscriptionRef`, `Fiber`, `Scope` are the exact vocabulary this proposal is built from — flows are `Stream`, resources are `Context.Tag`+`Layer`, endpoint-owned cursors are `SubscriptionRef`, turn observation is a scanned `Stream`. No other runtime dependency. |

No new dependency beyond what A's realization also requires; the difference is which parts of
`effect` are load-bearing (`Stream`/`Sink`/`SubscriptionRef` here vs. `Context`/`Layer` alone in A).

## Traceability

Spec guarantee/invariant (doc + number) -> the interface that carries it.

| Guarantee / invariant | Source | Interface |
|---|---|---|
| Attribution verifiable from frame + published material alone | identity.md inv. 1, 2 | `Verifier.verify -> Attributed<Envelope>` |
| Attribution covers body + addressing; never interprets body | identity.md inv. 4 | `Author.attribute`; `readLifecycle` reads envelope only |
| Identity attests who, not intent | identity.md inv. 5 | `Attributed<A>.principal`; no trust field on any alphabet noun |
| Frame byte-exact at every hop | identity.md (Byte preservation); data-plane.md inv. 13 | `EncodedFrame` in `TranscriptRecord`; every port passes it unaltered |
| Store-assigned fields never inside the attributed unit | identity.md (Not frame fields) | `Position` sits beside `frame` in `TranscriptRecord`, never in `Envelope` |
| One shape, two attribution bindings | identity.md (One shape...) | `Verifier`/`Author` binding-neutral; migration is a `Layer` swap |
| Routing/admission read envelope only | data-plane.md inv. 1 | `Admission.transduce`, `versionMatch`, `readLifecycle` — envelope-typed inputs |
| Plane never mints/alters/strips attribution | data-plane.md inv. 2 | `Admission` yields `Attributed<Envelope>` unchanged; no mint API |
| Per-conversation total order; converge on recovery | data-plane.md inv. 3; storage guarantee 2 | `Journal.read` ordered `Stream`; `Delivery.from(Position)` resumable |
| Durable-then-deliver | data-plane.md inv. 4; storage guarantee 1 | `Journal.append` returns `Position` only post-durability; `Delivery` fed after commit |
| Turn-disciplined admission observed before generation | data-plane.md inv. 5 | `Turns.admissions` `Stream` folded to `TurnState`; generate only while `Admitted` |
| At most one send per admitted turn | data-plane.md (Implementation notes) | `Turns.gateByTurn` transducer |
| One-way delivery; responses are first-class sends | data-plane.md inv. 14 | `Delivery.from` is read-only `Stream`; `Ship.send` is the only write |
| Admission never mutates membership | data-plane.md inv. 9 | `Admission` yields records; membership is a fold, not written by admission |
| Membership changes in-band, ordered | data-plane.md inv. 8; storage guarantee 5 | `LifecycleEntry` in the same `Journal` order; `stepConversation` |
| Equivocation robustness | data-plane.md inv. 7 | single `Journal`, byte-exact fan-out `Stream` — one copy for all readers |
| No per-endpoint connection/session state | data-plane.md inv. 12; sessionless decision | resume token is `Position`; `SubscriptionRef<Position>` is endpoint-local |
| No data-plane interface names/carries a task | data-plane.md inv. 10 | no task noun in the alphabet; `NormBundle` is gate config, endpoint-only |
| Implementation-swap equivalence | data-plane.md inv. 11 | production/testbed = same `Ship`/`Delivery`/`Admission`/`Turns` tags, two `Layer`s |
| Store-owned total order; ordered/immutable reads | control-plane.md storage guarantees 2, 3, 6 | `Position` assigned in `Journal.append`; `read` is an ordered `Stream`; no update op |
| Recovery by reading | control-plane.md storage guarantee 4 | `Delivery.from` == `Journal.read` from an owned `Position` |
| Content-blind store | control-plane.md storage guarantee 7 | `Body` opaque; `readLifecycle` envelope-only |
| Member-scoped reads; witness/operator open | control-plane.md storage guarantee 8 | `AccessScope.admits`; v0 membership, seam for the rest |
| Collective commits as one transactional unit | control-plane.md storage guarantee 9 | `Journal.append(CollectiveUnit)` — one unit, one transaction |
| Genesis checks attribution + id freshness only | lifecycle-rides-l3 | `Journal.appendGenesis` atomic-iff-unused; no create op |
| Conversation id client-minted | lifecycle-rides-l3 | `Initiator.initiate` mints `ConversationId`; plane mints none |
| Sessionless: two caller classes, no establishment | control-plane.md inv. 3, 7 | ports take a signed request per call; no connect port anywhere |
| The card is the directory entry | directory-serves-cards | `CardSource.enumerate -> Stream<Card>`; `Registry.register -> Card` |
| Revocation = registry ceases to vouch | identity.md; single-credential | no revocation op; `CardSource.resolve` reflects it at next read |
| Screening filters attention, never the record | screening.md inv. 2-3; acceptance | `InboundGate.screen` partitions; the diverted `Stream` keeps the record |
| Verdicts agent-local; no wire representation | screening.md inv. 3 | `GateVerdict` is a value on `Screened`; no port emits it outward |
| Gate = f(frame, attribution, norms, own contacts) | contacts.md inv. 2 | `InboundGate.screen` inputs exactly those; no peer trust data |
| Contact data endpoint-resident; immediate effect | contacts.md inv. 1, 4 | `ContactBook` in a `SubscriptionRef`; `setStanding` local; no router port |
| Default posture absent a record | contacts.md inv. 3 | `ContactBook.defaultPosture` |
| Router answers no "are A and B in contact" | contacts.md (What the router sees) | no contact noun on any router port; `ContactBook` is endpoint-only |
| Norms bind only pinners; no plane agreement check | tasks.md inv. 1, 2 | `NormBundle` enters only `InboundGate`/`OutboundGate`; no plane port reads it |
| Channel owns recovery position; loses no message/turn | channels.md inv. 1, 2 | `Channel.cursor: SubscriptionRef<Position>`; turn state is TTL-bounded, not connection |
| Plugins pure consumers; two runtimes interoperate | channels.md inv. 3; acceptance | `HarnessPlugin` `Stream`/`Sink` SPI; no wire access |
| L6 re-verifies recorded frames, no live sender | identity.md acceptance; enforcement | `Journal.read |> Verifier.verify`; monitor mints no principal |

## Open questions

Each leaves a chartered/open item open **by construction** and carries a recommended default.

1. **Point-in-time queries vs. re-folding cost (the accepted trade-off).** Membership "right
   now" and a contact's standing are folds, not O(1) service calls as in A
   (`membershipAt(id,pos) -> AgentId[]`, `standing(id) -> Standing`). Recommended default:
   maintain each hot fold in a `SubscriptionRef` (materialized `ConversationState`,
   `ContactBook`) updated by the journal/contacts stream, so a read is a ref-get and only a
   cold conversation re-folds from `Position 0`. Escalation target: W4/W6 code review measures
   whether cold re-folds need a snapshot cache. This is realization freedom the conformance
   suite need not see.

2. **Collective-semantics op set (#765).** Left open: `CollectiveUnit` is a closed v0 union
   (`Multicast`) that #765 widens, and the fold library never inspects a unit's internal shape.
   Recommended default: keep `append` taking `CollectiveUnit` opaque; add op arms as union
   arms, forcing an exhaustive-fold compile error where a new op needs handling. Nothing here
   binds completion, failure, concurrency, witnesses, or presence — no port or fold names them.

3. **Turn-signal wire carriage (#765).** Left open: `AdmissionEvent`/`TurnState` are
   guarantee-level types (observe-before-generate), and their carriage is explicitly the
   charter's. Recommended default: the interim signal rides inside the Plane's `Layer` as
   non-normative mechanism; no spec text, public type, or property names the wire shape. The
   charter replaces the mechanism without touching `Turns`.

4. **Data-plane wire shape (data-plane.md Q10).** Left open: `Ship`, `Delivery`, `Admission`
   are in-process ports; the wire seam sits inside their `Layer`s. Recommended default: bind no
   `Stream` framing, feed scope, or cursor encoding in the interface; a wire choice rewrites the
   `Layer`, not any signature. `Position` is the only resume token either way.

5. **Key model (register 5).** Left open: `Verifier`/`Author` are binding-neutral; no rotation,
   revocation, or per-frame-signing op appears. Recommended default: the interim request
   signature and the target per-frame signature are two `Layer`s behind the same tags; the
   migration is a `Layer` swap, invisible to every flow.

6. **Refusal wire projection (register 8).** Left open: `Refusal` is one error-channel value;
   its wire shape is unbound. Recommended default: conformance asserts refusal **effect**
   (diverted before durability, record withheld from attention) and never shape or code; the
   register-8 taxonomy widens `RefusalReason` without changing any signature.

7. **Excess-key / strict-decode normativity (register 9).** Left open: schemas decode at the
   `EncodedFrame`/`Envelope` boundary, but no interface asserts excess-key rejection.
   Recommended default: strict decode is a realization default in no normative text; any
   strict-decode test is a non-normative pin, machine-prevented from gating acceptance.

8. **Monitor access (register 3).** Left open: L6 is a `Journal.read |> Verifier.verify`
   consumer, and the global view a monitor needs is exactly an `AccessScope` wider than
   membership — the seam is present, the wider scope unbuilt. Recommended default: v0 mints no
   monitor principal and no third caller class; a monitor runs through member-scoped
   `AccessScope`, and the register-3 decision later supplies a wider `AccessScope` `Layer`
   without a new port.

9. **Cursor persistence (channels.md Q2).** Left open: `Channel.cursor` is a
   `SubscriptionRef<Position>`; what the endpoint must durably keep across restarts is a spec
   item, not assumed here. Recommended default: peek-then-commit (advance only after durable
   harness accept) is the candidate shape, decided by the channels.md Q2 spec item; the
   interface holds the `Position`, the persistence obligation is deferred.

10. **Module-to-package granularity.** Left open: the five modules are interface groupings; the
    physical package map is the v0 plan's W1. Recommended default: adopt W1's map unchanged
    (`v2/wire`, `v2/identity`, `v2/plane`, `v2/channel`, `v2/server`, `v2/testbed-plane`,
    `v2/cli`); this proposal changes the interface vocabulary, not the package layout.
