> **Archived historical, non-normative input.** The Gate 1 package and
> interface boundary is `docs/spec/layer-interfaces.md`.

# Layer interfaces — Proposal B: schema-first, boundaries as codecs

Status: DRAFT (alternative standardization proposal; sibling to
`docs/spec/layer-interfaces.md`, Proposal A)

Spec basis: `docs/architecture/layers.md`; `docs/spec/{identity,data-plane,control-plane}.md`;
`docs/spec/endpoints/{channels,contacts,screening,tasks}.md`; `v2/VISION.md`;
`docs/decisions/20260723-{eight-layer-stack,lifecycle-rides-l3,eval-plane-is-testbed,interim-signature-profile,protocol-version-carriage,directory-serves-cards}.md`;
`docs/decisions/20260721-{sessionless-network,single-credential}.md`;
`v2/drafts/v0-implementation-plan-20260723.md` (W3–W6, W8).

## Summary

Proposal A organizes by service-and-party: each payload is a branded
noun homed in one package, each service is an Effect `Context.Tag`, and
the stack's layering is recovered as a property of the Tag dependency
graph. This proposal inverts the center of gravity. The single source
of truth is a version-keyed registry of Effect `Schema`s for the
payloads; every payload's branded static type and its test `Arbitrary`
are derived from its schema rather than declared beside it; and every
layer boundary is a codec, a decode on entry and an encode on exit, so
"validate at every boundary" (Craft principle 2) is the organizing
principle and each service becomes a composition of codecs rather than
a tagged noun. The only `Context.Tag`s that survive are the effectful
capabilities the codecs consume (stores, resolvers); all data-shaping
is schema plus codec.

The three properties A states as invariants and asks reviewers to
uphold, B makes structural. Byte-exact frame preservation is a
read-through lens whose `encode` is byte-identity by construction.
Content-blindness is the absence of a body schema at any router
boundary. Store-assigned `Position` never riding the attributed unit is
`Position` not being a member of any frame schema. And because the
schemas are the source of truth, the conformance corpus is generated
from the same declaration that feeds the wire and the store: one source,
three consumers.

Openness by construction. Every chartered or register-open question
maps to a shape the schema kernel leaves unbuilt, not to a decision:
`CollectiveUnit` is a tagged union with exactly one v0 arm (MULTICAST),
so op-set growth is charter-gated schema-member addition, never a new
interface; `LifecycleEntry` is a closed union of exactly START /
MEMBER-ADD / LEAVE; attribution is a schema refinement parameterized by
a binding, identical interim vs. target (register 5); the `Refusal`
value has no wire schema (register 8); strict-decode is a codec option,
never part of a schema's identity (register 9); the transport codec is
the one seam whose schema is deliberately unbound (data-plane Q10); and
`Evidence` and monitor read-scope mint no schema (register 3).

## Modules

Two kernel modules define the standard; three assemblies compose it per
region; one derived module generates the corpus. This is a
standardization surface spanning the same territory as Proposal A's
payload table plus realization map, not a five-module implementation
PR; the module count reflects conceptual units, and each assembly is a
composition, not new public surface.

1. **`v2/schema`** — the single source of truth. Per-layer schema
   sub-modules (`schema/l1`, `schema/l3`, `schema/l5`, `schema/x` for
   cross-layer), each exporting `Schema` values, their derived branded
   `Type`s, and their derived `Arbitrary`s. A version-keyed
   `SchemaRegistry` selects the `SchemaSet` for exactly one
   `ProtocolVersion`. Public surface: the schemas, the registry, the
   `Lens` marker. Dependencies: `effect` (`Schema`, `Arbitrary`,
   `Equivalence`, `Brand`) only; imports no other v2 module. This is the
   kernel; everything else consumes it.

2. **`v2/codec`** — boundary combinators over the schemas. `Boundary<A,
   I, R>` (the composition unit), `boundary` (pure, from a schema),
   `refine` (effectful narrowing that realizes guarantees-flow-up),
   `ProtocolGate` (a precondition boundary), the read-through `Lens`
   builder, the total `ParseError → Refusal` mapping, the strict-decode
   option surface, and `TransportCodec` (the one wire seam, schema
   unbound). Also the sole `Context.Tag`s: the effectful capabilities
   (`CardResolver`, `TranscriptStore`, `ConversationIndex`,
   `AccessScope`, `ContactStore`, `RecoveryCursor`, `X509Verify`).
   Dependencies: `v2/schema`, `effect`.

