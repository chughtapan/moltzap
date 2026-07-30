> **Archived historical, non-normative input.** The Gate 1 package and
> interface boundary is `docs/spec/layer-interfaces.md`.

# Layer interfaces — Proposal B: choreographies, interfaces by projection

Status: DRAFT (alternative standardization proposal; peer to
`docs/spec/layer-interfaces.md`, Proposal A)
Bias: choreography first — the interaction is the unit; every party
interface is a projection of it.

Spec basis: `docs/architecture/layers.md`;
`docs/spec/{identity,data-plane,control-plane}.md`;
`docs/spec/endpoints/{channels,contacts,screening,tasks}.md`;
`v2/VISION.md`;
`docs/decisions/20260723-{eight-layer-stack,lifecycle-rides-l3,eval-plane-is-testbed,interim-signature-profile,protocol-version-carriage,directory-serves-cards}.md`;
`docs/decisions/20260721-{sessionless-network,single-credential}.md`;
`v2/drafts/v0-implementation-plan-20260723.md` (W3–W6, W8).

## Summary

The four prior proposals all standardize a **party's** surface: A a
service catalog (per-layer, per-party `Context.Tag`s), schema-first a
payload-schema registry with boundaries as codecs, minimal-ports five
swap-axis ports plus laws, stream-journal one append-only journal read
as folds. Each authors the party interfaces directly. This proposal
moves the center of gravity off the party entirely: the standardized
artifact is a small **catalog of global choreographies** — typed
descriptions of a multi-party interaction as roles, moves, and protocol
states — and **every party interface is `project(choreography, role)`,
a derived output, never hand-written**. Where the priors differ in what
they put at the center (service / schema / port / journal), all four
put a *party* there; the interaction that spans parties is reconstructed
from their surfaces. Here the interaction is primary and the surfaces
are its shadows.

Two things fall out that no prior makes structural. First, the
observe-before-generate guarantee (data-plane inv. 5) becomes a
compile-time **typestate**: the Speaker's projected interface offers the
`contribute` move only from an `Admitted` role position whose sole
constructor is receiving the router's `Admit` move, so "you may move
only in state Admitted" is a type, not a check, a law, or a stream fold.
The one-shot reply guard and one-way delivery (inv. 14) are the same
kind of type-level fact — the Speaker's `contribute` consumes the
Admitted position, and the Member's projection carries no move on the
delivery edge. Second, extension is **adding a choreography, not an
interface**: #765 widens the *network-standard* catalog with new
collective choreographies re-projected at spec time, and L4 task norms
are **user-supplied choreographies over the same vocabulary, projected
only at the endpoint and carried as opaque `Multicast` bodies** — so the
network's projection domain stays exactly the standard catalog and the
network knows no task protocol by construction.

