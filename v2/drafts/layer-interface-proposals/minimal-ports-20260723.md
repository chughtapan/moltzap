> **Archived historical, non-normative input.** The Gate 1 package and
> interface boundary is `docs/spec/layer-interfaces.md`.

# Layer interfaces, Proposal B: minimal ports, layers as laws

Status: DRAFT (alternative to `docs/spec/layer-interfaces.md`, Proposal A)

Spec basis: `docs/architecture/layers.md`; `docs/spec/{identity,data-plane,control-plane,enforcement}.md`;
`docs/spec/endpoints/{channels,contacts,screening,tasks}.md`; `v2/VISION.md`;
`docs/decisions/20260723-{eight-layer-stack,lifecycle-rides-l3,eval-plane-is-testbed,interim-signature-profile,protocol-version-carriage,directory-serves-cards}.md`,
`docs/decisions/20260721-{sessionless-network,single-credential}.md`;
`v2/drafts/v0-implementation-plan-20260723.md` (W3–W6, W8).

## Summary

The eight-layer stack is realized by **five ports and a body of laws**, not fifteen
per-layer services. A **port** is a seam where two implementations must be
interchangeable and the conformance suite quantifies over the swap; there are exactly
five such seams in the spec, one per independent swap axis: **Plane** (production vs
testbed data plane, `data-plane.md` inv. 11), **Store** (storage engine behind
`durable-then-deliver`), **Registry** (card custody: registry-served vs peer-served),
**Attribution** (interim request-signature vs target per-frame binding), and **Harness**
(the driving SPI two runtimes implement, `channels.md` inv. 3). Everything else in
Proposal A's table is expressed over these five as a **law** (a checkable property), a
**decorator** (middleware that adds a guarantee), a **derivation** (a pure read of a
port's state), or an **adapter** (an implementation behind a port). The eight layers are
not tags: each is a `LawSet` the conformance suite runs against a port binding, plus
where needed a decorator `Layer` that wraps a port. "Guarantees flow up, configuration
flows down" is checked over a five-node adapter graph plus a layer-to-property map,
never over a fifteen-node service graph.

Where this diverges structurally from Proposal A: (1) A's `DataPlane` (router) and
`TransportPort` (endpoint, delivery and read halves) are **one** Plane port viewed from
two sides, not two services per party. (2) A's `ConversationIndex`, `AccessScope`,
`TurnObserver`, `ReplyGuard`, `ConversationInitiator`, `InboundGate`, `OutboundGate`,
`ContactStore`, and `CardResolver` carry no tag of their own; they are laws,
decorators, derivations, or adapters over the five ports. (3) The charter's op set is a
**union variant**, not a method per op, so #765 widening the op set widens a type and
touches no port signature; the register-open seams (witness scope, turn carriage,
initiation authority) are laws over ports rather than tags, so no tag pre-images a seam
the charter has not decided.

## Modules

Conceptual seams and law-bundles, not a package count. The W1 component-to-package map
(`v0-implementation-plan-20260723.md`) decides packaging independently; a port may be
one file or share a package with its laws.

1. **`wire` (shared kernel).** The port currency: every payload two adapters of any
   port must agree on byte-for-byte. `EncodedFrame`, `Envelope`, `Body`, `Card`,
   `AgentId`, `PrincipalRef`, `ConversationId`, `ProtocolVersion`, `Position`, `Cursor`,
   `TranscriptRecord`, `TranscriptUnit` (the `CollectiveUnit`/`LifecycleEntry` sum),
   `Refusal`. Depends on: `effect` (Schema, Brand). No port depends on another port's
   internals; all cross-port types live here. Owns the `ProtocolVersion` exact-match
   comparator and the strict-decode machinery (normativity register-open, so machinery
   only).

2. **`port/plane` (L2 + L3-delivery).** Tag `Plane`. One contract for both sides: the
   endpoint holds it as a client, the router/testbed provides it. `ship`, `deliveries`,
   `read`. Law set: ordering, durable-then-deliver (delivery half), one-way,
   content-blindness, equivocation-robustness, admission-checks-envelope-only,
   no-membership-mutation, admission-observable-before-generation, byte-exactness.
   Adapters: `PlaneLive` (requires `Store`, `Attribution`), `PlaneTestbed` (same
   guarantees plus observation and bounded injection). Depends on: `wire`, `effect`.

3. **`port/store` (L3-record).** Tag `Store`. `append`, `appendGenesis`, `read`. Law
   set: store-owned total order, durability-before-return, immutability, contiguous
   ordered reads, recovery-by-reading, membership-in-band, collective-units-transactional,
   content-blind, `Position`-never-under-attribution. Adapters: `StoreLive` (engine
   choice, e.g. Postgres/PGlite, behind the port). Depends on: `wire`, `effect`.

4. **`port/registry` (L1 material + L7 mechanism).** Tag `Registry`. `mint` (operator-
   gated), `resolve` (card is the directory entry), `enumerate`. This port **is** the
   control plane's identity op family; no separate control-plane service exists. Law set:
   cards self-attest, `enumerate` = per-id `resolve`s, `mint` operator-gated, revocation
   = ceasing to vouch (observable at next `resolve`, no revoke method). Adapters:
   `RegistryLive` (router card store); endpoint-side `resolve` is a cache adapter
   (issued-at keyed, single refetch); peer custody is a future adapter. Depends on:
   `wire`, `effect`.

5. **`port/attribution` (L1).** Tag `Attribution`. `seal`, `open`. Binding-neutral: the
   swap is interim (sign the request) vs target (sign the frame), and both adapters hold
   the same interface, so recipients and L6 readers verify identically under either. Law
   set: `open(seal(x))` attributes to the signer; `open` is offline from frame plus card
   alone. Adapters: `AttributionInterim`, `AttributionTarget`. The private key is adapter
   state, never a signature parameter. Depends on: `wire`, `effect`.

6. **`port/harness` (L4 driving SPI).** Tag `Harness`. The runtime drives the endpoint
   through this; `deliver` (core to runtime), `outbound` (runtime to core). Law set (from
   `channels.md`): two adapters interoperate regardless of runtime; sends only via the
   core; never answers on the delivery path. Adapters: `HarnessOpenClaw`,
   `HarnessNanoClaw`. Depends on: `wire`, `effect`.

7. **`law/screening` (L5).** Not a port. A decorator over the endpoint's inbound and
   outbound edges, configured by `(ruleset, contacts)` flowing down from above.
   `inbound`, `outbound` return a `Verdict`. Contacts is an endpoint-local store adapter
   behind this config (`standing`, `set`), never a port: its only guarantees are
   locality, sovereignty, and independence, all of which are **negative** boundary laws
   ("no router interface accepts, stores, or serves it"), not a cross-implementation
   equivalence. Depends on: `wire`, `port/harness` (wraps its edges), `effect`.

8. **`law/entitlement` (L3 scope).** Not a port. A decorator over `Store.read` carrying
   the scope predicate; v0 supplies membership-only. A future witness/operator/horizon
   decision changes the predicate value, not the port. Depends on: `port/store`.

9. **`law/derive`.** Pure derivations over port state, no tag: `membershipAt(conv, pos)`
   = fold of `LifecycleEntry`s at or before `pos`; `initiate(members, body)` = mint a
   fresh `ConversationId`, `Attribution.seal` a `START` frame, `Plane.ship` it (no new
   seam); `evidence(records)` = `Attribution.open` over recorded frames (L6 re-verification
   is the recipient procedure). Depends on: `wire`, `port/*`.

10. **`law/conformance`.** The layer-to-property map: each of L1–L8 is a `LawSet`, a list
    of properties over the port tags; plus the cross-cutting laws (byte-exactness across
    Plane and Store; sessionlessness; version exact-match). The swap-equivalence runner
    runs one corpus against two `Plane` bindings. Depends on: `port/*`, `law/*`.

11. **`compose/router`.** `RouterComposition`: provides `Plane` (as `PlaneLive`),
    requires `Store`, `Registry`, `Attribution`; `Store.read` wrapped by `law/entitlement`.
    The control-plane RPC skin and the CLI are **drivers** over `Store` reads plus
    `Registry`, holding no state of their own; neither is a port. Depends on: ports 2–5,
    laws 8–10.

12. **`compose/endpoint`.** `EndpointComposition`: requires `Plane`, `Attribution`,
    `Registry.resolve`; provides the `Harness` dependencies; edges wrapped by
    `law/screening`; owns the recovery `Cursor` as endpoint state (not plane state, not a
    port). Depends on: ports 2, 4–6, law 7, law 9.

## Interfaces

TypeScript, Effect as the substrate. Error channels are typed; success is the guarantee.
No function bodies (architecture). `Effect<A, E>` elides `R`; requirements are stated per
adapter in Modules.

### Port currency (`wire`)

```ts
import type { Brand } from "effect/Brand";
import type { Effect } from "effect/Effect";
import type { Stream } from "effect/Stream";

export type AgentId = string & Brand.Brand<"AgentId">;             // registry-minted, opaque, survives rotation
export type PrincipalRef = string & Brand.Brand<"PrincipalRef">;   // opaque linkage (depth open)
export type ConversationId = string & Brand.Brand<"ConversationId">; // client-minted, collision-free by size
export type ProtocolVersion = string & Brand.Brand<"ProtocolVersion">; // CalVer; matched exact, missing segments = 0
export type Position = string & Brand.Brand<"Position">;           // store-assigned; never inside the attributed unit
export type Cursor = string & Brand.Brand<"Cursor">;               // opaque, fail-closed paging token
export type Body = Uint8Array & Brand.Brand<"Body">;               // opaque; never interpreted below L4
export type EncodedFrame = Uint8Array & Brand.Brand<"EncodedFrame">; // byte-exact at every hop
export type Card = Uint8Array & Brand.Brand<"Card">;               // X.509 cert bytes; self-attesting
export type PublicKey = Uint8Array & Brand.Brand<"PublicKey">;     // Ed25519 SPKI

/** Carrier-readable view of a frame; routing and admission read only these. */
export interface Envelope {
  readonly sender: AgentId;
  readonly conversation: ConversationId;
  readonly protocol: ProtocolVersion;
}

/** Result of a successful open(): the readable envelope plus the exact bytes verified. */
export interface Attributed {
  readonly envelope: Envelope;
  readonly frame: EncodedFrame;
}

/** Store record: the frame byte-exact plus its store-assigned position. */
export interface TranscriptRecord {
  readonly frame: EncodedFrame;
  readonly position: Position;
}

/**
 * What append/ship take. The op set and the lifecycle-entry set are OPEN unions:
 * v0 has exactly the arms below; charter #765 widens the union, touching no signature.
 * Each adapter handles its known arms exhaustively and refuses an unknown arm.
 */
export type TranscriptUnit = CollectiveUnit | LifecycleEntry;
export type CollectiveUnit =
  | { readonly _tag: "Multicast"; readonly frame: EncodedFrame }; // v0: MULTICAST only
export type LifecycleEntry =
  | { readonly _tag: "Start"; readonly frame: EncodedFrame }      // genesis
  | { readonly _tag: "MemberAdd"; readonly frame: EncodedFrame }
  | { readonly _tag: "Leave"; readonly frame: EncodedFrame };

/**
 * The one interim refusal value (register item 8, open). `cause` is an OPAQUE brand,
 * NOT a closed union: closing it would bind the failure taxonomy. This is the single
 * union the design deliberately leaves open.
 */
export type RefusalCause = string & Brand.Brand<"RefusalCause">;
export interface Refusal { readonly _tag: "Refusal"; readonly cause: RefusalCause }
```

### P1 — Plane (`port/plane`)

```ts
/** L2 ordered multicast delivery + L3 delivery. One contract; endpoint = client, router/testbed = provider. */
export interface Plane {
  /** Ship one transactional unit. Position returns only after durability. Refuses before durability. */
  readonly ship: (unit: TranscriptUnit) => Effect<Position, Refusal>;
  /** One-way, best-effort push of committed records. Never a response path; never the source of truth. */
  readonly deliveries: Stream<TranscriptRecord, never>;
  /** Recovery by reading from an endpoint-owned cursor; resuming at a position ≡ never disconnecting. */
  readonly read: (
    conversation: ConversationId,
    from: Cursor,
  ) => Effect<readonly [readonly TranscriptRecord[], Cursor], Refusal>;
}
```

### P2 — Store (`port/store`)

```ts
/** L3 record substrate. Durable-then-deliver: append returns only after durability. */
export interface Store {
  /** One unit, one transaction, commit-time contiguous Position. */
  readonly append: (
    conversation: ConversationId,
    unit: TranscriptUnit,
  ) => Effect<Position, StoreError>;
  /** Genesis: atomic iff the frame's envelope.conversation is unused; reuse refuses with no side effect. */
  readonly appendGenesis: (frame: EncodedFrame) => Effect<Position, StoreError>;
  /** Contiguous ordered window, byte-exact records, gated by the entitlement predicate. */
  readonly read: (
    conversation: ConversationId,
    from: Cursor,
    scope: Scope,
  ) => Effect<readonly [readonly TranscriptRecord[], Cursor], StoreError>;
}

/** Entitlement predicate carried into read (law/entitlement). v0: membership-only. Not a port. */
export type Scope = (record: TranscriptRecord) => Effect<boolean, never>;

export type StoreError =
  | { readonly _tag: "IdInUse" }
  | { readonly _tag: "UnknownConversation" }
  | { readonly _tag: "NotAMember" }
  | { readonly _tag: "InvalidCursor" }; // internal; the RPC skin projects these to one Refusal
```

### P3 — Registry (`port/registry`)

```ts
/** L1 published material + L7 mechanism. Also the control plane's identity op family. */
export interface Registry {
  /** Operator-gated mint from a submitted public key; returns public material only. */
  readonly mint: (publicKey: PublicKey, principal: PrincipalRef) => Effect<Card, RegistryError>;
  /** The card IS the directory entry; resolve returns the identity's current card. */
  readonly resolve: (id: AgentId) => Effect<Card, RegistryError>;
  /** Paginated cards; no thinner projection; no visibility filtering. */
  readonly enumerate: (from: Cursor) => Effect<readonly [readonly Card[], Cursor], RegistryError>;
}

export type RegistryError =
  | { readonly _tag: "UnknownAgent" }   // revocation observable: ceasing to vouch (no revoke method — register 5 open)
  | { readonly _tag: "NotOperator" }
  | { readonly _tag: "InvalidCursor" };
```

### P4 — Attribution (`port/attribution`)

```ts
/** L1 binding-neutral attribution. Adapters: interim (sign the request), target (sign the frame). */
export interface Attribution {
  /** Produce the attributed unit. The private key is adapter state, never a parameter. */
  readonly seal: (envelope: Envelope, body: Body) => Effect<EncodedFrame, AttributionError>;
  /** Verify offline from the frame plus the sender's card alone. Same interface under both bindings. */
  readonly open: (frame: EncodedFrame, card: Card) => Effect<Attributed, Refusal>;
}

export type AttributionError =
  | { readonly _tag: "VersionMismatch" }  // protocol exact-match failure; refused before state change
  | { readonly _tag: "SealFailed" };
```

### P5 — Harness (`port/harness`)

```ts
/** L4 driving SPI. The runtime drives the endpoint; owns prompt formatting and batching. */
export interface Harness {
  /** Core delivers the enriched, screened inbound to the runtime. */
  readonly deliver: (enriched: Enriched) => Effect<void, never>;
  /** Runtime emits sends; the core wires them through screening, seal, ship. Never answered on delivery. */
  readonly outbound: Stream<Outbound, never>;
}

export interface Enriched { readonly attributed: Attributed; readonly standing: Standing }
export interface Outbound { readonly conversation: ConversationId; readonly body: Body }
```

### L5 screening + contacts (`law/screening`, not a port)

```ts
/** Decorator over the endpoint edges; config = (ruleset, contacts) flowing down. Verdicts are agent-local. */
export interface Screening {
  readonly inbound: (attributed: Attributed, standing: Standing) => Effect<Verdict, never>;
  readonly outbound: (frame: EncodedFrame, context: SendContext) => Effect<Verdict, never>;
}

/** Closed union: the gate's decision is exhaustive and never crosses the wire. */
export type Verdict =
  | { readonly _tag: "Admit" }
  | { readonly _tag: "AdmitUnderLimits"; readonly limits: Limits }
  | { readonly _tag: "Refuse" };

/** Endpoint-local trust store; an adapter behind Screening config, not a port. */
export interface ContactStore {
  readonly standing: (id: AgentId) => Effect<Standing, never>; // default posture absent a record
  readonly set: (id: AgentId, standing: Standing) => Effect<void, never>; // immediate effect, network-free
}
export type Standing =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny" }
  | { readonly _tag: "Limit"; readonly limits: Limits };
export type Limits = ReadonlyArray<string & Brand.Brand<"Limit">>; // endpoint-defined, opaque (contacts.md rec. 6)
export interface SendContext { readonly conversation: ConversationId }
```

### Composition (Effect realization)

```ts
import type { Context } from "effect/Context";
import type { Layer } from "effect/Layer";

export class PlaneTag extends Context.Tag("moltzap/v2/port/Plane")<PlaneTag, Plane>() {}
export class StoreTag extends Context.Tag("moltzap/v2/port/Store")<StoreTag, Store>() {}
export class RegistryTag extends Context.Tag("moltzap/v2/port/Registry")<RegistryTag, Registry>() {}
export class AttributionTag extends Context.Tag("moltzap/v2/port/Attribution")<AttributionTag, Attribution>() {}
export class HarnessTag extends Context.Tag("moltzap/v2/port/Harness")<HarnessTag, Harness>() {}

/** Adapter: Plane realized over Store + Attribution (durable-then-deliver; admission opens envelopes). */
export declare const PlaneLive: Layer<PlaneTag, never, StoreTag | AttributionTag>;
/** Adapter: same guarantees, plus observation and bounded injection. The swap in inv. 11 is THIS binding. */
export declare const PlaneTestbed: Layer<PlaneTag, never, StoreTag>;

/** Decorator: wraps read with the entitlement predicate. Layer<Port, _, Port> — config down, not a new tag. */
export declare const withEntitlement: (scope: Scope) => Layer<StoreTag, never, StoreTag>;
/** Decorator: wraps the endpoint edges. Config (ruleset, contacts) enters here, never as a Plane dependency. */
export declare const withScreening: (screening: Screening) => Layer<HarnessTag, never, HarnessTag>;
```

## Data flow

Send, deliver, recover. Every arrow is a call across a port or a law; `┈┈` is the open
wire (`data-plane.md` Q10) living inside the `PlaneLive`/`PlaneTestbed` adapter.

```
ENDPOINT (driving)                              ROUTER (PlaneLive over Store + Attribution)
──────────────────                              ────────────────────────────────────────────
Harness.outbound  ─ Outbound(conv, body)
   │
   ▼
Screening.outbound ── Refuse ──► (agent-local, no wire effect)
   │ Admit
   ▼
Attribution.seal(envelope, body) ─► EncodedFrame
   │
   ▼
Plane.ship(Multicast frame)  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈►  admission:
                                                   Attribution.open(frame, card) ─ Refusal ─► (before durability)
                                                   member? id-fresh?              ─ Refusal ─► (envelope-only)
                                                     │ pass
                                                     ▼
                                                   Store.append / appendGenesis ─► Position   (durable-then-deliver)
                                                     │  StoreError ─► Refusal (projected)
                                                     ▼
   ◄── Position ─────────────────────────────────  return after durability
                                                     │
                                                     ▼  fan-out one-way, best-effort, to
                                                        membershipAt(conv, position)   [law/derive, over Store]
   Plane.deliveries  ◄┈┈┈ TranscriptRecord ┈┈┈┈┈┈┈┈┈┈ (optimization over the store; never source of truth)
   │
   ▼
Attribution.open(frame, Registry.resolve(sender)) ─ Refusal ─► withheld
   │ Attributed
   ▼
Screening.inbound(attributed, ContactStore.standing) ─ Refuse ─► withheld (record stays; filters attention)
   │ Admit
   ▼
Harness.deliver(Enriched)

RECOVERY (after any miss; sessionless):
Harness (needs history) ─► Plane.read(conv, endpoint-owned Cursor) ┈┈┈► Store.read(conv, Cursor, membership-scope)
   ◄─────────────── [records, nextCursor] ───────────────────────────── contiguous, byte-exact, ordered

SWAP (data-plane.md inv. 11): RouterComposition with PlaneLive  ≡  RouterComposition with PlaneTestbed.
One Layer binding differs; Store, Registry, Attribution, and every law are identical.

L6 EVIDENCE (law/derive, mints no port, no third caller): evidence(records) = Attribution.open over
Store.read output under Registry.resolve — the recipient procedure, run post facto.
```

## Errors

Typed channels only; no throw crosses a port. Three tiers:

- **`Refusal` (the one wire value).** Every fallible operation an endpoint can observe
  across the wire fails with `Refusal`, whose `cause` is an **opaque brand**, not a
  closed union. This is deliberate: `data-plane.md` register item 8 (failure taxonomy) is
  open, and a closed union would bind it. The single place the design does not close a
  union.
- **Port-internal typed errors.** `StoreError`, `RegistryError`, `AttributionError` are
  discriminated unions with exhaustive arms, used *inside* a region. The router's RPC
  skin projects each to one `Refusal` at the wire; conformance asserts the effect
  (the op did not take effect) never the shape (`v0` plan W3/W4/W8 guards).
- **`Verdict` is not an error.** The L5 gate returns `Verdict` in the **success**
  channel: `Admit | AdmitUnderLimits | Refuse`, a closed exhaustive union, agent-local,
  never on the wire. A refused frame is withheld from the runtime but remains in the
  transcript (`screening.md` inv. 2–3): screening filters attention, not the record.

Exhaustiveness rule: every internal union (`StoreError`, `RegistryError`,
`AttributionError`, `Verdict`, `LifecycleEntry` arms an adapter knows) is matched with a
`never`-typed default. The two **open** unions (`TranscriptUnit`/`CollectiveUnit` op set,
`RefusalCause`) are open by construction; an adapter matches its known arms exhaustively
and refuses the rest, so widening by charter #765 is additive and localized.

## Dependencies

This is a spec-track design doc; it installs nothing. Versions are recommended pins for
the implementer. The **port surface names none of the adapter-tier libraries** below;
they appear only inside adapters, behind the five tags.

| Library | Version | License | Why (and where) |
|---|---|---|---|
| `effect` | ^3.x (pin at W1) | MIT | The realization substrate (constraint 4): `Context.Tag`, `Layer`, `Effect`, `Stream`, `Schema`, `Brand`. The only dependency the port surface and `wire` need. |
| `@peculiar/x509` | ^1.x | MIT | X.509 card mint/verify inside `RegistryLive`/`AttributionInterim` (`identity.md` container). Adapter-tier; `Card` is opaque bytes at the port. |
| `@noble/ed25519` | ^2.x | MIT | Ed25519 sign/verify inside the Attribution adapters (`interim-signature-profile`). Adapter-tier. |
| (RFC 9421 signer) | — | — | HTTP Message Signatures for `AttributionInterim` and the control RPC skin. Small enough to re-implement from the profile (300 s window, keyid = agent-id URI); no maintained pin assumed. Adapter-tier only. |

No port or law depends on a storage or transport library: `Store` engine choice and the
`Plane` wire both live behind their tags (constraint 3, sessionless: no socket,
connection, session, or lease in any signature above).

## Traceability

Spec guarantee/invariant → the port or law that carries it. `L#` names the layer.

| Spec citation | Carried by |
|---|---|
| `layers.md` → Layering rules (config down, guarantees up; no reach above) | Enforced as: adapters require only lower port tags; decorators are `Layer<Port,_,Port>` (config as parameter); `law/conformance` maps each L# to properties over ports realizing ≤ L#. Checked over five tags, not fifteen. |
| `identity.md` inv. 1, 4 (attributable to one agent; verify offline; body not interpreted) | **Attribution** port (`open` takes frame + card, no round trip); `wire.Envelope` is the readable view. |
| `identity.md` inv. 2 (only sender's harness attributes) | **Attribution.seal**; private key is adapter state (L1). |
| `identity.md` inv. 3 (identity linked to a principal) | **Registry.mint** binds `PrincipalRef` into the card. |
| `identity.md` inv. 5 (attests who, not intent) | Attribution/Registry surface carry no trust field; trust is L5 (`law/screening`). |
| `identity.md` → One shape, two attribution bindings | **Attribution** is one port, two adapters (`Interim`/`Target`); recipients and L6 use `open` under both. |
| `identity.md` → Byte preservation | Cross-cutting **byte-exactness law** over Plane + Store: `EncodedFrame` in = persisted = delivered = read. |
| `directory-serves-cards` (card is the directory entry) | **Registry.resolve/enumerate** return `Card`; no thinner projection. |
| `data-plane.md` inv. 1 (envelope-only routing/admission) | **Plane** admission opens `Envelope`, never `Body`. |
| `data-plane.md` inv. 2 (never mint/alter/strip attribution) | **Plane** carries `EncodedFrame` byte-exact; only **Attribution** touches attribution. |
| `data-plane.md` inv. 3 (total order + convergence) | **Store** order law + **Plane.read** recovery law. |
| `data-plane.md` inv. 4 / storage guarantee 1 (durable-then-deliver) | Cross-cutting **durable-then-deliver law**: `Plane.ship` returns only after `Store.append` durability; `deliveries` consume committed records. |
| `data-plane.md` inv. 5 (admission observable before generation) | **Plane** law "admission observable before generation"; the PCC instrument is internal to `PlaneLive`, in no signature. |
| `data-plane.md` inv. 7 (equivocation robustness) | Holds by construction: single `Store` copy + byte-exact fan-out; a `law/conformance` property pins it. |
| `data-plane.md` inv. 8 / storage guarantee 5 (membership in-band) | `LifecycleEntry` arms in **Store**; `membershipAt` derivation (`law/derive`). |
| `data-plane.md` inv. 9 (no principal vetoes; admission never mutates membership) | **Plane** admission returns `Refusal` only; membership changes only via `LifecycleEntry` appends. |
| `data-plane.md` inv. 11 (implementation-swap equivalence) | **Plane** is one tag: `PlaneLive` vs `PlaneTestbed` is one `Layer` binding; `law/conformance` swap runner. |
| `data-plane.md` inv. 12 / `sessionless-network` (no per-endpoint state) | No signature names a session/connection; `Plane.read` takes an endpoint-owned `Cursor`. |
| `data-plane.md` inv. 13, 14 (data-only surface, byte-exact; one-way delivery) | **Plane.deliveries** is a one-way `Stream`; responses are first-class `ship`s. |
| `control-plane.md` storage guarantees 2, 3, 6 (store-owned order; ordered reads; immutability) | **Store** law set; no update/delete method exists. |
| `control-plane.md` guarantee 4 (recovery by reading) | **Plane.read** → **Store.read** from a `Cursor`. |
| `control-plane.md` guarantee 8 (member-scoped reads; witness/operator open) | **`law/entitlement`** decorator over `Store.read`; v0 predicate = membership; the seam is a parameter, not a port. |
| `control-plane.md` inv. 3, 7 (per-request auth; exactly two caller classes) | **Attribution.open** per request; `Registry`'s only writers are identity + operator; no third tag. |
| `control-plane.md` → Conversation lifecycle: no ops (`lifecycle-rides-l3`) | No lifecycle method: `initiate` is `seal` + `ship` (`law/derive`); genesis is `Store.appendGenesis`. |
| `protocol-version-carriage` (exact match, refused before state change) | Cross-cutting **version law**; `AttributionError.VersionMismatch`; `wire` comparator. |
| `channels.md` inv. 1–3 (attributable before leaving; owns recovery; harness-independent) | **Attribution** + endpoint-owned `Cursor` + **Harness** port (two adapters interoperate). |
| `contacts.md` inv. 1, 4, 5 (endpoint-resident; local immediate effect; refusals agent-local) | **ContactStore** adapter (endpoint-local, not a port); negative boundary law "no router interface serves it". |
| `contacts.md` inv. 2, 3 (gate = frame + attribution + norms + own contacts; default posture) | **`law/screening`** consumes `Attributed` + `Standing`; default posture in `ContactStore`. |
| `screening.md` inv. 1–4 (endpoint-only; never alter frame; verdicts agent-local; agent's own rules) | **`law/screening`** decorator; `Verdict` in the success channel, never on the wire. |
| `tasks.md` inv. 1–3 (no network representation; binds only pinners; marketplace reuse) | No task tag anywhere; norms are **Harness/Screening** config (bundle pinned per binding). |
| `enforcement.md` inv. 1–3, acceptance (oversight reads; reconstruct from records) | **`law/derive` evidence** = `Attribution.open` over `Store.read`; mints no monitor port, no third caller (register 3 open). |
| Payload floor (`Card`, frame, `ProtocolVersion`, `ConversationId`, `Position`, `TranscriptRecord`, lifecycle entries, collective unit, `Refusal`, `Standing`, `Verdict`) | All defined in **`wire`** or the owning port's contract; §Interfaces. |

## Open questions

Each carries a recommended default.

1. **Attribution and Registry: one identity port or two?** They are two independent swap
   axes (signing binding vs card custody), so the design keeps them as two ports.
   *Recommended default:* keep them split; fold into a single `Identity` port only if a
   decision schedules the interim→target binding migration and the registry→peer custody
   change together. Escalation: `docs/spec/identity.md`.

2. **Is `law/screening` a port (a "policy port")?** Proposal A's candidate. The design
   makes it a decorator, not a port, because the conformance suite asserts
   *expressibility* (arena and bench rulesets both expressible) not *equivalence*
   (arena-gate and bench-gate are intentionally different, so they are not
   interchangeable). *Recommended default:* keep screening a decorator with a pluggable
   predicate; promote to a port only if a shared, skill-distributable firewall vocabulary
   (`contacts.md` rec. 6) later demands cross-implementation equivalence. Escalation:
   `docs/spec/endpoints/screening.md`.

3. **The op set as an open union.** `CollectiveUnit`/`LifecycleEntry` are open unions so
   #765 widens a type, not a signature. *Recommended default:* the charter adds arms; v0
   ships `Multicast` + `Start`/`MemberAdd`/`Leave` and each adapter refuses unknown arms.
   No port method is added per op. Escalation: charter #765.

4. **Promote-a-law-to-a-port cost.** `ConversationIndex`, `AccessScope`, `TurnObserver`,
   `ReplyGuard`, and `ConversationInitiator` are laws/derivations, not tags; a future
   charter decision that needs one as an independently-swappable seam pays a promote
   refactor. *Recommended default:* accept the cost. It is mechanical and localized
   because the law already states the contract, and a tag that exists before its seam is
   decided is itself a bet against `v2/VISION.md` clause 15 ("questions stay questions").
   Escalation: charter #765 / `docs/spec/data-plane.md`.

5. **Does the Effect mapping graduate from recorded standard to a binding decision
   record?** Same question A raises. *Recommended default:* keep it a recorded standard;
   raise a decision record when the first implementation PR would deviate from the
   five-tag realization. Escalation: `docs/decisions/`.

6. **Cursor persistence (`channels.md` Q2).** The endpoint owns the recovery `Cursor`;
   what it must durably keep across restarts is a spec deliverable. *Recommended
   default:* the port takes a `Cursor` value and binds no persistence; the endpoint
   composition decides durability under the W6.S2 spec item. Escalation:
   `docs/spec/endpoints/channels.md`.