3. **Router assembly** (home `v2/server`) — composes boundaries into the
   `AdmissionPipeline` (bytes → durable `TranscriptRecord`) and
   `ReadPipeline` (request → page of records). Owns no schema and no new
   data type; it is decode ▷ guard ▷ refine ▷ store ▷ encode wiring plus
   the capabilities' live layers. Dependencies: `v2/codec`, `v2/schema`.

4. **Endpoint assembly** (home `v2/channel`) — composes the
   `InboundPipeline` (verify ▷ gate, refused = withheld view), the
   `OutboundPipeline` (author ▷ gate ▷ ship), `TurnObserver` /
   `ReplyGuard`, framing (`FrameAuthor` = encode, verify = decode-refine),
   the endpoint-owned `RecoveryCursor` decode, and contacts. The
   interpretive locus: the only region whose boundaries decode a
   `GateVerdict`. Dependencies: `v2/codec`, `v2/schema`.

5. **Testbed transport** (home `v2/testbed-plane`) — an alternate
   `TransportCodec` behind the identical payload schemas, plus
   envelope-level observation and bounded injection. The swap
   (data-plane inv. 11) is: replace this module's `TransportCodec`; the
   payload schemas and every boundary above them are unchanged.
   Dependencies: `v2/codec`, `v2/schema`.

6. **`v2/conformance`** — generates the corpus from `v2/schema`'s
   `Arbitrary`s: one roundtrip and one rejection property per registered
   schema, plus the cross-boundary byte-exactness property. Emits
   skeletons a human completes with a doc citation and a spec/pin
   partition tag. Dependencies: `v2/schema`, `v2/codec`.

Folder shape: `v2/schema` and `v2/codec` are a two-layer stack (codec
imports schema, never the reverse); the three assemblies are a tree
(peers of the kernel, none importing another assembly); `v2/conformance`
is a leaf consuming both kernel modules. The shape is visible from the
directory listing: kernel below, assemblies beside, corpus at the edge.

## Interfaces

TypeScript signatures with typed error channels; no bodies. `Schema.Schema<A, I, R>`
reads "decodes to `A` from encoded `I`, needing context `R`."

### Kernel: `v2/codec` combinators

```ts
// The composition unit. A Boundary is a schema-derived codec whose decode
// may require capabilities R and whose failure is ALWAYS a Refusal (the
// ParseError -> Refusal mapping is total). Pure boundaries have R = never.
export interface Boundary<A, I, R = never> {
  readonly schema: Schema.Schema<A, I>;
  readonly decode: (input: I) => Effect.Effect<A, Refusal, R>;
  readonly encode: (value: A) => Effect.Effect<I, never, R>;
  // Strict-decode posture. Implementation default "error"; never part of a
  // schema's identity and never asserted by a spec-partition property.
  readonly onExcess: "error" | "ignore";
}

// Build a pure boundary from a schema. Strictness defaults to "error".
export const boundary: <A, I>(
  schema: Schema.Schema<A, I>,
  onExcess?: "error" | "ignore",
) => Boundary<A, I, never>;

// A refinement boundary: narrows a decoded lower-layer view A to a
// higher-layer view B iff an effectful check holds. Guarantees flow UP:
// B's encoded form IS A, so B is unconstructible unless A already decoded.
export const refine: <A, B extends A, R>(
  to: Schema.Schema<B, A>,
  check: (a: A) => Effect.Effect<B, Refusal, R>,
) => Boundary<B, A, R>;

// A read-through lens: a Schema whose encode is byte-identity on the input
// its decode retained. `retained` witnesses the law encode(a) ≡ retained(a).
// This is how decode-at-boundary coexists with byte-exact preservation.
export interface Lens<A, I> extends Schema.Schema<A, I> {
  readonly _codec: "read-through";
  readonly retained: (a: A) => I;
}
export const lens: <A, I>(
  decode: (i: I) => Effect.Effect<A, Refusal>,
  retained: (a: A) => I,
) => Lens<A, I>;

// A precondition boundary: refuses BEFORE any payload decode if the carried
// version is not exactly the pinned one (protocol-version-carriage:
// exact match, refused before state change).
export const ProtocolGate: (
  pinned: ProtocolVersion,
) => Boundary<VersionMatched, RawRequest, never>;

// The ONLY seam that touches the wire. Its Wire type is deliberately
// unbound (data-plane.md Q10): the payload schemas are in-process; a future
// wire shape lands here without disturbing anything above.
export interface TransportCodec<Wire> {
  readonly shipEncode: (frame: EncodedFrame) => Effect.Effect<Wire, Refusal, never>;
  readonly deliveryDecode: (wire: Wire) => Effect.Effect<TranscriptRecord, Refusal, never>;
}
```