Openness is by construction throughout. Every chartered or register-open
question maps to a choreography, role, move, or carriage the v0 catalog
does not name: the collective vocabulary beyond `Multicast` is an unbuilt
set of choreographies (#765); the turn-signal and delivery carriage live
inside a move's realization, named by no projected signature
(data-plane Q10, charter); the interim/target attribution binding is two
realizations of the same projected `Author`/`Verifier` roles (register 5);
the L6 monitor mints no role (register 3); `Refusal`'s wire shape is
unbound (register 8); decode strictness is a realization option no
choreography law asserts (register 9).

**Compile-time vs conformance-checked.** The projected *shape* — which
moves exist, in which state, on which edge, with which payload and typed
refusal — is compile-time (types). The projected *soundness* — that the
role realizations, composed, actually realize the global choreography
(ordering, durable-then-deliver, admission-before-generation, one-way,
byte-exactness, swap-equivalence) — is conformance-checked (laws). v0
ships the standard catalog's hand-projected local interfaces plus the
soundness laws; a generic value-level projector (the runtime
"here are your legal next moves" artifact `v2/VISION.md` records as the
deferred contract layer) is L4 machinery, deliberately not built.

## Modules

Interface-vocabulary groupings across the eight stack layers, not a
package count. The physical component-to-package map is the v0 plan's W1
(`v2/wire`, `v2/identity`, `v2/server`, `v2/plane`, `v2/channel`,
`v2/testbed-plane`, `v2/cli`, `v2/conformance`) and is not re-litigated
here; a choreography's roles project into whichever packages own those
parties.

1. **`v2/wire` — the alphabet + the choreography vocabulary.** Two
   things. (a) The decided payload nouns, unchanged from the spec and
   from prior convergence — every proposal agrees these are fixed:
   `AgentId`, `PrincipalRef`, `Card`, `EncodedFrame`, `Envelope`, `Body`,
   `ProtocolVersion`, `ConversationId`, `Position`, `Cursor`,
   `TranscriptRecord`, `TranscriptUnit` (`CollectiveUnit` + `LifecycleEntry`),
   `Standing`, `GateVerdict`, `Refusal`. (b) The vocabulary primitives a
   choreography is written in — `Role`, `Move`, `Protocol`, and the
   `Project` marker. Owns the `ProtocolVersion` exact-match comparator
   and strict-decode machinery (normativity register-open; machinery
   only). Depends on: `effect` (`Schema`, `Brand`). This is the
   currency; every choreography's moves carry these nouns byte-for-byte.

2. **`choreography` — the standard catalog + the projection discipline
   (the kernel).** The seven global choreographies of the v0 catalog
   (below), each as a `Protocol` value naming its roles, its move
   alphabet, and its state machine; the `project` discipline that yields
   a role's local protocol; and the projection-soundness law set the
   conformance suite runs. This module is the standardization surface —
   it holds no realization. Depends on: `v2/wire`, `effect`. Everything
   else *realizes* a projection of something here.

3. **Router realization** (home `v2/server`). Realizes the router's
   projection of every choreography that has a router role:
   `Contribution` (admission guards, the commit into the transcript
   store, one-way fan-out), the `Lifecycle` family (genesis-freshness
   guard, membership as a fold), `Recovery` (scoped reads), and
   `Directory` (the control-plane identity family; the card is the
   entry). Owns the transcript store behind the `Commit` move and the
   derived membership fold. Depends on: `choreography`, `v2/wire`.

4. **Endpoint realization** (home `v2/channel`). Realizes the endpoint's
   projections: the `Speaker`/`Member`/`Founder` local protocols with
   typestate role positions; the L5 gates as the projected guards on the
   Member-receive and Speaker-send edges (`GateVerdict` a success value);
   contacts as endpoint-local trust data; the `Recovery` reader from an
   endpoint-owned `Position`; the `ContactFormation` endpoint
   choreography (whose router projection is empty); the harness-plugin
   mount; and the **user-choreography seam** — where an L4 norm bundle's
   projection would plug in (deferred; v0 consumes the bundle as gate
   rules only). The interpretive locus: the only region that decodes a
   `GateVerdict` or a task move. Depends on: `choreography`, `v2/wire`.

5. **Testbed realization** (home `v2/testbed-plane`). A second
   realization of the same `Contribution` and `Recovery` projections,
   plus envelope-level observation and bounded injection. The swap
   (data-plane inv. 11) is: rebind this realization Layer; every
   projected interface and every choreography above is unchanged.
   Depends on: `choreography`, `v2/wire`.

6. **`v2/conformance` — the soundness and swap laws** (W8-owned per the
   v0 plan's resolution 1). Runs, for each realization, "conforms to its
   projected local protocol"; for each global choreography, "the ensemble
   of role realizations realizes it"; plus the cross-cutting laws
   (byte-exactness, durable-then-deliver, one-way, admission-before-
   generation) and the swap-equivalence runner over the two `Contribution`
   realizations. Depends on: `choreography`, `v2/wire`.

Folder shape: `v2/wire` and `choreography` are a two-layer stack
(choreography imports the alphabet, never the reverse); the three
realizations are a tree (peers, none importing another); conformance is
a leaf over both kernel modules. Visible from the listing: alphabet and
catalog below, realizations beside, laws at the edge.

## Interfaces

TypeScript with typed error channels; no bodies. `Effect<A, E, R>` reads
"succeeds with `A`, fails with `E`, needs `R`." `Stream<A, E>` is an
ordered, resumable read. Role positions are phantom-typed; a position is
**never a connection or a session** (the sessionless decision bans the
word) — it is TTL-bounded coordination state, reconstructible from an
endpoint-owned `Position` by replaying `Recovery`.

### The alphabet (`v2/wire`; decided nouns, imported by reference)

```ts
import type { Brand } from "effect/Brand";
import type { Effect } from "effect/Effect";
import type { Stream } from "effect/Stream";
import type { Option } from "effect/Option";

export type AgentId = string & Brand.Brand<"AgentId">;             // registry-minted, opaque, survives rotation
export type PrincipalRef = string & Brand.Brand<"PrincipalRef">;   // opaque linkage (depth open)
export type ConversationId = string & Brand.Brand<"ConversationId">; // client-minted, collision-free by size
export type ProtocolVersion = string & Brand.Brand<"ProtocolVersion">; // CalVer; matched exact, missing segments = 0
export type Position = string & Brand.Brand<"Position">;           // store-assigned; NEVER inside the attributed unit
export type Cursor = string & Brand.Brand<"Cursor">;               // opaque, fail-closed paging token
export type Body = Uint8Array & Brand.Brand<"Body">;               // opaque; never interpreted below L4
export type EncodedFrame = Uint8Array & Brand.Brand<"EncodedFrame">; // the attributed unit; byte-exact at every hop
export type Card = Uint8Array & Brand.Brand<"Card">;               // X.509 cert bytes; self-attesting
export type PublicKey = Uint8Array & Brand.Brand<"PublicKey">;     // Ed25519 SPKI

/** Carrier-readable view; routing and admission read only these (content-blind). */
export interface Envelope {
  readonly sender: AgentId;
  readonly conversation: ConversationId;
  readonly protocol: ProtocolVersion;
}
/** Result of a successful open(): the readable envelope plus the exact verified bytes. */
export interface Attributed {
  readonly envelope: Envelope;
  readonly frame: EncodedFrame;
}
/** Store record: the frame byte-exact plus its store-assigned position (Position OUTSIDE the frame). */
export interface TranscriptRecord {
  readonly frame: EncodedFrame;
  readonly position: Position;
}

/**
 * What a Contribute move carries. The op set and the lifecycle-entry set are OPEN unions:
 * v0 has exactly the arms below; charter #765 adds arms by adding a choreography (below),
 * which widens this union and forces an exhaustive-match compile error at every handler.
 */
export type TranscriptUnit = CollectiveUnit | LifecycleEntry;
export type CollectiveUnit =
  | { readonly _tag: "Multicast"; readonly frame: EncodedFrame }; // v0: the only collective
export type LifecycleEntry =
  | { readonly _tag: "Start"; readonly frame: EncodedFrame }      // genesis
  | { readonly _tag: "MemberAdd"; readonly frame: EncodedFrame }
  | { readonly _tag: "Leave"; readonly frame: EncodedFrame };

/** L5 posture and verdict. GateVerdict is a SUCCESS-channel value on a delivered item, never a Refusal. */
export type Standing =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny" }
  | { readonly _tag: "Limit"; readonly limits: Limits };
export type Limits = ReadonlyArray<string & Brand.Brand<"Limit">>; // endpoint-defined, opaque (contacts rec. 6)
export type GateVerdict =
  | { readonly _tag: "Admit" }
  | { readonly _tag: "AdmitUnderLimits"; readonly limits: Limits }
  | { readonly _tag: "Refuse" };

/** The one interim refusal value (register 8, open). Its WIRE projection is deliberately NOT bound. */
export type RefusalReason = string & Brand.Brand<"RefusalReason">; // opaque; closing it would bind the taxonomy
export interface Refusal { readonly _tag: "Refusal"; readonly reason: RefusalReason }
```

### The choreography vocabulary (`v2/wire`)

```ts
/**
 * A MOVE: a typed interaction step from one role to another (or to the multicast
 * membership). The payload is an alphabet noun; the guard names the typed refusal a
 * receiver may raise BEFORE the move takes effect. Moves are the only way protocol state advances.
 */
export interface Move {
  readonly tag: string;
  readonly from: Role;
  readonly to: Role | "membership";
}

/** A ROLE is an abstract participant (Speaker, Router, Member, Founder, Registry, ...), not an identity. */
export type Role = string & Brand.Brand<"Role">;

/**
 * A CHOREOGRAPHY (global protocol): roles, a move alphabet, and a state machine over moves.
 * This is the unit of specification. Its projection onto a role is that role's local protocol.
 */
export interface Protocol<S extends string, M extends Move> {
  readonly name: string;
  readonly roles: ReadonlyArray<Role>;
  readonly moves: ReadonlyArray<M>;
  readonly initial: S;
  readonly step: (state: S, move: M["tag"]) => Option.Option<S>; // the global state machine
}

/**
 * PROJECTION marker. `project(G, r)` yields role r's local protocol: a state-indexed
 * interface exposing exactly the moves r may make or receive in each state. v0 ships the
 * standard catalog's projections as the normative local interfaces below (hand-projected;
 * soundness pinned by a conformance law). A generic value-level projector is the deferred
 * L4 contract-layer machinery, so the endpoint can later project a USER choreography into
 * "here are your legal next moves" (v2/VISION → What We Know). The network never runs it.
 */
export type Project<G, R extends Role> = unknown; // documented discipline; the projected outputs are the surface
```

### Standard catalog — C1 Attribution (L1)

Binding-neutral. Interim (sign the request) and target (sign the frame)
are two realizations of the same projected roles, so recipients and L6
readers verify identically under both (register 5, open).

```ts
// project(Attribution, Author). The sender's harness is the ONLY sealer; frames leave already
// attributable and nothing downstream can add or repair attribution (identity inv. 2). The private
// key is realization state, never a parameter.
export interface Author {
  readonly seal: (envelope: Envelope, body: Body) => Effect<EncodedFrame, Refusal, never>;
}

// project(Attribution, Verifier). Offline from frame + card alone; identical shape both bindings.
// Recipients, the router at admission, and L6 readers all hold THIS projection.
export interface Verifier {
  readonly open: (frame: EncodedFrame, card: Card) => Effect<Attributed, Refusal, never>;
}
```

### Standard catalog — C2 Contribution (L2 + L3-delivery + PCC)

The ship-admit-commit-deliver exchange under turn discipline: the
mechanism every transactional unit rides. Global shape:

```
roles:  Speaker, Router, Member (the multicast membership)
states (Speaker): Idle --RequestTurn--> Contending --Admit(recv)--> Admitted --Contribute--> Spent
moves:  RequestTurn : Speaker -> Router
        Admit       : Router  -> Speaker      (grants the turn; observe-before-generate)
        Contribute  : Speaker -> Router       (the attributed TranscriptUnit; enabled ONLY in Admitted)
        Commit      : Router internal         (durable append -> Position; the transactional unit)
        Deliver     : Router  -> membership   (one-way; TranscriptRecord; no reply on this edge)
guards: Admit precedes Contribute by construction; Router refuses BEFORE Commit (durable-then-deliver);
        admission reads ENVELOPE only (content-blind); Admitted expires by bounded timeout (Revoked), TTL-only.
```

```ts
export type SpeakerState = "Idle" | "Contending" | "Admitted" | "Spent";

/**
 * A Speaker role POSITION at a protocol state. Phantom-typed: the state parameter gates which
 * moves exist. NOT a session or connection — it is TTL-bounded coordination state, reconstructible
 * from the endpoint-owned Position via Recovery. `at` is the last observed store position.
 */
export interface SpeakerAt<S extends SpeakerState> {
  readonly _state: S;
  readonly conversation: ConversationId;
  readonly at: Position;
}

// project(Contribution, Speaker). Observe-before-generate is STRUCTURAL: the only constructor of
// SpeakerAt<"Admitted"> is awaitAdmit (receiving the router's Admit move). `contribute` exists only
// on Admitted and CONSUMES it (the one-shot reply guard) yielding Spent.
export interface Speaker {
  readonly requestTurn: (pos: SpeakerAt<"Idle">) => Effect<SpeakerAt<"Contending">, Refusal, never>;
  readonly awaitAdmit: (pos: SpeakerAt<"Contending">) => Effect<SpeakerAt<"Admitted">, Refusal, never>;
  readonly contribute: (
    pos: SpeakerAt<"Admitted">,
    unit: TranscriptUnit,
  ) => Effect<readonly [Position, SpeakerAt<"Spent">], Refusal, never>; // ack (Position) only after durability
}

// project(Contribution, Router). Admission guards read the ENVELOPE only; every refusal precedes
// Commit. The wire between Speaker.contribute and Router.admit is the Contribution realization's
// concern (data-plane Q10), named by no signature here.
export interface AdmittedContribution { readonly attributed: Attributed; readonly unit: TranscriptUnit }
export interface RouterContribution {
  readonly admit: (frame: EncodedFrame) => Effect<AdmittedContribution, Refusal, never>; // open + membership; envelope-only
  readonly commit: (admitted: AdmittedContribution) => Effect<Position, Refusal, never>; // durable append; the transactional unit
  // Deliver is one-way fan-out to membershipAt(position); an optimization over the store, never source of truth.
}

// project(Contribution, Member). One-way delivery is STRUCTURAL: there is NO move on the delivery edge
// back to the router. A member's response is a fresh Contribution (a new Speaker position), never a reply here.
export interface Member {
  readonly deliveries: (
    conversation: ConversationId,
    from: Position,
  ) => Stream<TranscriptRecord, Refusal>; // resumable; resuming at a Position == never disconnecting
}
```

### Standard catalog — C3 Multicast (L3 collective)

v0's only collective choreography. It **specializes** C2: a `Multicast`
unit is exactly one Contribution. #765 adds collective choreographies
(e.g. an ALL-TO-ALL sequencing N Contributions with escrow/quorum) — a
new `Protocol` value in the catalog, re-projected; no interface changes,
the `CollectiveUnit` union widens.

```ts
// project(Multicast, Initiator) reuses Speaker; the collective view names only the unit type it commits.
export declare const Multicast: Protocol<"Open", Move>; // roles: Initiator (= Speaker), Router, Member; one Contribute
export type CollectiveOf<G> = TranscriptUnit; // v0: the Multicast arm; the catalog, not this type, is what #765 widens
```

### Standard catalog — C4 Lifecycle (L3, in-band)

Genesis, member-add, and leave are Contributions carrying `LifecycleEntry`
payloads, ordered against message flow in the same transcript. No
control-plane create op: genesis is a data-plane Contribution whose guard
is id-freshness, not membership. Membership is a **derivation** — a fold
over lifecycle Contributions, never stored state (prior convergence 5).

```ts
// project(Lifecycle, Founder). Genesis is the founding Contribution: START to a fresh, client-minted id;
// admission checks attribution + id-freshness only, refusing reuse with no side effect (lifecycle-rides-l3).
export interface Founder {
  readonly genesis: (
    members: ReadonlyArray<AgentId>,
    body: Body,
  ) => Effect<ConversationId, Refusal, never>; // mints a fresh id, emits START through the ordinary Speaker path — no provisioning
}

// Membership is NOT a service method returning stored state; it is the fold sampled at a Position.
// The router runs it to compute delivery sets; the endpoint runs the identical fold to know the room.
export declare const membershipAt: (
  conversation: ConversationId,
  at: Position,
) => Effect<ReadonlySet<AgentId>, Refusal, never>; // folds Start/MemberAdd/Leave at or before `at`
```

### Standard catalog — C5 Recovery (L3 read/resume)

The sessionless resumability choreography. A Reader converges after any
miss by re-reading from an endpoint-owned `Position`; the network holds
nothing to resume. Scope is a single entitlement predicate; v0 checks
membership only, and a witness/operator/horizon decision changes the
predicate value, not any move (register 3/4/6, open).

```ts
export type Scope = (record: TranscriptRecord) => Effect<boolean, never, never>; // v0: membership-only

// project(Recovery, Reader). read is scoped; listConversations is the member's own index (the control
// plane's only two reads). Recovery == replaying this from an owned Position; no connection is named.
export interface Reader {
  readonly read: (
    conversation: ConversationId,
    from: Cursor,
    scope: Scope,
  ) => Effect<readonly [ReadonlyArray<TranscriptRecord>, Cursor], Refusal, never>; // contiguous, byte-exact
  readonly listConversations: (
    who: AgentId,
    from: Cursor,
  ) => Effect<readonly [ReadonlyArray<ConversationId>, Cursor], Refusal, never>;
}
```

### Standard catalog — C6 Directory (L1 material + L7 mechanism)

The control-plane identity family as a choreography. The card **is** the
directory entry; enumeration serves cards, no thinner projection.
Revocation is the Registry ceasing to vouch, observed at the next
`resolve` — no revoke move (register 5, open).

```ts
// project(Directory, Registry). mint is operator-gated (the Operator role signs with moltzap://operator).
export interface Registry {
  readonly mint: (publicKey: PublicKey, principal: PrincipalRef) => Effect<Card, Refusal, never>;
  readonly resolve: (id: AgentId) => Effect<Card, Refusal, never>;
  readonly enumerate: (from: Cursor) => Effect<readonly [ReadonlyArray<Card>, Cursor], Refusal, never>;
}
// project(Directory, Requester) is any registered identity calling resolve/enumerate; the endpoint's
// realization caches on issued-at and refetches once on verification failure (realization, not interface).
```

### Standard catalog — C7 ContactFormation (L5 endpoint choreography)

Contact formation is an **endpoint-only** choreography: obtain a peer's
card (reuse C6 Directory, or in-band on a first frame), confirm it
self-attests, record identity + posture locally. It defines **no**
request/accept handshake and **no** mutuality (contacts recorded
decision 3). Its **router projection is empty** — the structural
encoding of "what the router sees: nothing" (contacts inv. 1). Its peer
projection is empty too (no handshake). Only the acting endpoint has a
non-empty local protocol.

```ts
// project(ContactFormation, Endpoint). Composes a Directory resolve + a Verifier self-attest check +
// a local write. No network write, no server relationship, immediate effect (contacts inv. 4).
export interface ContactStore {
  readonly standing: (id: AgentId) => Effect<Standing, never, never>; // default posture absent a record
  readonly set: (id: AgentId, standing: Standing) => Effect<void, never, never>; // local act; zero network
  readonly form: (id: AgentId, card: Card, standing: Standing) => Effect<void, Refusal, never>; // self-attest then record
}
```

### The L5 gates — projected guards, not their own choreography

Screening is the endpoint's realization of the **guard** on two edges of
C2: the Member-receive edge (inbound) and the Speaker-send edge
(outbound). The verdict is a **success-channel value** decorating the
item (prior convergence 3); `Refuse` withholds the item from the agent
but the record stays in the transcript (screening filters attention,
never the record). It is not a `Refusal`. Norms (L4) and contacts (L5)
program the guards from above.

```ts
export interface InboundGate {
  readonly screen: (
    attributed: Attributed,
    standing: Standing,
    norms: PinnedNorms,
  ) => Effect<GateVerdict, never, never>; // mounted between Verifier.open and the agent; fail-closed
}
export interface OutboundGate {
  readonly screen: (
    frame: EncodedFrame,
    context: SendContext,
    norms: PinnedNorms,
  ) => Effect<GateVerdict, never, never>; // mounted between the agent and Speaker.contribute
}
export interface SendContext { readonly conversation: ConversationId }
```

### L4 — user choreographies (never projected by the network)

The payoff of the choreography framing. An L4 task norm is a **user
choreography** over the *same* vocabulary (`Role`, `Move`, `Protocol`) —
e.g. a game with roles Villager/Wolf/Moderator and moves
Nominate/Vote/Accuse. Three facts keep the network out of it:

- The network's projection domain is **exactly the standard catalog**.
  A user choreography is never a `Protocol` the router or the spec
  projects.
- Its moves ride as **opaque `Multicast` bodies** — the network sees a
  Contribution carrying opaque `Body`, nothing task-shaped (constitution
  clause 2; data-plane inv. 10).
- Same-version agreement (tasks inv.) is: both endpoints project the
  **same bundle version**, so their local task protocols compose. The
  endpoint's runtime projection into "legal next moves" is the deferred
  contract layer; v0 consumes the bundle only as L5 gate rules.

```ts
// A user choreography, opaque to the network. `bundle` is a pinned versioned skill bundle.
export interface UserChoreography { readonly bundle: NormBundle }
export interface NormBundle { readonly id: string; readonly version: ProtocolVersion }
export interface PinnedNorms { readonly bundles: ReadonlyArray<NormBundle> } // what the gates check against

// The endpoint's task projector — the seam where project(userChoreography, myRole) would yield the
// agent's legal next moves. v0 leaves it UNBUILT (v2/VISION → deferred contract layer): the type marks
// the seam; the vocabulary is shared so the projector drops in later with no network change.
export type ProjectTask = (norm: UserChoreography, role: Role) => unknown; // deferred; no v0 realization
```

### Effect realization (recorded standard)

- **One `Context.Tag` per projected role**, the v1 idiom re-implemented
  (`packages/server/src/message/layer.ts`). Tag ids record the
  projection origin: `moltzap/v2/<Choreography>/<Role>`, e.g.
  `moltzap/v2/Contribution/Speaker`,
  `moltzap/v2/Contribution/Router`, `moltzap/v2/Directory/Registry`.
  Permanent strings.
- **One `Layer` per realization**: the router, endpoint, and testbed
  realizations each provide the role tags they own via `Layer.effect`
  over the lower tags they consume.
- **Role positions are phantom-branded records** (`SpeakerAt<S>`); the
  state parameter gates move availability at compile time. TypeScript
  cannot enforce true linear consumption of a position, so the
  one-shot / observe-before-generate guarantees are typestate-channelled
  and the residual (one send per admitted turn) is pinned by a
  conformance law — types where they reach, a law for the rest.
- **Swap-equivalence is one Layer rebind.** data-plane inv. 11: the two
  compositions differing only in the `Contribution`/`Recovery`
  realization Layer (router vs testbed) are observationally equivalent
  under the conformance corpus.
- **Layering is a graph property.** A Layer realizing a role in a
  level-N choreography requires only tags at levels ≤ N (guarantees flow
  up); upper policy (gate rules, the operator key, L7 revocations) enters
  as construction input (configuration flows down). Both checkable over
  the dependency graph. The projected local protocols make the check
  *smaller* than a per-service graph: the interpretive work (membership,
  turns, screening) is folds and guards, not tags, so it is not in the
  graph at all.

## Data flow

Three flows over the `Contribution` choreography and its projections.
ASCII; every arrow is a move; every side-branch names the `Refusal` that
diverts there. `[[frame]]` marks the single byte-image threaded end to
end (identity → Byte preservation); `~~~` marks the wire seam
(data-plane Q10) living inside the Contribution realization, named by no
signature.

```
DOMINANT PATH — an outbound send crosses into the router, commits, fans out to a member.

ENDPOINT (Speaker)                          ROUTER (RouterContribution over the store)
──────────────────                          ─────────────────────────────────────────
SpeakerAt<"Idle">
   │ requestTurn
   ▼
SpeakerAt<"Contending">
   │ awaitAdmit                <── Admit ─── (router grants the turn)      observe-before-generate:
   ▼                                                                       Admitted is UNREACHABLE
SpeakerAt<"Admitted">   ── OutboundGate.screen ──Refuse──► withheld (agent-local, no wire)   without Admit
   │ contribute(unit)   (enabled ONLY here; consumes the position -> Spent = one-shot reply guard)
   │ Author.seal ==> [[EncodedFrame]]
   │  ~~~ ship (Contribution realization; wire shape unbound, Q10) ~~~►  admit(frame):
   │                                                                       Verifier.open ─Refusal─► (before Commit)
   │                                                                       member? id-fresh?  ─Refusal─► (envelope-only)
   │                                                                         │ pass
   │                                                                         ▼
   │                                                                       commit ==> Position   (durable-then-deliver)
   ◄── [Position, SpeakerAt<"Spent">] ── ack (only after durability) ─────────┤
                                                                              │  TranscriptRecord = { [[frame]], Position }
                                                                              │  (Position OUTSIDE the frame; frame byte-exact)
                                                                              ▼  Deliver: one-way fan-out to
                                                                                 membershipAt(conv, Position)  [fold, over the store]
ENDPOINT (Member)                                                             │
─────────────────                                                             │
Member.deliveries(conv, ownedPosition)  ◄~~~ TranscriptRecord ~~~◄────────────┘  (optimization over the store; NO reply edge)
   │ Verifier.open ─Refusal─► divert (record stays in the transcript)
   ▼
InboundGate.screen(attributed, standing, norms) ──Refuse──► withheld from the agent (record stays; filters attention)
   │ Admit / AdmitUnderLimits  (GateVerdict is a VALUE, not a Refusal)
   ▼
agent

RECOVERY (after any miss; sessionless) — the C5 Recovery choreography:
Member (needs history) ─► Reader.read(conv, ownedCursor, membershipScope) ~~~► store read
   ◄──────── [records, nextCursor] ──────── contiguous, byte-exact, ordered ── resuming at a Position ≡ never disconnecting

SWAP (data-plane inv. 11): router composition with the router Contribution realization
   ≡  router composition with the testbed Contribution realization. One Layer rebind; every projection identical.

L4 TASK MOVE (network sees nothing task-shaped):
   agent's task move ─► encoded as opaque Body ─► ordinary Multicast Contribution ─► [[frame]] over C2 above.
   The router projects only the standard catalog; the task protocol lives inside [[frame]]'s opaque body.
```

Two threads the diagram makes structural: (1) `[[frame]]` is one
byte-image from `Author.seal` to the Member's `Verifier.open`, because no
realization re-encodes it; (2) `Position` appears only at and after
`commit`, never inside `[[frame]]`.

## Errors

One typed value crosses every projected boundary: `Refusal` in the
Effect/Stream error channel. The `RefusalReason` is an **opaque brand**,
not a closed union — closing it would bind the failure taxonomy
(register 8, open). Defects never cross a role boundary; a subscriber
registry isolates them and streams fail with `Refusal`, never throw.

Three closed unions are exhaustive discriminants implementations must
handle, each with a `never`-typed default so a new arm is a compile error
at every site:

- **`GateVerdict`** (`Admit | AdmitUnderLimits | Refuse`) — a value on
  the delivered item, **not** an error. A refused item is withheld from
  the agent; the record stays in the transcript (screening inv. 2–3).
- **`SpeakerState`** (`Idle | Contending | Admitted | Spent`) — the
  Speaker typestate; the move set per state is exhaustive.
- **`Standing`** (`Allow | Deny | Limit`) — contact posture.

Two unions are **open by construction** — the single places the design
does not close:

- **`TranscriptUnit` / `CollectiveUnit`** — v0 arms only. #765 widens the
  union by **adding a choreography** to the catalog (an ALL-TO-ALL, a
  ballot); each realization matches its known arms and refuses the rest,
  so widening is additive and localized. A new arm is a compile error at
  every exhaustive handler — the op-set growth signal.
- **`RefusalReason`** — opaque; register 8's taxonomy widens it without
  touching any signature.

Router-internal realization errors (store `IdInUse`,
`UnknownConversation`, `NotAMember`, `InvalidCursor`) are discriminated
unions used *inside* the router realization; the projected router surface
maps each to one `Refusal` at the boundary, and conformance asserts the
*effect* ("the move did not take effect"), never the shape.

## Dependencies

| Library | Version | License | Why this one |
|---|---|---|---|
| `effect` | pin the `v2/*` workspace `effect` (candidate `^3.x`) | MIT | The mandated realization substrate (constraint 4): `Context.Tag`, `Layer`, `Effect`, `Stream`, `Schema`, `Brand`. Choreographies are `Protocol` values, projected roles are tags, role positions are phantom-branded records, one-way delivery is a read-only `Stream`. The only dependency the vocabulary and the projected surface need. |
| `fast-check` | pin to `effect`'s peer (candidate `^3.x`) | MIT | The property runner for the projection-soundness and swap-equivalence laws (`v2/conformance`): "the ensemble realizes the choreography", byte-exactness, one-send-per-admitted-turn, admission-before-generation. Ecosystem-standard; `effect`'s `Arbitrary` targets it. |

Adapter-tier only, behind the Attribution and Directory realizations,
not on any projected signature: the Ed25519 / X.509 / RFC 9421 libraries
(W2's choice — `v0-implementation-plan → W2`). `Card` and `EncodedFrame`
are opaque bytes at every projected boundary. The transport library is
inside the `Contribution` realization and is unbound (data-plane Q10). No
projected signature names a lease, socket, connection, or session.

## Traceability

Spec guarantee/invariant (doc + number) → the choreography, projection,
or law that carries it.

| Spec citation | Carried by |
|---|---|
| identity.md inv. 1 (attributable to one agent; verify offline from frame + material) | `project(Attribution, Verifier).open(frame, card)` — no round trip |
| identity.md inv. 2 (only the sender's harness attributes) | `project(Attribution, Author).seal` is the sole sealer; no router role has a seal move; private key is realization state |
| identity.md inv. 4 (attribution covers body + addressing; verify never interprets body) | `Verifier.open` yields `Envelope` only; `Body` opaque; admission guards read the envelope |
| identity.md inv. 5 (attests who, not intent) | no trust field on any alphabet noun; trust is the L5 gate guard, a separate projection |
| identity.md → One shape, two attribution bindings | C1 Attribution binding-neutral: interim/target are two realizations of the same `Author`/`Verifier` projection (register 5) |
| identity.md → Byte preservation | `[[frame]]` byte-image; no realization re-encodes; a byte-exactness law over C2/C5 |
| data-plane.md inv. 1 (routing/admission read envelope only) | `RouterContribution.admit` guards on `Envelope`; no body-typed guard exists |
| data-plane.md inv. 2 (never mint/alter/strip attribution) | the router realization has no `seal`; it carries `[[frame]]` verbatim |
| data-plane.md inv. 3 (total order; converge on recovery) | `commit` assigns `Position`; C5 Recovery `read` converges from an owned position |
| data-plane.md inv. 4 (durable-then-deliver) | C2: every `admit` refusal precedes `commit`; `Deliver` and the `contribute` ack follow `commit` |
| data-plane.md inv. 5 (turn observed before generation) | **typestate**: `SpeakerAt<"Admitted">`'s only constructor is `awaitAdmit`; `contribute` exists only on Admitted |
| data-plane.md inv. 6 (starvation protection per task L4) | fairness is a property of a **user choreography** (who may move next); v0 mints no task, so no v0 signature binds it |
| data-plane.md inv. 7 (equivocation robustness) | single `commit` copy + byte-exact one-way fan-out; a conformance law pins the construction |
| data-plane.md inv. 8 (membership changes in-band, ordered) | C4 Lifecycle Contributions ride the same C2 order; `membershipAt` folds them |
| data-plane.md inv. 9 (no principal veto; admission never mutates membership) | `admit` returns `Refusal` only; membership changes only via C4 lifecycle Contributions |
| data-plane.md inv. 10 (no data-plane interface names/carries a task) | no task role/move in the standard catalog; user choreographies ride as opaque `Multicast` bodies |
| data-plane.md inv. 11 (implementation-swap equivalence) | one Layer rebind of the C2/C5 realization (router vs testbed); the swap-equivalence law |
| data-plane.md inv. 12 (no per-endpoint session state) | no projected signature names a connection; role positions are TTL-bounded, reconstructible via C5 |
| data-plane.md inv. 13 (byte-exact, never re-encoded) | `[[frame]]` threaded unaltered through every move |
| data-plane.md inv. 14 (one-way delivery) | **structural**: `project(Contribution, Member)` has no move on the delivery edge; a response is a fresh Contribution |
| control-plane.md storage guarantee 1 (durable-then-deliver) | `commit` returns `Position` only after durability; fan-out consumes committed records |
| control-plane.md storage guarantee 2 (store-owned order) | `Position` minted only inside `commit` |
| control-plane.md storage guarantees 3, 4 (ordered/recovery reads) | C5 `Reader.read` contiguous window; recovery from an owned `Cursor`/`Position` |
| control-plane.md storage guarantee 5 (membership in-band) | C4 lifecycle Contributions occupy positions in the same order; `membershipAt` samples the fold |
| control-plane.md storage guarantee 6 (immutability) | no move rewrites a committed record; the router realization exposes no update |
| control-plane.md storage guarantee 7 (content-blind store) | the store holds `EncodedFrame` bytes; no body-typed guard or projection |
| control-plane.md storage guarantee 8 (member-scoped reads; witness/operator open) | C5 `Scope` predicate; v0 = membership; a wider scope changes the value, not the move (register 3/4/6) |
| control-plane.md storage guarantee 9 (collective = one transactional unit) | `commit` takes one `TranscriptUnit`; C3 Multicast = one Contribution |
| control-plane.md inv. 3 (per-request auth; sessionless) | `Verifier.open` per request; no establishment move anywhere |
| control-plane.md inv. 7 (exactly two caller classes) | C6 Directory's writers are the identity and operator roles; no third role in the catalog (register 3 keeps L6 unminted) |
| lifecycle-rides-l3 (in-band; no create op) | C4 `Founder.genesis` is a data-plane Contribution; the control plane projects no lifecycle choreography |
| directory-serves-cards (card is the entry) | C6 `Registry.resolve`/`enumerate` return `Card`; no thinner projection |
| protocol-version-carriage (exact match, refused before state) | `ProtocolVersion` exact-match comparator; version guard refuses before `commit` |
| sessionless-network (no per-endpoint state; position-resumable) | role positions carry no connection; C5 Recovery is the whole resume story |
| single-credential (one card key; no bearer) | `Author.seal`/`Verifier.open` and every request use the card key; no secret on any noun |
| channels.md inv. 1–3 (attributable before leaving; owns recovery; harness-independent) | `Author.seal` before ship; endpoint-owned `Position` + C5; role tags are runtime-independent |
| contacts.md inv. 1 (endpoint-resident; router serves nothing) | C7 ContactFormation's **router projection is empty**; `ContactStore` is endpoint-only |
| contacts.md inv. 2, 3 (gate = frame + attribution + norms + own contacts; default posture) | `InboundGate.screen` inputs exactly those; `ContactStore.standing` default posture |
| contacts.md inv. 4, 5 (local immediate effect; refusals agent-local) | `ContactStore.set` local, network-free; `GateVerdict.Refuse` emits nothing to the sender |
| screening.md inv. 1–4 (endpoint-only; never alter frame; verdicts agent-local; agent's own rules) | gates are projected **guards** on C2 edges; `GateVerdict` in the success channel, never on the wire |
| tasks.md inv. 1–3 (no network representation; binds only pinners; marketplace reuse) | user choreographies never projected by the network; carried as opaque `Multicast` bodies; same-version agreement = same bundle version |
| VISION clause 5 (e2e encryption stays possible) | `Body` opaque; no router guard refines it; encryption is a body-side concern the catalog never touches |
| VISION → deferred contract layer ("legal next moves") | `ProjectTask` seam; the runtime user-choreography projector, deliberately unbuilt in v0 |
| Payload floor (Card, frame=envelope+body, ProtocolVersion, ConversationId, Position, TranscriptRecord, lifecycle entries, collective unit, Refusal, Standing, GateVerdict) | all in `v2/wire` §The alphabet |

Name closure to Proposal A / the v0 plan: A's `FrameAuthor`/`FrameVerifier`
→ C1 `Author`/`Verifier`; A's `DataPlane`/`TransportPort` →
`project(Contribution, *)` + the C2 realization (wire split explicit); A's
`TurnObserver`/`ReplyGuard` → the `Speaker` typestate (`awaitAdmit` +
`contribute` consuming Admitted); A's `TranscriptStore` → the `commit`
move + C5 `Reader`; A's `ConversationIndex` → the `membershipAt` fold; A's
`ConversationInitiator` → C4 `Founder.genesis`; A's `AccessScope` → the
C5 `Scope` predicate; A's `InboundGate`/`OutboundGate`/`ContactStore` →
the L5 projected guards + C7; A's `IdentityRegistry` → C6 `Registry`.
Every A service is the projection of some catalog choreography, now an
output rather than an authored input.

## Open questions

Each carries a recommended default and an escalation target.

1. **Projection as spec-time discipline vs. runtime machinery.** Default:
   for the standard catalog, projection is a spec-time discipline — v0
   ships the hand-projected local interfaces and a soundness law; the
   network never runs a projector. The value-level projector is deferred
   to the L4 contract layer (`v2/VISION.md` → What We Know). Escalation:
   `docs/spec/endpoints/tasks.md` when the contract layer is chartered.

2. **Typestate cannot enforce linear consumption of a role position.**
   Default: `SpeakerAt<S>` channels observe-before-generate and the
   one-shot guard structurally, and a conformance property pins
   one-send-per-admitted-turn (data-plane inv. 5 + Implementation notes).
   Escalation: W6 code review if a linear-types helper is wanted.

3. **Do the projected local protocols graduate from recorded standard to
   a binding decision record?** Default: recorded standard until the
   first implementation PR would deviate (parallels the priors).
   Escalation: `docs/decisions/`.

4. **Turn-signal and delivery carriage.** Default: the `Admit`/`Deliver`
   moves are guarantee-level; their wire carriage lives inside the C2
   realization and is the charter's (#765, turn-signal carriage;
   data-plane Q10). No projected signature, spec text, or property names
   it. Left open by construction. Escalation: charter #765.

5. **Choreography-as-data vs. hand-projected interfaces.** Default: v0
   ships the catalog as `Protocol` values plus hand-projected local
   interfaces; the fully reflective descriptor (that a generic projector
   consumes) is the deferred generalization the L4 projector needs.
   Escalation: `docs/spec/endpoints/tasks.md`.

6. **Promoting a fold/guard to a choreography role.** `membershipAt`, the
   C5 `Scope` predicate, and the L5 gates are folds/guards, not roles; a
   future charter decision that needs one as an independently-swappable
   role pays a promote refactor. Default: accept the cost — it is
   mechanical because the choreography already states the contract, and a
   role that exists before its seam is decided is a bet against clause 15
   ("questions stay questions"). Escalation: charter #765 /
   `docs/spec/data-plane.md`.

7. **Module-to-package granularity.** Default: adopt the v0 plan's W1
   map unchanged; this proposal changes the interface vocabulary (from
   authored services to projected roles), not the package layout.
   Escalation: W1 package-map review.

## References

- Proposal A: `docs/spec/layer-interfaces.md` — the service-and-party
  standardization this proposal offers an alternative to.
- Sibling proposals:
  `v2/drafts/layer-interface-proposals/{schema-first,minimal-ports,stream-journal}-20260723.md`.
- `docs/architecture/layers.md`;
  `docs/decisions/20260723-eight-layer-stack.md` — the stack and its
  layering rules.
- `docs/spec/{identity,data-plane,control-plane}.md`;
  `docs/spec/endpoints/{channels,contacts,screening,tasks}.md` — the
  guarantee-level obligations behind each choreography and projection.
- `docs/decisions/20260723-{lifecycle-rides-l3,eval-plane-is-testbed,interim-signature-profile,protocol-version-carriage,directory-serves-cards}.md`;
  `docs/decisions/20260721-{sessionless-network,single-credential}.md` —
  the recorded decisions this proposal realizes without reopening.
- `v2/VISION.md` — constitution and open-question register; the
  session-types inversion (What We Know) that motivates
  projection-as-discipline with the runtime projector deferred.
- `v2/drafts/v0-implementation-plan-20260723.md` — the workstream
  interface sketches (W3–W6, W8) whose names close against §Traceability.
- v1 Effect idiom precedent: `packages/server/src/message/layer.ts`
  (`Context.Tag` + `Layer.effect`), re-implemented never imported
  (`docs/decisions/20260721-v2-lives-top-level.md`).
