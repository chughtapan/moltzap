> **Archived historical, non-normative input.** The Gate 1 package and
> interface boundary is `docs/spec/layer-interfaces.md`.

# Layer interfaces — Proposal: object-capability discipline, authority as unforgeable references

Status: DRAFT (alternative standardization proposal; peer to
`docs/spec/layer-interfaces.md`, Proposal A)
Bias: object-capability discipline — authority is a value

Spec basis: `docs/architecture/layers.md`;
`docs/spec/{identity,data-plane,control-plane}.md`;
`docs/spec/endpoints/{channels,contacts,screening,tasks}.md`; `v2/VISION.md`;
`docs/decisions/20260723-{eight-layer-stack,lifecycle-rides-l3,eval-plane-is-testbed,interim-signature-profile,protocol-version-carriage,directory-serves-cards}.md`;
`docs/decisions/20260721-{sessionless-network,single-credential}.md`;
`v2/drafts/v0-implementation-plan-20260723.md` (W2–W8).

## Summary

The four prior proposals each standardize on *what a thing is*: A on the
service-and-party (a `Context.Tag` per layer per region), schema-first on the
data shape crossing a boundary (a codec per schema), minimal-ports on the swap
axis (a tag per interchangeable seam), stream-journal on the substrate read
shape (one journal, everything else a fold). This proposal standardizes on a
different axis entirely: *who is permitted to act, and where that permission
came from*. The organizing unit is a **capability** — an unforgeable in-process
reference whose possession **is** the permission — and the whole stack is one
**attenuation tree**: a small set of root authorities minted once per process
region at composition time, narrowed hop by hop into the strictly weaker
references that leaf code holds. This diverges structurally from all four
because in every one of them authority is *ambient* — anything holding the
`TranscriptStore`/`Store`/`Journal` tag can `append` to any conversation, and a
harness plugin handed the transport tag can ship past its gate; the prevention
is composition wiring plus review. Here authority never rides Effect's `R`
channel: roots live in `Context` at the composition root and nowhere else,
every downstream authority is a value passed explicitly, and the compiler stops
helping code *acquire* dependencies so it can start forcing code to *thread*
permissions. The single credential and the sessionless, identity-based wire are
untouched — capabilities are strictly in-process, minted at the wire boundary
from a per-request card-key signature and discarded when the request completes;
nothing capability-shaped ever crosses the wire.