### Kernel: `v2/schema` — cross-layer (`schema/x`)

```ts
// CalVer protocol version. Exact match is the schema's own Equivalence
// (salvaged segment comparator; missing segments compare as zero).
export const ProtocolVersion: Schema.Schema<ProtocolVersion, string>;
export type ProtocolVersion = string & Brand.Brand<"ProtocolVersion">;
export const protocolExactMatch: Equivalence.Equivalence<ProtocolVersion>;

// One interim refusal value. Its WIRE projection is intentionally NOT a
// schema (register 8 stays open): only the in-process value is defined.
export const Refusal: Schema.Schema<Refusal>;
export interface Refusal { readonly _tag: "Refusal"; readonly reason: RefusalReason }

// Opaque, fail-closed paging token. decode fails closed on any malformed or
// out-of-policy cursor; there is one sanctioned decoder.
export const Cursor: Schema.Schema<Cursor, string>;
export type Cursor = string & Brand.Brand<"Cursor">;

// The registry is keyed by ProtocolVersion. Exact-match decode selects the
// SchemaSet for exactly the carried version; no negotiation, no cross-version
// union. Schema evolution is a new keyed SchemaSet, not a wider schema.
export interface SchemaRegistry {
  readonly at: (v: ProtocolVersion) => Option.Option<SchemaSet>;
  readonly current: SchemaSet;
}
```

### Kernel: `v2/schema` — L1 (`schema/l1`)

```ts
export const AgentId: Schema.Schema<AgentId, string>;       // opaque, registry-minted, survives rotation
export type AgentId = string & Brand.Brand<"AgentId">;
export const PrincipalRef: Schema.Schema<PrincipalRef, string>; // opaque linkage; depth open

// Opaque bytes, never decoded below L4. Content-blindness IS the absence of
// any router-side schema that refines Body.
export const Body: Schema.Schema<Body, Uint8Array>;
export type Body = Uint8Array & Brand.Brand<"Body">;

// The attributed unit as opaque bytes; byte-exact at every hop.
export const EncodedFrame: Schema.Schema<EncodedFrame, Uint8Array>;
export type EncodedFrame = Uint8Array & Brand.Brand<"EncodedFrame">;

// Carrier-readable envelope view. Carries no store-assigned field (Position
// is not a member; that exclusion is invariant 7, made structural).
export interface Envelope {
  readonly sender: AgentId;
  readonly conversation: ConversationId;
  readonly protocol: ProtocolVersion;
  readonly attribution: AttributionMaterial; // opaque under the binding in effect
}
export const Envelope: Schema.Schema<Envelope>;

// Read-through lens: decode projects {envelope, body, bytes}; encode returns
// the retained bytes verbatim. encode ∘ decode ≡ id, bytewise.
export interface FrameView { readonly envelope: Envelope; readonly body: Body; readonly bytes: EncodedFrame }
export const FrameView: Lens<FrameView, EncodedFrame>;

// The card as its signed X.509 structure, a read-through lens over DER:
// decode verifies over the signed structure (library, never hand-rolled)
// and projects the fields; encode returns the DER verbatim.
export interface CardView {
  readonly agent: AgentId;
  readonly principal: PrincipalRef;
  readonly name: DisplayName;
  readonly key: VerificationKey;
  readonly issuedAt: IssuedAt;
  readonly der: CardDer;
}
export const Card: Lens<CardView, CardDer>; // decode needs X509Verify (below)

// Attribution binding selector. The refined AttributedFrame TYPE is identical
// under both; only the check differs (register 5 stays open).
export type AttributionBinding = "interim-request-sig" | "target-frame-sig";

// AttributedFrame refines FrameView. Minted ONLY by the attribution boundary;
// no constructor skips the check (phantom brand enforces it).
export interface AttributedFrame extends FrameView { readonly _attributed: unique symbol }
export const AttributedFrame: Schema.Schema<AttributedFrame, FrameView>;
export const attributionBoundary: (
  binding: AttributionBinding,
) => Boundary<AttributedFrame, FrameView, CardResolver>;

// The sender's harness is the only encoder of attribution (identity inv. 2):
// FrameAuthor is encode-only; no router boundary encodes a frame.
export const FrameAuthor: (
  binding: AttributionBinding,
) => { readonly author: (draft: FrameDraft) => Effect.Effect<EncodedFrame, Refusal, never> };
```

### Kernel: `v2/schema` — L3 (`schema/l3`)

```ts
export const ConversationId: Schema.Schema<ConversationId, string>; // client-minted; collision-free by a size refinement
export type ConversationId = string & Brand.Brand<"ConversationId">;

// Store-assigned. Its ONLY constructor is the store's append boundary, and it
// is not a member of any frame schema. Invariant 7 becomes unrepresentability.
export const Position: Schema.Schema<Position, string>;
export type Position = string & Brand.Brand<"Position">;

// A committed record: frame bytes verbatim PLUS the store's position. Position
// sits outside the frame; the frame stays byte-exact.
export interface TranscriptRecord { readonly frame: EncodedFrame; readonly position: Position }
export const TranscriptRecord: Schema.Schema<TranscriptRecord>;

// Closed union: exactly the v0 entry types. Adding an arm is a charter-gated
// schema change (#765); the interface names no other.
export type LifecycleEntry =
  | { readonly _tag: "START" }
  | { readonly _tag: "MEMBER_ADD"; readonly member: AgentId }
  | { readonly _tag: "LEAVE"; readonly member: AgentId };
export const LifecycleEntry: Schema.Schema<LifecycleEntry>;

// v0 collective unit: a union with exactly ONE arm. Op set beyond MULTICAST is
// added as union members under the charter, never as a new interface.
export type CollectiveUnit = { readonly _tag: "MULTICAST"; readonly frame: EncodedFrame };
export const CollectiveUnit: Schema.Schema<CollectiveUnit>;
```

### Kernel: `v2/schema` — L5 (`schema/l5`)

```ts
export type Standing = "allow" | "deny" | "limit";
export const Standing: Schema.Schema<Standing>;

export type GateVerdict =
  | { readonly _tag: "admit" }
  | { readonly _tag: "admit-under-limits"; readonly limits: LimitConstraints } // limits endpoint-opaque
  | { readonly _tag: "refuse" };
export const GateVerdict: Schema.Schema<GateVerdict>;
```

### Capabilities: the only `Context.Tag`s (`v2/codec`)

```ts
// Everything data-shaped is a schema+codec; these tags are the effectful
// capabilities boundaries consume. Tag ids are permanent "moltzap/v2/<Cap>".
export class CardResolver extends Context.Tag("moltzap/v2/CardResolver")<
  CardResolver,
  { readonly resolve: (id: AgentId) => Effect.Effect<CardView, Refusal, X509Verify> }
>() {}

export class X509Verify extends Context.Tag("moltzap/v2/X509Verify")<
  X509Verify,
  { readonly verify: (der: CardDer) => Effect.Effect<CardView, Refusal> } // over the signed structure
>() {}

export class TranscriptStore extends Context.Tag("moltzap/v2/TranscriptStore")<
  TranscriptStore,
  {
    readonly append: (unit: CollectiveUnit) => Effect.Effect<Position, Refusal>;        // one unit, one txn, commit-time position, after durability
    readonly appendGenesis: (frame: EncodedFrame) => Effect.Effect<Position, Refusal>;  // atomic iff id unused; reuse refuses with no side effect
    readonly read: (conv: ConversationId, window: ReadWindow) => Effect.Effect<ReadonlyArray<TranscriptRecord>, Refusal>;
    readonly listConversations: (who: AgentId, cursor: Cursor) => Effect.Effect<Page<ConversationId>, Refusal>;
  }
>() {}

export class ConversationIndex extends Context.Tag("moltzap/v2/ConversationIndex")<
  ConversationIndex,
  { readonly membershipAt: (conv: ConversationId, at: Position) => Effect.Effect<ReadonlyArray<AgentId>, Refusal> }
>() {}

export class AccessScope extends Context.Tag("moltzap/v2/AccessScope")<
  AccessScope,
  { readonly entitled: (who: AgentId, conv: ConversationId) => Effect.Effect<boolean, never> } // v0: membership only
>() {}

export class ContactStore extends Context.Tag("moltzap/v2/ContactStore")<
  ContactStore,
  {
    readonly standing: (id: AgentId) => Effect.Effect<Standing, never>; // default posture absent a record
    readonly set: (id: AgentId, s: Standing) => Effect.Effect<void, never>; // immediate effect, zero network
  }
>() {}

export class RecoveryCursor extends Context.Tag("moltzap/v2/RecoveryCursor")<
  RecoveryCursor,
  {
    readonly position: (conv: ConversationId) => Effect.Effect<Option.Option<Position>, never>; // endpoint-owned, never plane state
    readonly commit: (conv: ConversationId, at: Position) => Effect.Effect<void, never>;
  }
>() {}
```