Openness by construction. Every chartered or register-open question is a place
the capability set is deliberately not minted: the collective op set is a
one-arm sum a capability carries opaque (#765); the wire lives inside a root
cap's backing adapter, named by no capability signature (data-plane Q10); the
attribution binding is two backings behind one `SealRoot`/`VerifyCap` (register
5); `Refusal` has no wire projection (register 8); decode strictness is a
backing posture no capability type asserts (register 9); and the monitor's
read-scope is a future attenuator over the same `ReadRoot`, minting no new
capability and no third caller arm (register 3).

## Modules

Conceptual capability groupings across the eight stack layers, not a package
count. The physical component-to-package map is the v0 plan's W1
(`v2/wire`, `v2/cap`, `v2/server`, `v2/channel`, `v2/testbed-plane`,
`v2/cli`, `v2/conformance`) and is not re-litigated here; a grouping may be one
file or share a package with its roots.

1. **`v2/cap` (kernel).** The capability vocabulary that makes the standard a
   standard: the private `CapBrand` symbol (the root of unforgeability — a
   value of a capability type is constructible only inside `v2/cap` or by an
   exported minter, never by downstream code), the `Cap<K, S>` shape, the
   `attenuate` primitive (wrap-and-narrow; the input authority is captured in a
   closure the result never re-exposes, so no result can be widened back), the
   two-arm `CallerCap` and its sole minter signature, and the **root
   discipline** marker — a root authority is a `Context.Tag` and an attenuated
   capability is a plain value, and the two are never confused. Depends on:
   `v2/wire`, `effect` (`Context`, `Effect`). Imports no region module. This is
   the kernel; every region consumes it.

2. **`v2/wire` (alphabet).** The payload nouns the capabilities move —
   `AgentId`, `PrincipalRef`, `Card`, `EncodedFrame`, `Envelope`, `Body`,
   `ProtocolVersion`, `ConversationId`, `Position`, `TranscriptRecord`,
   `LifecycleEntry`, `CollectiveUnit`, `Cursor`, `Refusal`, `Standing`,
   `GateVerdict` — each branded, defined once, imported by reference. Owns the
   `ProtocolVersion` exact-match comparator and the strict-decode machinery
   (normativity register-open, so machinery only). Depends on: `effect`
   (`Schema`, `Brand`). Identical in spirit to the shared kernel every prior
   names; carried here unchanged because the decided nouns are fixed by spec.

3. **Router authority region** (home `v2/server`). Mints the router root set —
   `AppendRoot`, `ReadRoot`, `MintRoot`, `VerifyRoot` — held only by
   `RouterComposition`. Provides the per-request `mintCaller` authenticator
   (the one holder of `VerifyRoot`), the `scopeReads` read attenuator
   (member-scoped in v0), and `admit` (an attenuation of `AppendRoot` bound to
   one verified frame). The root set **excludes** any seal, membership-mutate,
   contact, or verdict authority: those authorities do not exist in this
   process, which is what makes several plane and control-plane invariants
   unwritable here (Traceability). Depends on: `v2/cap`, `v2/wire`.

4. **Endpoint authority region** (home `v2/channel`). Mints the endpoint root
   set — `SealRoot` (the card key in capability form; the single credential),
   `ShipRoot`, `DeliveryRoot`, `ContactRoot` — held only by
   `EndpointComposition`. Composes the raw send authority, attenuates it through
   the outbound gate and the turn-bound single-use guard into a `GatedSendCap`,
   runs the inbound gate (a filter holding no seal authority), and hands the
   harness plugin exactly one `EndpointCaps` bundle of attenuated values. The
   interpretive locus: the only region where a `GateVerdict` is produced.
   Depends on: `v2/cap`, `v2/wire`.

5. **Testbed membrane region** (home `v2/testbed-plane`). The plane's root set
   under an **observation membrane**: the same `AppendRoot`/`ReadRoot` wrapped
   so the testbed can project envelope-level events and inject bounded faults,
   but the set **excludes** seal, membership, order-rewrite, and verdict
   authorities — the testbed may-never rules are the absence of those caps, not
   a reviewed promise. The swap (data-plane inv. 11) is one `Layer` binding:
   `PlaneRootsLive` vs `PlaneRootsTestbed`. Depends on: `v2/cap`, `v2/wire`.

`v2/conformance` is a leaf (consuming `v2/cap` + `v2/wire`) that generates the
corpus, including the two capability-specific static checks (Errors). L6 mints
no capability grouping: a monitor is a holder of a `ReadCap` attenuated to a
scope, re-verifying recorded frames with the same `VerifyCap` recipients hold;
`Evidence` is derived. L8 has no interface.

Folder shape: `v2/wire` and `v2/cap` are a two-layer stack (`cap` imports
`wire`, never the reverse); the three regions are a tree (peers of the kernel,
none importing another region); conformance is a leaf. Visible from the
directory listing: kernel below, regions beside, corpus at the edge.

## Interfaces

TypeScript signatures with typed error channels; no bodies. `Effect<A, E, R>`
is `success, refusal, requirements`. The load-bearing rule lives in the types:
a **root authority** is a `Context.Tag` (rides `R`, provided once at a
composition root); an **attenuated capability** is a branded value (rides no
`R`, passed explicitly). No exported function outside a composition root names a
root tag in its `R`.

### Kernel: `v2/cap`

```ts
import { Context, Effect } from "effect";
import type { AgentId, EncodedFrame, Refusal } from "@moltzap/v2-wire";

// The root of unforgeability. Module-private: no downstream module can name it,
// so no downstream module can write a value of any Cap type. Minting is only
// through the exported constructors below and each region's root Layer.
declare const CapBrand: unique symbol;

// An attenuated capability: a service value S tagged unforgeably with kind K.
// It is a VALUE, never a Context.Tag; it rides no requirements channel.
export type Cap<K extends string, S> = S & { readonly [CapBrand]: K };

// The attenuation primitive. `narrow` sees the fuller authority S; the returned
// Cap exposes only T. S is captured in a closure the result never re-exposes,
// so a T-cap can never be widened back to an S-cap. Every stack edge that
// "configures down" is one call of this.
export const attenuate: <K extends string, S, T>(
  cap: Cap<K, S>,
  narrow: (authority: S) => T,
) => Cap<K, T>;

// The per-request principal, minted ONLY by the authenticator holding VerifyRoot
// (router region), from a verified card-key signature. Two arms; there is no
// third constructor anywhere. Request-scoped: never stored, never on the wire,
// discarded when the request completes (sessionless — control-plane inv. 3).
export type CallerCap =
  | Cap<"Caller", { readonly kind: "identity"; readonly who: AgentId }>
  | Cap<"Caller", { readonly kind: "operator" }>;

// The pure verification authority: attribution from a frame plus published card
// material alone. Binding-neutral — interim request-signature and target
// per-frame are two backings behind this one shape (register 5 open). Held by
// recipients, by router admission, and by L6 readers, identically. Pure, so it
// is one of the few caps that MAY be ambient (see the Effect note).
export type VerifyCap = Cap<"Verify", {
  readonly verify: (frame: EncodedFrame) => Effect.Effect<Attributed, Refusal>;
}>;

export interface Attributed {
  readonly envelope: import("@moltzap/v2-wire").Envelope;
  readonly frame: EncodedFrame; // the exact bytes verified; byte-exact at every hop
}
```

### Router authority region (`v2/server`)

```ts
import { Context, Effect } from "effect";
import type {
  AgentId, Card, ConversationId, Cursor, EncodedFrame, Position,
  PublicKey, PrincipalRef, TranscriptRecord, CollectiveUnit, Refusal, SignedRequest,
} from "@moltzap/v2-wire";
import type { Cap, CallerCap, VerifyCap } from "@moltzap/v2-cap";

// --- Root authorities (Context.Tags; provided once by RouterComposition) ---

// Append any unit to any conversation and receive its committed Position. This
// is the ONLY authority that writes the record. It carries no attribution
// authority: it cannot seal (data-plane inv. 2) and no membership authority
// distinct from appending a lifecycle entry (data-plane inv. 9).
export class AppendRoot extends Context.Tag("moltzap/v2/root/Append")<
  AppendRoot,
  {
    readonly append: (conv: ConversationId, unit: CollectiveUnit) => Effect.Effect<Position, Refusal>;
    readonly appendGenesis: (frame: EncodedFrame) => Effect.Effect<Position, Refusal>; // atomic iff id unused
  }
>() {}

// Read any conversation's transcript window. Unattenuated; scopeReads narrows it.
export class ReadRoot extends Context.Tag("moltzap/v2/root/Read")<
  ReadRoot,
  {
    readonly read: (conv: ConversationId, from: Cursor) => Effect.Effect<readonly [readonly TranscriptRecord[], Cursor], Refusal>;
    readonly membershipAt: (conv: ConversationId, at: Position) => Effect.Effect<readonly AgentId[], Refusal>;
    readonly listConversations: (of: AgentId, from: Cursor) => Effect.Effect<readonly [readonly ConversationId[], Cursor], Refusal>;
  }
>() {}

// Operator-gated identity minting (L7). Held by RouterComposition; its consumers
// receive it only after presenting an operator-arm CallerCap.
export class MintRoot extends Context.Tag("moltzap/v2/root/Mint")<
  MintRoot,
  {
    readonly mint: (op: CallerCap, key: PublicKey, principal: PrincipalRef) => Effect.Effect<Card, Refusal>; // op must be the operator arm
    readonly resolve: (id: AgentId) => Effect.Effect<Card, Refusal>; // the card IS the directory entry
    readonly enumerate: (from: Cursor) => Effect.Effect<readonly [readonly Card[], Cursor], Refusal>;
  }
>() {}

// The sole authority that MINTS a CallerCap. Revocation = it can no longer
// derive a caller for a revoked identity (the registry ceased to vouch); "L7
// reconfigures L1" is exactly this backing change, no revoke op.
export class VerifyRoot extends Context.Tag("moltzap/v2/root/Verify")<
  VerifyRoot,
  {
    readonly mintCaller: (req: SignedRequest) => Effect.Effect<CallerCap, Refusal>; // per request; discarded after
    readonly frameVerify: VerifyCap; // the pure attribution check, handed downward as a value
  }
>() {}

// --- Attenuators (values out; roots discharged; run by RouterComposition) ---

// Member-scoped read authority for exactly this caller. v0 predicate = member.
// A wider scope (witness/operator/monitor — register 3/4/6 open) is a future
// attenuator over the SAME ReadRoot, not a new capability type.
export type ReadCap = Cap<"Read", {
  readonly read: (conv: ConversationId, from: Cursor) => Effect.Effect<readonly [readonly TranscriptRecord[], Cursor], Refusal>;
  readonly listOwn: (from: Cursor) => Effect.Effect<readonly [readonly ConversationId[], Cursor], Refusal>;
}>;
export const scopeReads: (root: ReadRoot["Type"], caller: CallerCap) => ReadCap;

// Admission is AppendRoot attenuated to one verified frame. It holds frameVerify
// and the membership VIEW, never SealRoot and never a membership-mutate cap:
// it can refuse, and it can append the admitted frame, and it can do nothing else.
export type AdmitCap = Cap<"Admit", {
  readonly admit: (req: SignedRequest, raw: EncodedFrame) => Effect.Effect<Position, Refusal>;
}>;
export const admit: (
  root: AppendRoot["Type"],
  verify: VerifyCap,
  view: ReadRoot["Type"]["membershipAt"],
) => AdmitCap;
```

### Endpoint authority region (`v2/channel`)

```ts
import { Context, Effect, Stream } from "effect";
import type {
  AgentId, Body, ConversationId, EncodedFrame, Envelope, Position,
  Standing, GateVerdict, Card, NormBundle, Cursor, TranscriptRecord, Refusal,
} from "@moltzap/v2-wire";
import type { Cap, VerifyCap } from "@moltzap/v2-cap";

// --- Root authorities (Context.Tags; provided once by EndpointComposition) ---

// The card key in capability form: the ONLY authority that attributes a frame as
// this identity (identity inv. 2). The single credential (single-credential
// decision). Held only by EndpointComposition; never handed to a plugin.
export class SealRoot extends Context.Tag("moltzap/v2/root/Seal")<
  SealRoot,
  { readonly seal: (envelope: Envelope, body: Body) => Effect.Effect<EncodedFrame, Refusal> }
>() {}

// Hand a sealed frame to the wire as a signed request. The wire sees a card-key
// signature, never a capability. One-way relative to delivery.
export class ShipRoot extends Context.Tag("moltzap/v2/root/Ship")<
  ShipRoot,
  { readonly ship: (frame: EncodedFrame) => Effect.Effect<Position, Refusal> }
>() {}

// Subscribe to inbound deliveries and read transcripts for recovery. Read/subscribe
// only: no response authority rides it (data-plane inv. 14 is structural).
export class DeliveryRoot extends Context.Tag("moltzap/v2/root/Delivery")<
  DeliveryRoot,
  {
    readonly deliveries: Stream.Stream<TranscriptRecord, Refusal>;
    readonly read: (conv: ConversationId, from: Cursor) => Effect.Effect<readonly [readonly TranscriptRecord[], Cursor], Refusal>;
  }
>() {}

// This endpoint's own trust data. Endpoint-only: the router process has no such
// root and no wire to receive one (contacts inv. 1 is unwritable at the router).
export class ContactRoot extends Context.Tag("moltzap/v2/root/Contact")<
  ContactRoot,
  {
    readonly standing: (id: AgentId) => Effect.Effect<Standing, never>; // default posture absent a record
    readonly set: (id: AgentId, s: Standing) => Effect.Effect<void, never>; // immediate effect, network-free
  }
>() {}

// --- Attenuated capabilities the plugin receives (values; no root in R) ---

// The gated send authority. attenuateSend captures SealRoot+ShipRoot in a closure
// the result never re-exposes and forwards a frame ONLY when the outbound gate
// admits AND the turn is admitted AND the guard has not spent this turn. A holder
// cannot seal, cannot ship raw, cannot bypass the gate: it holds none of those.
export type GatedSendCap = Cap<"Send", {
  readonly send: (conv: ConversationId, body: Body) => Effect.Effect<Position, Refusal>;
}>;
export const attenuateSend: (
  seal: SealRoot["Type"],
  ship: ShipRoot["Type"],
  gate: OutboundGate,
  turn: TurnCap,
) => GatedSendCap;

// The inbound gate: a FILTER holding no SealRoot, so it cannot alter frame or
// attribution (screening inv. 2). Verdict is a success value on a record, not an
// error. A refused frame is withheld from attention; the record stays (no holder
// has a delete authority — storage guarantee 6).
export interface OutboundGate {
  readonly screen: (frame: EncodedFrame, ctx: OutboundContext) => Effect.Effect<GateVerdict, never>;
}
export interface InboundGate {
  readonly screen: (attributed: import("@moltzap/v2-cap").Attributed, standing: Standing) => Effect.Effect<GateVerdict, never>;
}
export interface OutboundContext { readonly norms: readonly NormBundle[]; readonly turn: TurnState }

// Observe-admission-before-generation as a folded signal, and the single-use
// reply guard as an attenuation: one admitted turn yields at most one send. The
// wire carriage of the admission signal is the charter's (#765); this type is the
// guarantee (data-plane inv. 5), no lease named.
export type TurnCap = Cap<"Turn", {
  readonly admissions: (conv: ConversationId) => Stream.Stream<AdmissionEvent, Refusal>;
  readonly spend: (conv: ConversationId) => Effect.Effect<OneShot, Refusal>; // reply guard
}>;
export type TurnState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Awaiting"; readonly conv: ConversationId }
  | { readonly _tag: "Admitted"; readonly conv: ConversationId; readonly at: Position }
  | { readonly _tag: "Spent"; readonly conv: ConversationId };
export type AdmissionEvent =
  | { readonly _tag: "Granted"; readonly conv: ConversationId }
  | { readonly _tag: "Revoked"; readonly conv: ConversationId };
export interface OneShot { readonly [k: symbol]: "OneShot" } // consumed exactly once

// The endpoint's read-only trust view, handed to the plugin as context. Distinct
// from ContactRoot: the plugin may READ standing, never SET it.
export type ContactCap = Cap<"Contact", { readonly standing: (id: AgentId) => Effect.Effect<Standing, never> }>;

// Mint a fresh conversation and emit CONVERSATION-START through the ordinary send
// path. No provisioning (lifecycle-rides-l3). An attenuation of GatedSendCap.
export type InitiateCap = Cap<"Initiate", {
  readonly initiate: (members: readonly AgentId[], body: Body) => Effect.Effect<ConversationId, Refusal>;
}>;

// --- The plugin SPI: the whole "pure consumer" guarantee, in one type ---

// The plugin receives attenuated VALUES and requires NO authority (R excludes
// every root tag). It cannot seal, ship raw, append, read out of scope, mutate
// membership, alter a verdict, or write contacts: it holds none of those caps and
// can acquire none (no root tag is in its context). channels inv. 3 is the type.
export interface EndpointCaps {
  readonly send: GatedSendCap;
  readonly initiate: InitiateCap;
  readonly inbound: Stream.Stream<Enriched, Refusal>; // attention stream only
  readonly contacts: ContactCap;                       // read-only view
  readonly turn: TurnCap;
}
export interface Enriched {
  readonly attributed: import("@moltzap/v2-cap").Attributed;
  readonly verdict: GateVerdict; // rides the record; the diverted partition still carries it
  readonly standing: Standing;
}
export interface HarnessPlugin {
  readonly run: (caps: EndpointCaps) => Effect.Effect<void, never, never>; // no authority in R
}
```

### Testbed membrane region (`v2/testbed-plane`)

```ts
import { Context, Effect, Stream } from "effect";
import type { EncodedFrame, Position, ConversationId, Cursor, TranscriptRecord, Refusal } from "@moltzap/v2-wire";
import type { Cap } from "@moltzap/v2-cap";

// A read-only observation membrane over the store roots. Projects envelope-level
// events with timing; its type exposes NO mutate/seal/reorder/verdict method, so
// the testbed may-never rules are the absence of authority, not a reviewed rule.
export type ObservationCap = Cap<"Observe", {
  readonly events: Stream.Stream<EnvelopeEvent, never>; // accepted/ordered/delivered; no body field exists
}>;
export type EnvelopeEvent =
  | { readonly _tag: "Accepted"; readonly conv: ConversationId; readonly at: Position; readonly ts: bigint }
  | { readonly _tag: "Ordered"; readonly conv: ConversationId; readonly at: Position; readonly ts: bigint }
  | { readonly _tag: "Delivered"; readonly conv: ConversationId; readonly at: Position; readonly ts: bigint };

// Bounded fault injection over exactly the tolerated envelope. A closed sum:
// out-of-envelope faults (mint attribution, reorder committed order, mutate
// membership) are unrepresentable — there is no arm for them.
export type FaultProfile =
  | { readonly _tag: "Delay"; readonly ms: number }
  | { readonly _tag: "MissedPush" }
  | { readonly _tag: "Disconnect" }
  | { readonly _tag: "Partition" }
  | { readonly _tag: "Unresponsive" };
export type InjectionCap = Cap<"Inject", {
  readonly attach: (profile: FaultProfile) => Effect.Effect<Detach, Refusal>; // scoped; indistinguishable from natural
}>;
export interface Detach { readonly detach: () => Effect.Effect<void, never> }

// The plane root set as one Layer. PlaneRootsLive backs it with the production
// wire; PlaneRootsTestbed backs it with the membrane + injection. The swap
// (data-plane inv. 11) is choosing which of these two Layers is provided.
export class PlaneRoots extends Context.Tag("moltzap/v2/root/Plane")<
  PlaneRoots,
  {
    readonly ship: (frame: EncodedFrame) => Effect.Effect<Position, Refusal>;
    readonly deliveries: Stream.Stream<TranscriptRecord, Refusal>;
    readonly read: (conv: ConversationId, from: Cursor) => Effect.Effect<readonly [readonly TranscriptRecord[], Cursor], Refusal>;
  }
>() {}
```

## Data flow

One send, one delivery, one recovery — each arrow annotated with the capability
that authorizes it and where that capability came from. The distinctive read is
the **provenance column**: authority strictly narrows top to bottom, and the
plugin sits at the leaf holding the weakest references in the tree.

```
ENDPOINT COMPOSITION ROOT                         ROUTER COMPOSITION ROOT
holds (Context): SealRoot ShipRoot                holds (Context): AppendRoot ReadRoot
                 DeliveryRoot ContactRoot                          MintRoot  VerifyRoot
   |  compose + attenuate ONCE                        |  derive PER REQUEST
   v                                                  v
GatedSendCap = attenuateSend(Seal, Ship, gate, turn)  mintCaller(sig) -> CallerCap (identity|operator)
ContactCap   = read-only view of ContactRoot          scopeReads(ReadRoot, caller) -> ReadCap
InitiateCap  = attenuation of GatedSendCap            admit(AppendRoot, frameVerify, membershipAt) -> AdmitCap
   |  passed as EndpointCaps { send, initiate, inbound, contacts, turn }  (all VALUES)
   v
HARNESS PLUGIN     run(caps): Effect<void, never, never>     <-- R has NO root tag: pure consumer
   |
   | caps.send.send(conv, body)      authority: GatedSendCap ONLY (no Seal, no raw Ship)
   v
GatedSendCap.send
   | outbound gate admit? turn Admitted? guard unspent? --no--> Refusal   (agent-local; record untouched;
   |                                                                       no verdict crosses the wire)
   | yes:  (captured) SealRoot.seal -> (captured) ShipRoot.ship
   v
   ~~~~~~~~~~~~~~~~~~~~~~ WIRE ~~~~~~~~~~~~~~~~~~~~~~
   card-key-signed request, identity-based, per request; protocol version exact-match.
   NO capability crosses. The signature is the only credential (single-credential, sessionless).
   Wire shape is inside ShipRoot's backing (data-plane Q10); no capability signature names it.
   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   v
ROUTER admission
   | AdmitCap.admit(sig, frame):
   |   mintCaller(sig) --unverified--> Refusal         (before durability; VerifyRoot ceased to vouch = revoked)
   |   frameVerify.verify(frame) --bad attribution--> Refusal
   |   member? (membershipAt view) / genesis to fresh id? --no--> Refusal   (envelope-only; before durability)
   |     AdmitCap holds NO SealRoot        -> cannot mint/alter/strip attribution (data-plane inv. 2)
   |     AdmitCap holds NO membership cap  -> cannot mutate membership (data-plane inv. 9)
   v
   AppendRoot.append(unit) -> Position                 (durable-then-deliver; storage guarantee 1)
   |   membership change, when it happens, is an ordinary attributed LifecycleEntry append — same authority
   v
   fan-out one-way (optimization over the store; never the source of truth)
   |
   v
ENDPOINT inbound   DeliveryRoot.deliveries : Stream<TranscriptRecord>   (resumable from an endpoint-owned
   |                                                                     Position; sessionless recovery)
   | frameVerify.verify --bad--> divert, record stays
   v
InboundGate.screen(attributed, ContactCap.standing) -> GateVerdict      (filter holds NO SealRoot:
   |   Refuse --> withheld from attention; record stays in the store      cannot alter frame/attribution)
   v   Admit
   Enriched value --> plugin (read-only; the plugin has no delete/mutate authority to touch the record)

RECOVERY (after any miss; no session):
   plugin needs history -> caps has no read-out-of-scope authority; recovery rides DeliveryRoot.read within
   the endpoint's own membership. Resuming at a Position is identical to never disconnecting.

SWAP (data-plane inv. 11): provide PlaneRootsTestbed instead of PlaneRootsLive. One Layer binding differs;
   AppendRoot/ReadRoot and every attenuator above are identical. The testbed root set excludes seal,
   membership, order-rewrite, and verdict authorities, so may-never holds by absence.

L6 EVIDENCE: a monitor holds a ReadCap (scope register-3 open) and the same frameVerify VerifyCap; evidence
   = verify over recorded frames. Mints no seal, no third caller arm, no new capability.
```

## Errors

One typed value crosses every capability boundary: `Refusal` in the Effect error
channel (`Effect<A, Refusal, R>`). Defects never cross a boundary; a subscriber
registry isolates them. Three closed discriminants force exhaustive handling; two
open sums are open by construction.

- **`Refusal` — the one error-channel value.** Its `reason` is an internal
  discriminated union consumers `switch` over with an `absurd(_: never)` default,
  so a new reason is a compile error at every handler. Its **wire projection is
  deliberately unbuilt** (register 8): no capability signature binds a
  `RefusalWire`, and conformance asserts refusal *effect* ("the op did not take
  effect"), never refusal *shape*.

```ts
export type RefusalReason =
  | { readonly _tag: "VersionMismatch" }   // exact-match failure; refused before state change
  | { readonly _tag: "Unattributed" }      // frameVerify failed
  | { readonly _tag: "CallerUnminted" }    // VerifyRoot could not derive a caller (revoked / bad signature)
  | { readonly _tag: "NotAMember" }
  | { readonly _tag: "IdInUse" }           // genesis reuse; append refuses with no side effect
  | { readonly _tag: "InvalidCursor" }     // fail-closed
  | { readonly _tag: "OutOfScope" }        // ReadCap did not entitle this read (v0 = non-member)
  | { readonly _tag: "UnknownOp" };        // any CollectiveUnit arm beyond v0 MULTICAST
```

- **`GateVerdict` is not an error.** It is a success-channel value on the
  `Enriched` record (`Admit | AdmitUnderLimits | Refuse`), agent-local, never on
  the wire. A refused inbound frame is withheld from attention and stays in the
  store — no holder anywhere has a delete authority to remove it.

- **`AdmissionEvent` / `TurnState`** — `Granted | Revoked` folded to
  `Idle | Awaiting | Admitted | Spent`; exhaustive, a fifth state is a compile
  error at every fold site.

- **Open sums (open by construction):** `CollectiveUnit` (v0 `Multicast` only)
  and `LifecycleEntry` (`Start | MemberAdd | Leave`) are widened by charter #765.
  Every capability takes them opaque and matches its known arms exhaustively,
  refusing an unknown arm — so widening is additive and touches no capability
  signature.

Two capability-specific static checks live in `v2/conformance`:

1. **No-ambient-authority check.** No exported function outside a composition
   root names a root tag (`AppendRoot`, `ReadRoot`, `MintRoot`, `VerifyRoot`,
   `SealRoot`, `ShipRoot`, `DeliveryRoot`, `ContactRoot`, `PlaneRoots`) in its
   `R`. This is the capability analogue of A's "no upward edge," checkable over
   the type graph.

2. **Pure-consumer check.** `HarnessPlugin.run` has `R = never` for authority and
   `EndpointCaps` contains no root tag and no `SealRoot`/`ShipRoot`-typed field.

## Dependencies

This is a spec-track design doc; it installs nothing. Versions are recommended
pins for the implementer. **No capability signature names an adapter-tier
library**; they live behind the root Layers.

| Library | Version | License | Why (and where) |
|---|---|---|---|
| `effect` | ^3.x (pin at W1) | MIT | The mandated realization substrate (constraint 4): `Context.Tag` for roots, `Layer` for the swap binding, `Effect`/`Stream` for flows, `Schema`/`Brand` for `v2/wire`. The only dependency `v2/cap` and the capability surface need. |
| `@peculiar/x509` | ^1.x | MIT | X.509 card mint/verify inside `MintRoot`/`SealRoot` backings (`identity.md` container). Adapter-tier; `Card` is opaque at the capability. |
| `@noble/ed25519` | ^2.x | MIT | Ed25519 sign/verify inside `SealRoot`/`VerifyRoot` backings (`interim-signature-profile`). Adapter-tier. |
| (RFC 9421 signer) | — | — | HTTP Message Signatures for the interim request binding and the control RPC. Small enough to re-implement from the recorded profile (300 s window, keyid = agent-id URI); no maintained pin assumed. Adapter-tier only. |

No capability depends on a storage or transport library: the store engine backs
`AppendRoot`/`ReadRoot` and the wire backs `ShipRoot`/`DeliveryRoot`/`PlaneRoots`,
both behind their tags (constraint 3, sessionless: no socket, connection,
session, or lease in any signature above).

## Traceability

Spec guarantee/invariant → the capability artifact that carries it. Rows marked
**UNWRITABLE** are enforced by the *absence of the authority in the relevant root
set*, not by review or a conformance assertion — the illegal act has no
capability that could express it.

| Spec (doc → invariant) | Carried by | |
|---|---|---|
| `layers.md` → layering rules (config down, guarantees up; no reach above) | Config-down = `attenuate` grants; guarantees-up = a leaf holds only what a root granted. The no-ambient-authority static check is the "no upward edge" enforcer over root tags. | |
| `eight-layer-stack` → "L7 reconfigures L1" (consequences are configuration) | `MintRoot` state change propagates as `VerifyRoot.mintCaller` ceasing to derive a caller for a revoked id; observed at next request. No revoke op — revocation IS the reconfiguration. | |
| `identity.md` inv. 1 (attributable to one agent; verifies offline) | `VerifyCap.verify` from frame + card alone; `Attributed.frame` is the exact bytes. | |
| `identity.md` inv. 2 (only the sender's harness produces attribution) | `SealRoot` is the sole seal authority and lives ONLY in the endpoint region; the router root set has none. | **UNWRITABLE** at the router |
| `identity.md` inv. 4 (attribution covers body + addressing; verify never interprets body) | `SealRoot.seal(envelope, body)`; `VerifyCap` reads `Envelope`, never `Body`. | |
| `identity.md` → One shape, two attribution bindings | `SealRoot`/`VerifyCap` binding-neutral; interim vs target is a backing swap (register 5). | |
| `identity.md` → Byte preservation | `EncodedFrame` threads every capability unaltered; `TranscriptRecord.frame` is verbatim. | |
| `single-credential` (card key is the only credential; no bearer) | `SealRoot` backed by the card key; capabilities are in-process; the wire carries only the card-key signature. No bearer, no capability-URL, no wire token. | **UNWRITABLE** (none minted) |
| `data-plane.md` inv. 1 (routing/admission read envelope only) | `AdmitCap` reads `Envelope` via `VerifyCap`; no body authority exists router-side. | |
| `data-plane.md` inv. 2 (never mint/alter/strip attribution) | `AdmitCap` and `AppendRoot` hold no `SealRoot`; the router process cannot attribute. | **UNWRITABLE** |
| `data-plane.md` inv. 3 (total order; convergence) | `AppendRoot` assigns `Position`; recovery via `DeliveryRoot.read` from an endpoint-owned position. | |
| `data-plane.md` inv. 4 (durable-then-deliver) | `AdmitCap` refuses before `AppendRoot.append`; fan-out consumes committed records only. | |
| `data-plane.md` inv. 5 (turn observed before generation) | `TurnCap.admissions` folded to `TurnState`; `GatedSendCap` forwards only while `Admitted`; PCC off-wire, no lease named. | |
| `data-plane.md` inv. 9 (no network-side veto/reorder; admission never mutates membership) | No membership-mutate authority exists; membership changes only by an attributed `LifecycleEntry` append, itself a caller-authorized send. | **UNWRITABLE** |
| `data-plane.md` inv. 11 (implementation-swap equivalence) | `PlaneRootsLive` vs `PlaneRootsTestbed` — one Layer binding; every attenuator above unchanged. | |
| `data-plane.md` inv. 12 / `sessionless-network` (no per-endpoint state) | `CallerCap` is request-scoped and discarded; no session capability exists; recovery rides an owned `Position`. | **UNWRITABLE** (no session cap) |
| `data-plane.md` inv. 13 (byte-exact, never re-encoded) | `EncodedFrame` passes through every capability unaltered. | |
| `data-plane.md` inv. 14 (one-way delivery) | `DeliveryRoot` is subscribe/read only; a response requires the separate `GatedSendCap`. | |
| `data-plane.md` → testbed may-never (mint/alter attribution, rewrite order, mutate membership, author verdicts, carry standing) | The testbed root set excludes seal, membership, order-rewrite, and verdict authorities; `ObservationCap` is a read-only membrane. | **UNWRITABLE** |
| `control-plane.md` inv. 3 (per-request auth; sessionless) | `VerifyRoot.mintCaller` per request; the caller is discarded after. | |
| `control-plane.md` inv. 7 (exactly two caller classes; no third principal) | `CallerCap` is a two-arm sum with one minter; there is no third constructor anywhere. | **UNWRITABLE** |
| `control-plane.md` storage guarantee 2 (store-owned order) | `Position` minted only inside `AppendRoot.append`. | |
| `control-plane.md` storage guarantee 4 (recovery by reading) | `DeliveryRoot.read` / `ReadCap.read` from an owned cursor. | |
| `control-plane.md` storage guarantee 6 (immutability) | No mutate or delete authority exists in any root set. | **UNWRITABLE** |
| `control-plane.md` storage guarantee 8 (member-scoped reads; witness/operator open) | `scopeReads` attenuates `ReadRoot` to member scope; a wider scope is a future attenuator over the same root. | |
| `directory-serves-cards` (the card is the directory entry) | `MintRoot.resolve`/`enumerate` return `Card`; no thinner projection. | |
| `lifecycle-rides-l3` (in-band; no create op) | `AppendRoot.appendGenesis`; `LifecycleEntry` closed sum; no control-plane create authority exists. | |
| `protocol-version-carriage` (exact match; refused before state) | `VersionMismatch` refused before any append; `v2/wire` comparator. | |
| `contacts.md` inv. 1 (endpoint-resident; no router interface serves it) | `ContactRoot` is an endpoint root; the router has no contact authority and no wire to receive one. | **UNWRITABLE** at the router |
| `contacts.md` inv. 2 (gate = f(frame, attribution, norms, own contacts)) | `InboundGate.screen(attributed, ContactCap.standing)`; no peer trust data reachable. | |
| `contacts.md` inv. 5 / `screening.md` inv. 3 (verdicts agent-local) | `GateVerdict` is a success value; no capability emits it outward. | |
| `screening.md` inv. 1 (router enforces no L5 rule) | Gate lives only in the endpoint region; the router root set has no verdict authority. | **UNWRITABLE** at the router |
| `screening.md` inv. 2 (gates never alter frame/attribution) | `InboundGate`/`OutboundGate` are filters holding no `SealRoot`. | **UNWRITABLE** |
| `screening.md` → Acceptance (refused = withheld, record intact) | Refuse withholds from `Enriched` attention; the record stays (no delete authority). | |
| `channels.md` inv. 3 / `tasks.md` inv. 1 (plugins are pure consumers; tasks have no network representation) | `HarnessPlugin.run` requires `R = never` authority; `EndpointCaps` are attenuated values; no raw port tag is reachable. | **UNWRITABLE** |
| `channels.md` inv. 1 (attributable before leaving; verified before agent sees) | `GatedSendCap` seals before ship; inbound `VerifyCap` verifies before `Enriched`. | |
| `channels.md` inv. 2 (owns recovery position) | Recovery rides `DeliveryRoot.read` from an endpoint-owned `Position`; turn state TTL-bounded. | |
| Payload floor (`Card`, frame, `ProtocolVersion`, `ConversationId`, `Position`, `TranscriptRecord`, lifecycle entries, collective unit, `Refusal`, `Standing`, `GateVerdict`) | All in `v2/wire`; §Interfaces. | |

Name closure to Proposal A / the v0 plan: A's `FrameAuthor`/`FrameVerifier` →
`SealRoot`/`VerifyCap`; A's `TranscriptStore`/`ConversationIndex`/`AccessScope`
→ `AppendRoot`/`ReadRoot` + `scopeReads`; A's `IdentityRegistry` → `MintRoot`;
A's `DataPlane`/`TransportPort` → `ShipRoot`/`DeliveryRoot`/`PlaneRoots`; A's
`InboundGate`/`OutboundGate` → same names, now filters inside the endpoint
region; A's `ContactStore` → `ContactRoot` (+ read-only `ContactCap`); A's
`TurnObserver`/`ReplyGuard` → `TurnCap`; A's `ConversationInitiator` →
`InitiateCap`; A's `HarnessPlugin` → `HarnessPlugin` with an authority-free `R`.

## Open questions

Each carries a recommended default and an escalation target.

1. **Where the Effect/capability split falls (the load-bearing call).** Effect's
   `Context` IS ambient within a composition, so any authority that must be
   attenuated cannot be a `Context.Tag` — it must be a value passed explicitly.
   *Recommended default:* roots (`AppendRoot`, `SealRoot`, …) are `Context.Tag`s
   provided once at a composition root and named in no leaf's `R`; every
   attenuated capability is a branded value threaded as an argument; genuinely
   ambient, non-attenuable infrastructure (a `Clock`, the raw crypto verify
   primitive, the storage-engine handle behind a root) MAY stay in `Context`.
   The no-ambient-authority static check is the enforcer. Escalation: the
   maintainer decision on whether the Effect mapping graduates from recorded
   standard to a binding idiom (parallels A's open question 2).

2. **Capability representation: branded record vs `Context.Reference` vs `Scope`.**
   The doc models a capability as a branded record of closures. *Recommended
   default:* branded record (the `CapBrand` non-export gives unforgeability with
   no runtime cost). Reconsider `Scope`-tied capabilities only if a capability
   must be *revocable mid-composition* (v0 has none; revocation is a backing
   change observed at the next request). Escalation: W6 code review.

3. **Attenuation correctness vs unbypassability.** Capability discipline makes
   the gate *unbypassable* (the plugin cannot reach the raw send authority) but
   not *correct* (whether the gate's rule actually enforces the norm is still
   reviewed code). *Recommended default:* accept the split — structural
   unbypassability is the win; policy correctness stays a conformance concern
   over `GateVerdict` behavior. Escalation: `screening.md` acceptance.

4. **Monitor read-scope (register 3).** L6 holds a `ReadCap`; whether its scope
   exceeds membership is open. *Recommended default:* v0 mints no monitor root
   and no third caller arm; a monitor runs through a member-scoped `ReadCap`, and
   a future decision supplies a wider scope as another `scopeReads`-style
   attenuator over the same `ReadRoot` — not a new capability, not a third
   `CallerCap` arm. Escalation: register 3 / `control-plane.md`.

5. **`CallerCap` operator arm and `MintRoot`.** `MintRoot.mint` takes a
   `CallerCap` that must be the operator arm. *Recommended default:* the operator
   is the second `CallerCap` arm, minted by the same `VerifyRoot.mintCaller` from
   an operator-key signature (operator key as deployment configuration); no
   separate operator principal type. Escalation: `cli.md` / `identity.md`.

6. **Op-set growth as sum widening (#765).** `CollectiveUnit`/`LifecycleEntry`
   are open sums a capability carries opaque. *Recommended default:* the charter
   adds arms; every capability matches known arms exhaustively and refuses the
   rest; no capability method is added per op, and none names completion,
   failure, concurrency, witnesses, presence, or turn-signal carriage.
   Escalation: charter #765.

7. **Cursor persistence (`channels.md` Q2).** The endpoint owns the recovery
   position; what it durably keeps is a spec deliverable. *Recommended default:*
   `DeliveryRoot`/`ReadCap` take a `Position`/`Cursor` value and bind no
   persistence; the endpoint composition decides durability under W6.S2.
   Escalation: `docs/spec/endpoints/channels.md`.

## References

- Proposal A: `docs/spec/layer-interfaces.md`; peers:
  `v2/drafts/layer-interface-proposals/{schema-first,minimal-ports,stream-journal}-20260723.md`.
- `docs/architecture/layers.md`; `docs/decisions/20260723-eight-layer-stack.md`
  — the stack and its layering rules this proposal turns into an attenuation tree.
- `docs/spec/{identity,data-plane,control-plane}.md`;
  `docs/spec/endpoints/{channels,contacts,screening,tasks}.md` — the
  guarantee-level obligations behind each capability.
- `docs/decisions/20260721-{sessionless-network,single-credential}.md` — the
  wire-authority model this proposal honors in-process without reopening;
  `docs/decisions/20260723-{lifecycle-rides-l3,eval-plane-is-testbed,interim-signature-profile,protocol-version-carriage,directory-serves-cards}.md`.
- `v2/drafts/v0-implementation-plan-20260723.md` — the W2–W8 interface sketches
  whose names close against §Traceability.
- v1 Effect idiom precedent: `packages/server/src/message/layer.ts`
  (`Context.Tag` + `Layer.effect`), re-implemented never imported
  (`docs/decisions/20260721-v2-lives-top-level.md`).