### Assemblies: region pipelines

```ts
// Router (v2/server). Compositions of boundaries; no new schema, no new tag.

export interface AdmissionPipeline {
  // decode-bracketed: raw bytes -> durable TranscriptRecord. EVERY refuse
  // boundary precedes the store append (durable-then-deliver).
  readonly admit: (raw: RawShip) => Effect.Effect<
    TranscriptRecord, Refusal, CardResolver | ConversationIndex | TranscriptStore
  >;
}
export interface ReadPipeline {
  readonly read: (raw: RawRead) => Effect.Effect<
    Page<TranscriptRecord>, Refusal, CardResolver | AccessScope | TranscriptStore
  >;
}

// Endpoint (v2/channel). The interpretive region: the only boundaries that
// decode a GateVerdict.

export interface InboundPipeline {
  // Verify ▷ gate. Refused = None (view withheld from the agent); the record
  // stays in the store (screening filters attention, never the record).
  readonly receive: (raw: RawDelivery) => Effect.Effect<
    Option.Option<AttributedFrame>, Refusal, CardResolver | ContactStore
  >;
}
export interface OutboundPipeline {
  // Author (encode) ▷ gate ▷ ship. FrameAuthor is the only attribution encoder.
  readonly send: (draft: FrameDraft) => Effect.Effect<EncodedFrame, Refusal, ContactStore>;
}

export interface TurnObserver {
  // Admission observed before generation (data-plane inv. 5). The signal is a
  // decoded value, not a connection; PCC is an off-wire instrument, no schema.
  readonly awaitAdmission: (conv: ConversationId) => Effect.Effect<AdmittedTurn, Refusal, never>;
}
export interface ReplyGuard {
  readonly guard: (turn: AdmittedTurn) => Effect.Effect<OneShotSend, Refusal, never>; // one admitted turn -> at most one send
}

export interface ConversationInitiator {
  // Mints a fresh id (collision-free by size), emits CONVERSATION-START through
  // the ordinary send path; no provisioning (lifecycle-rides-l3).
  readonly initiate: (members: ReadonlyArray<AgentId>, body: Body) => Effect.Effect<ConversationId, Refusal, never>;
}
```

### Derived: `v2/conformance`

```ts
export interface DocCitation { readonly doc: string; readonly criterion: string }

export interface ConformanceProperty<A, I> {
  readonly cite: DocCitation;          // unbuildable without a citation
  readonly partition: "spec" | "pin";  // strict-decode tests are "pin"; never gate acceptance (register 9)
  readonly check: Effect.Effect<PropertyResult, PropertyFailure, SubjectHandle>; // failures are values, never throws
}

// For a read-through lens: encode ∘ decode ≡ id on retained bytes.
export const roundtrip: <A, I>(l: Lens<A, I>) => ConformanceProperty<A, I>;

// For any schema: inputs OUTSIDE the schema are refused, fuzzed via the
// schema's derived Arbitrary. Excess-key cases are auto-tagged "pin".
export const rejection: <A, I>(s: Schema.Schema<A, I>) => ConformanceProperty<A, I>;

// Cross-boundary: a frame admitted at ingress and delivered at egress is
// byte-identical (data-plane inv. 13; identity Byte preservation).
export const byteExactness: ConformanceProperty<EncodedFrame, Uint8Array>;

// The generator: one roundtrip + one rejection per registered schema, from the
// schema's Arbitrary. A human attaches cite + partition; the generator never
// mints an acceptance-gating property on its own (register 9 safety).
export const generateCorpus: (r: SchemaRegistry) => ReadonlyArray<ConformanceProperty<unknown, unknown>>;
```

## Data flow

Dominant path: an agent's outbound send crossing into the router,
committing, and fanning out to a member endpoint. `[[bytes]]` marks the
same byte-image threaded end to end; the lens never re-serializes it.

```
ENDPOINT (sender)                 ROUTER                        ENDPOINT (recipient)
-----------------                 ------                        --------------------
FrameDraft
   |
   | OutboundPipeline.send
   v
OutboundGate.decode(GateVerdict) --refuse--> withheld (agent-local, no wire)
   |
   v
FrameAuthor.encode  ==> [[EncodedFrame]]
   |
   |  ship (TransportCodec.shipEncode; wire shape unbound, Q10)
   +--------------------------------> RawShip
                                        |
                                        | AdmissionPipeline.admit
                                        v
                                     ProtocolGate.decode --mismatch--> Refusal (before decode, before state)
                                        |
                                        v
                                     FrameLens.decode([[bytes]]) --malformed--> Refusal
                                        |   (envelope view only; Body never decoded => content-blind)
                                        v
                                     attributionBoundary.refine --invalid--> Refusal
                                        |   (needs CardResolver -> X509Verify)
                                        v
                                     Membership.refine --not a member--> Refusal
                                        |   (needs ConversationIndex.membershipAt)
                                        v
                                     CollectiveUnit.decode (v0: MULTICAST) --unknown op--> Refusal
                                        |
                                        v
                          [ every refusal above precedes durability ]
                                        |
                                     TranscriptStore.append ==> Position   (durable-then-deliver)
                                        |
                                     TranscriptRecord = { [[EncodedFrame]], Position }
                                        |   (Position OUTSIDE the frame; frame still byte-exact)
                                        |
                                        | DeliveryPush (one-way; TransportCodec; encode-only, no response path)
                                        +---------------------------------------> RawDelivery
                                                                                    |
                                                                                    | InboundPipeline.receive
                                                                                    v
                                                                                 TransportCodec.deliveryDecode
                                                                                    v
                                                                                 FrameLens.decode([[bytes]])
                                                                                    v
                                                                                 attributionBoundary.refine --invalid--> Refusal
                                                                                    v
                                                                                 InboundGate.decode(GateVerdict, ContactStore)
                                                                                    |  refuse --> None (withheld; record stays in store)
                                                                                    v
                                                                                 Some(AttributedFrame) -> agent
```

Recovery path (no session): after any miss the recipient reads from its
own `RecoveryCursor.position`, `TranscriptStore.read(conv, window)`
returns byte-exact records, and convergence is reaching the same
observed sequence. No boundary names a connection; resuming at a
position equals never disconnecting.

Two threads the diagram makes structural: (1) `[[EncodedFrame]]` is one
byte-image from `FrameAuthor.encode` to the recipient's `FrameLens.decode`
because each lens `encode` returns `retained(a)`; (2) `Position` appears
only at and after `TranscriptStore.append`, never inside `[[bytes]]`.

## Errors

Every boundary's error channel is `Refusal`. The `ParseError → Refusal`
mapping is total, so `decode` never throws or defects; defects are
isolated at the subscriber registry and never cross a boundary. The
refusal reason is an internal discriminated union; consumers `switch`
with an `absurd(_: never)` default so a new reason is a compile error at
every handler.

```ts
export type RefusalReason =
  | { readonly _tag: "VersionMismatch"; readonly carried: ProtocolVersion; readonly pinned: ProtocolVersion }
  | { readonly _tag: "MalformedEnvelope" }
  | { readonly _tag: "AttributionInvalid" }
  | { readonly _tag: "SenderUnknown" }
  | { readonly _tag: "NotAMember" }
  | { readonly _tag: "UnknownOp" }      // any CollectiveUnit arm beyond v0 MULTICAST
  | { readonly _tag: "IdInUse" }        // genesis reuse; append refuses with no side effect
  | { readonly _tag: "InvalidCursor" }  // fail-closed
  | { readonly _tag: "Unentitled" };    // AccessScope; v0 = non-member
```

The wire projection of `Refusal` is deliberately unbuilt (register 8):
there is no `RefusalWire` schema, and conformance asserts refusal
*effect* ("the op did not take effect"), never refusal *shape*. The
`GateVerdict` `refuse` arm is not a `Refusal`; it is a decoded verdict
whose consequence is withholding a view, agent-local, with no wire
representation (contacts inv. 5, screening inv. 3).

## Dependencies

| Library | Version | License | Why this one |
|---|---|---|---|
| `effect` | pin the `v2/*` workspace `effect` (candidate `^3.12`) | MIT | Mandated substrate (constraint 4). `Schema` gives decode, encode, `Arbitrary`, `Equivalence`, and `Brand` from one declaration, which is exactly the one-source-of-truth this proposal is built on. Schema is folded into `effect` core in 3.x, so no separate `@effect/schema` dep. |
| `fast-check` | pin to `effect`'s peer (candidate `^3.x`) | MIT | The target of `Schema`'s derived `Arbitrary`; the conformance generator produces `fast-check` properties from schemas. Already the ecosystem-standard property runner. |

Out of this proposal's changed surface: the Ed25519 / X.509 / RFC 9421
libraries live behind the `X509Verify` and request-signature capability
tags and are W2's choice (`v2/drafts/v0-implementation-plan → W2`); the
kernel only names the seam (`Card` lens, `CardResolver`). The transport
library is behind `TransportCodec` and is unbound (data-plane Q10).

## Traceability

Spec guarantee or invariant → the interface that carries it. Where B
makes an A-invariant structural, the cell says so.

| Spec (doc → invariant) | Carried by |
|---|---|
| identity.md inv. 1 (attributable to one agent; verifies from frame + material) | `attributionBoundary.refine` over `FrameView`; `AttributedFrame` unconstructible without the check |
| identity.md inv. 2 (only the sender's harness produces attribution) | `FrameAuthor` is the sole attribution encoder; no router boundary has an `encode` for a frame |
| identity.md inv. 4 (attribution covers body + addressing; verify never interprets body) | `FrameView` decode reads `Envelope` only; `Body` opaque, never refined at a router boundary |
| identity.md → Byte preservation | `FrameView`/`Card` are `Lens`; `encode ≡ retained` (byte-identity) is structural, not a rule |
| data-plane.md inv. 1 (routing/admission read envelope only) | admission boundaries decode `Envelope`; no `Body` schema exists router-side (content-blindness = schema absence) |
| data-plane.md inv. 2 (never mint/alter/strip attribution) | router has decode-refine only; no attribution `encode` boundary in the router assembly |
| data-plane.md inv. 3 (total order; convergence) | `Position` minted only by `TranscriptStore.append`; recovery via `RecoveryCursor` + `read` |
| data-plane.md inv. 4 (durable-then-deliver) | `AdmissionPipeline`: all refuse-boundaries precede `append`; `DeliveryPush` encode only after `append` |
| data-plane.md inv. 5 (turn observed before generation) | `TurnObserver.awaitAdmission` decoded before generate; PCC off-wire, no schema |
| data-plane.md inv. 7 (equivocation robustness) | one `TranscriptRecord`, one `[[EncodedFrame]]` byte-image, byte-exact fan-out via the lens |
| data-plane.md inv. 11 (implementation-swap equivalence) | swap = replace `TransportCodec` only; payload schemas + boundaries unchanged; identical generated corpus |
| data-plane.md inv. 12 (no per-endpoint session state) | no boundary signature names a connection; recovery is `RecoveryCursor` decode |
| data-plane.md inv. 13 (byte-exact, never re-encoded) | `Lens.encode ≡ retained`; structural |
| data-plane.md inv. 14 (one-way delivery) | `DeliveryPush`/`TransportCodec.deliveryDecode` is encode-only egress; no response boundary on the delivery path |
| control-plane.md storage guarantee 2 (store-owned order) | `Position` schema constructible only inside `TranscriptStore.append` |
| control-plane.md storage guarantee 7 (content-blind store) | store holds `EncodedFrame` bytes; no body schema at the store boundary |
| control-plane.md inv. 3 (per-request auth; sessionless) | each request decoded through the request-signature boundary; no session schema anywhere |
| control-plane.md → Op families (directory serves cards) | `CardResolver.resolve`/directory returns `CardView` (the `Card` lens); no thinner projection schema |
| lifecycle-rides-l3 (in-band; no create op) | `LifecycleEntry` closed union; `appendGenesis`; no control-plane create boundary exists |
| protocol-version-carriage (exact match; refused before state) | `ProtocolVersion` `Equivalence`; `ProtocolGate` refuses before any payload decode |
| contacts.md inv. 2/3 (gate = f(frame, attribution, norms, own contacts); default posture) | `InboundPipeline.receive` decodes `GateVerdict` over `AttributedFrame` + `ContactStore.standing` |
| screening.md inv. 2/3 (refused = withheld, record intact) | refuse arm returns `Option.none`; the `TranscriptRecord` already appended |
| VISION clause 5 (e2e encryption stays possible) | `Body` opaque schema, decoded by no router boundary; encryption is a body-side concern the kernel never touches |

Name closure to Proposal A / the v0 plan: A's `FrameVerifier` →
`attributionBoundary` + `FrameView` lens; A's `FrameAuthor` → `FrameAuthor`
(encode boundary); A's `TranscriptStore`/`ConversationIndex`/`AccessScope`/
`IdentityRegistry`/`ContactStore`/`CardResolver`/`RecoveryCursor` → the
capability tags (unchanged in spirit, now the only tags); A's `DataPlane`/
`TransportPort` → `TransportCodec` (payload/wire split explicit); A's
`InboundGate`/`OutboundGate` → the gate-decoding boundaries inside the
endpoint pipelines; A's `TurnObserver`/`ReplyGuard`/`ConversationInitiator`
→ same names, now boundary-shaped.

## Open questions

Each carries a recommended default and an escalation target.

1. **One `v2/schema` package vs. per-layer schema packages.** Default:
   one package with per-layer modules. The version-keyed registry is one
   registry, and the kernel's cohesion argues against scattering it
   across homes the way A scatters nouns. Escalation: W1 package-map
   review (`v0-implementation-plan → W1.S1`).
2. **Whether `Boundary` (the effectful codec) graduates from a recorded
   standard to a decision record binding v2 idiom.** Default: recorded
   standard until the first implementation PR would deviate (parallels
   A's open question 2). Escalation: maintainer decision record.
3. **Whether corpus generation is mandatory per schema or opt-in.**
   Default: mandatory skeleton (every registered schema gets a roundtrip
   and a rejection), human attaches citation and spec/pin tag; the
   generator never mints an acceptance-gating property, so register 9
   stays open by construction. Escalation: W8 conformance-framework
   ownership.
4. **Where the `Card` X.509 verify lives.** Default: `Card.decode`
   delegates to `X509Verify` (verification over the signed structure,
   never hand-rolled), so the lens is effectful (`R = X509Verify`).
   Escalation: W2 identity chapter.
5. **`Position` exclusion: structural only, or plus a canary.** Default:
   structural (Position is a member of no frame schema) plus a
   `*.types-check.ts` canary pinning that `EncodedFrame`/`Envelope`/
   `FrameView` have no `Position`-typed field. Escalation: none; add the
   canary in the same PR that lands the schemas.
6. **Strict-decode default (`"error"` vs `"ignore"`) at boundaries.**
   Default: `"error"` as an implementation posture, exposed as the
   `Boundary.onExcess` parameter, asserted by no spec-partition property
   (register 9 open). Escalation: register 9 resolution.
7. **Whether the read-through `Lens` law is worth its own conformance
   property beyond `roundtrip`.** Default: `roundtrip` (`encode ∘ decode
   ≡ retained`) is the law; no extra property. Escalation: W8 if a lens
   ever retains something other than its exact input bytes.

## References

- Proposal A: `docs/spec/layer-interfaces.md` — the service-and-party
  standardization this proposal offers an alternative to.
- `docs/architecture/layers.md`; `docs/decisions/20260723-eight-layer-stack.md`
  — the stack and its layering rules.
- `docs/spec/{identity,data-plane,control-plane}.md`;
  `docs/spec/endpoints/{channels,contacts,screening,tasks}.md` — the
  guarantee-level obligations behind each schema and boundary.
- `docs/decisions/20260723-{lifecycle-rides-l3,eval-plane-is-testbed,interim-signature-profile,protocol-version-carriage,directory-serves-cards}.md`;
  `docs/decisions/20260721-{sessionless-network,single-credential}.md` —
  the recorded decisions this proposal realizes without reopening.
- `v2/drafts/v0-implementation-plan-20260723.md` — the workstream
  interface sketches (W3–W6, W8) whose names close against §Traceability.
- v1 Effect idiom precedent: `packages/server/src/message/layer.ts`
  (`Context.Tag` + `Layer.effect`), re-implemented never imported.
