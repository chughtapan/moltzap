> **Deferred historical, non-normative input.** Gate 1 standardizes
> deterministic SharedCore validation but defers semantic L5. See
> `docs/spec/endpoints/screening.md`.

# Firewall plan — Proposal: the firewall is a norm interpreter with agent sovereignty

Status: DRAFT (alternative firewall-plan proposal; fills the interior of
`docs/spec/endpoints/screening.md` open question 2 /
`docs/spec/layer-interfaces.md` open question 2. Sibling to the other
firewall-plan proposals under this directory.)

Spec basis: `docs/spec/endpoints/screening.md` (the gate model, the five
violation responses, invariants 1–5); `docs/spec/endpoints/contacts.md`
(the v0 stopgap, treated here as ONE input, not the design);
`docs/spec/layer-interfaces.md` (the two directional hooks, laws
L5.1–L5.6, `Channel`/`Txn`, `InboundMessage`/`FirewallContext`, the
everyday-vocabulary rule); `docs/spec/endpoints/tasks.md` (norms are
digest-pinned MCP-served skill bundles; norms are guarantees published
upward; legal moves computed from ledger state, enforced at hooks);
`v2/VISION.md` clauses 1, 8, 9; `docs/architecture/layers.md`;
`docs/decisions/20260724-{firewall-two-directions,norms-are-mcp-skill-bundles,l7-is-policy-attached-to-identity,monitors-are-deterministic-contracts,collectives-are-ledger-transactions}.md`.

Convention: `Effect<A, E>` is success/typed-refusal, matching
`layer-interfaces.md`; the requirements channel `R` is named in prose
where it matters. Nouns are branded types; firewall-owned nouns are
introduced here, wire nouns (`AgentId`, `ConversationId`, `Offset`,
`VerifiedFrame`, `Body`, `FrameDraft`, `BundleDigest`) import from
`v2/wire` by reference.

## Summary

The constitution already says the pinned norm bundle IS what the L5
gates check against (clause 8; tasks.md). This proposal takes that
literally: **most firewall rules are not authored by the agent at all —
they ship with the norm.** A norm bundle carries, alongside its prose
and its MCP tools, a set of declarative **rule fragments** in a shared,
closed vocabulary; the firewall is the endpoint's **deterministic
evaluator** of those fragments plus the agent's own overriding rules and
the deployment floor. The rule fragments are files in the bundle, so
they are covered by the same digest the participants already agree on —
same-version agreement (the one global invariant) covers the gates for
free.

The organizing idea is **one artifact, two projections.** The exact same
fragment family, evaluated with the subject bound to *my pending action*,
is the outbound gate ("here are my legal next moves"); evaluated with the
subject bound to *a peer's frame*, it is the inbound expectation ("here
is what I require of that peer"). Because both endpoints pinned the same
digest and both fold the same total order, my expectation of a peer is
byte-identical to that peer's own outbound gate. The bundle that tells
the agent its obligations tells the firewall others' obligations.

A second closure runs underneath: **one fragment, two runtimes.** A
fragment is a pure, total function over `(frame, ledger fold, ambient
facts)` — the monitors' determinism envelope
(`20260724-monitors-are-deterministic-contracts.md`). The firewall runs
it live to filter attention; an L6 monitor runs the *same* fragment over
the committed ledger to evidence a violation. A finding is therefore a
**recomputation certificate** — `\{bundle digest, evaluator hash,
fold-library hash, chain range, fact version, frame reference\}` — that
any reader re-executes to the identical verdict. "Sender X's frame at
offset N violates norm N section S" is provable, not asserted.

Agent sovereignty is **structural, not conventional.** The composite
verdict for any crossing is the *most restrictive* over three sources —
deployment floor, norm fragments, agent overrides — and "most
restrictive" (`tightest`) is the **only** combinator the evaluator
exposes. There is no operator that loosens. So the agent can always
tighten (add a rule), can loosen a norm only by not pinning it (dropping
its whole rule set — a sovereign, revocable act), and can never drop the
floor (the operator's minimum). Contacts standing is one input to the
agent tier, never a privileged gate. Semantic screening — a model's
judgment of deception or intent — stays *outside* the norm contract by
necessity: a norm that required a model judgment would make its own
digest meaningless (two endpoints with the same pin could disagree) and
its violations unprovable. Model judgment is agent-side discretion, the
endpoint analogue of L6 testimony.

The proposal's central deliverable is the rule vocabulary itself — the
"shared, skill-distributable firewall vocabulary" screening.md open
question 1 asks for: four fragment kinds (**shape**, **sequence**,
**role**, **limit**), each tagged by a norm-section id, each a pure read
of the fold, each digest-pinned and L6-recomputable.

## Modules

Four new modules, a layered pair below a tree of two. `v2/firewall-vocab`
is the kernel (the vocabulary); `v2/firewall` is the evaluator over it;
`v2/firewall-sources` and `v2/firewall-finding` are peers that consume
both. Nothing here is a port (`layer-interfaces.md` → Not ports: the
firewall contributes only its hooks); these modules are the *interior*
behind the two hooks, all endpoint-composition-local.

1. **`v2/firewall-vocab`** — the kernel: the shared rule vocabulary a
   norm bundle ships as data. Exports the four fragment kinds
   (`ShapeRule`, `SequenceRule`, `RoleRule`, `LimitRule`), their sum
   `RuleFragment`, the `RuleSet` (a bundle's fragments plus its digest),
   and the `NormProjection` reader (`myObligations` / `peersObligations`
   — the two projections of one artifact). Pure over `effect` Schema and
   the pinned fold-library *types*; imports no other firewall module.
   This is the answer to screening.md OQ1 and is the module a norm-bundle
   author writes against.

2. **`v2/firewall`** — the evaluator and the two hooks. Exports
   `Firewall` (the `inbound` / `outbound` gates that
   `layer-interfaces.md` names as the L5 contribution), the verdict types
   (`InboundVerdict`, `OutboundVerdict`), the `tightest` combinator (the
   sole verdict composer — the whole sovereignty guarantee in one
   operator), `FirewallContext` (the enrichment attached to
   `InboundMessage`), and `SemanticScreen` (agent-side discretion,
   outside the norm contract). Depends on `v2/firewall-vocab`,
   `v2/firewall-sources`, and the pinned fold library (derivations,
   trusted computing base). This is the endpoint's interpreter; it is
   itself content-addressed TCB.

3. **`v2/firewall-sources`** — the three sovereignty tiers as rule-set
   providers: `DeploymentFloor`, `NormSource` (loads a `RuleSet` from a
   pinned bundle by digest; rejects a non-conforming bundle at load),
   `AgentOverrides` (the agent's own rules, with contacts `Standing` as
   one input among several). Exports `RuleSetProvider` and `Tier`. The
   precedence order `[floor, norm, agent]` is fixed by construction; the
   evaluator folds them with `tightest`. Depends on `v2/firewall-vocab`,
   the contacts trust store (one input), and the L7 fact reader.

4. **`v2/firewall-finding`** — the L6 bridge. Exports `NormFinding` (the
   deterministic classification a fragment produces), the
   `RecomputationCertificate` (the pinned re-execution receipt), `certify`
   (finding → certificate), and `Response` (the clause-9 agent-local
   action taxonomy, distinct from the gate verdict). Depends on
   `v2/firewall-vocab` and the L6 `evidence` derivation.

Folder shape. `v2/firewall-vocab` → `v2/firewall` is a two-layer stack
(the evaluator imports the vocabulary, never the reverse).
`v2/firewall-sources` and `v2/firewall-finding` are a tree beside the
evaluator — peers, neither importing the other, composed at the endpoint
root. The shape is visible from the listing: vocabulary at the bottom,
evaluator above it, sources and findings beside.

## Interfaces

TypeScript signatures, typed refusals, no bodies. Everything a norm ships
(`v2/firewall-vocab`) is a pure, total, terminating function; the hooks
(`v2/firewall`) fail closed to a verdict value, never to the error
channel (refusals are values).

### Kernel: `v2/firewall-vocab` — the shared rule vocabulary

```ts
// Firewall-owned brands. A section id names the clause of the norm a
// fragment realizes, so a finding cites "norm N section S". A MessageKind
// is a norm-defined body kind, namespaced by the bundle digest so two
// bundles' kinds never collide.
export type SectionId = string & { readonly __brand: "SectionId" };
export type MessageKind = string & { readonly __brand: "MessageKind" };
export type RoleName = string & { readonly __brand: "RoleName" };

// The committed conversation state, read ONLY through the pinned fold
// library (applyEntry, membersAt, and norm-declared projections over
// them). A fragment may read the fold; it may not read a clock, a
// network, a random source, or a model. That closure is what makes the
// fragment deterministic (see Errors: the vocabulary ships no such
// primitive), hence same-version-agreeable and L6-recomputable.
export interface LedgerFold {
  readonly membersAt: (conversation: ConversationId, at: Offset) => Effect<ReadonlySet<AgentId>, never>;
  // Norm-declared projections resolve against the pinned fold library by
  // name; an unknown name is rejected at bundle load, never at evaluation.
  readonly project: <A>(name: ProjectionName, at: Offset) => Effect<A, never>;
}
export type ProjectionName = string & { readonly __brand: "ProjectionName" };

// Where in the order the subject sits: a peer's frame sits at its
// committed offset; the agent's pending action sits at the next offset.
// One subject shape, so a rule is written once and applied both ways.
export interface SubjectAt {
  readonly who: AgentId;          // the peer, or me
  readonly kind: MessageKind;
  readonly at: Offset;            // committed offset (inbound) or next offset (outbound)
}

// SHAPE: the body of this kind must decode against this schema. Inbound,
// a decode failure is a structural violation; outbound, an action of this
// kind must encode to it before it may compile. Tool-bundle outputs are
// inbound content, so a bundle may ship a shape rule over its own tool
// results (tool-poisoning defense; firewall-two-directions).
export interface ShapeRule {
  readonly section: SectionId;
  readonly kind: MessageKind;
  readonly body: Schema.Schema<unknown>;
}

// SEQUENCE: the legal-move predicate. A pure read of the fold that holds
// iff the kind is permitted at the subject's position. THIS is the
// projection that is the outbound gate when the subject is me and the
// inbound expectation when the subject is a peer.
export interface SequenceRule {
  readonly section: SectionId;
  readonly appliesTo: MessageKind;
  readonly legalAt: (fold: LedgerFold, subject: SubjectAt) => Effect<boolean, never>;
}

// ROLE: a role is a deterministic assignment folded from committed state
// (the leader is the current turn holder; a norm-defined role folds from
// role-assignment entries). The constraint binds a kind to allowed roles.
export interface RoleRule {
  readonly section: SectionId;
  readonly appliesTo: MessageKind;
  readonly roleOf: (fold: LedgerFold, who: AgentId, at: Offset) => Effect<RoleName, never>;
  readonly allowed: ReadonlySet<RoleName>;
}

// LIMIT: a bounded declaration producing the under-limits verdict's
// constraints (volume, rate, scope). The limit vocabulary contacts.md
// deferred; endpoints compose several limits by intersection.
export interface LimitRule {
  readonly section: SectionId;
  readonly appliesTo: MessageKind;
  readonly bound: LimitConstraints;
}
export interface LimitConstraints {
  readonly maxPerWindow: Option<number>;
  readonly window: Option<Millis>;
  readonly scope: Option<ConversationId>;     // e.g. only inside conversations already joined
}

export type RuleFragment =
  | { readonly _tag: "shape"; readonly rule: ShapeRule }
  | { readonly _tag: "sequence"; readonly rule: SequenceRule }
  | { readonly _tag: "role"; readonly rule: RoleRule }
  | { readonly _tag: "limit"; readonly rule: LimitRule };

// The fragments a bundle ships, bound to the digest that covers them.
// The digest is the bundle's, so agreeing on the pin IS agreeing on the
// rules — no separate gate agreement exists or is needed (L4.1).
export interface RuleSet {
  readonly digest: BundleDigest;
  readonly fragments: readonly RuleFragment[];
}

// One artifact, two projections. The SAME fragments read two ways.
export interface NormProjection {
  // "here are MY legal next moves" — feeds the outbound gate.
  readonly myObligations: (fold: LedgerFold, me: AgentId, at: Offset) => Effect<LegalMoveSet, never>;
  // "here is what I require of THIS peer" — feeds the inbound expectation.
  // Identical predicates to myObligations, subject swapped. Under a shared
  // pin this equals the peer's own myObligations (the closure).
  readonly peersObligations: (fold: LedgerFold, peer: AgentId, at: Offset) => Effect<ExpectedSet, never>;
}
export const projection: (rules: RuleSet) => NormProjection;

// A legal-move set is the kinds permitted now; an expected set is the
// same, read as "what a conforming peer would send". Both are folds; the
// bundle authored neither directly — they derive from the fragments.
export interface LegalMoveSet { readonly permitted: ReadonlySet<MessageKind> }
export interface ExpectedSet { readonly conforming: ReadonlySet<MessageKind> }
```

### Evaluator: `v2/firewall` — the two hooks and the sole combinator

```ts
// The L5 contribution: two directional gates on the agent's boundary
// (firewall-two-directions). Not a port; endpoint-composition-local. The
// error channel is `never`: a firewall never throws outward, it fails
// closed to a refusing verdict (Errors).
export interface Firewall {
  // Everything reaching attention: a peer frame after verify, a tool
  // result from a pinned bundle. Returns an admit-or-withhold; a withheld
  // frame is filtered from attention and STAYS in the record (L5.2).
  readonly inbound: (crossing: InboundCrossing) => Effect<Screened, never>;
  // Everything the agent does: a plain send, a committing tool call
  // before it compiles. An illegal committing action refuses at the
  // intent, before compilation begins (L5.6).
  readonly outbound: (crossing: OutboundCrossing) => Effect<Cleared, never>;
}

// The deterministic inputs to a crossing. Ambient facts (L7) and standing
// (contacts) are read-only inputs the evaluator consumes, never authors;
// contacts is one input, not a privileged gate.
export interface InboundCrossing {
  readonly subject: InboundSubject;
  readonly conversation: ConversationId;
  readonly fold: LedgerFold;
  readonly facts: FactSnapshot;               // L7 institutional facts, versioned
  readonly standing: Standing;                // contacts standing for the verified sender
  readonly binding: NormBinding;              // the digests this conversation's participants pinned
}
export interface OutboundCrossing {
  readonly subject: OutboundSubject;
  readonly conversation: ConversationId;
  readonly fold: LedgerFold;
  readonly facts: FactSnapshot;
  readonly binding: NormBinding;
}

export type InboundSubject =
  | { readonly _tag: "peer-frame"; readonly frame: VerifiedFrame }
  | { readonly _tag: "tool-result"; readonly bundle: BundleDigest; readonly result: Body };
export type OutboundSubject =
  | { readonly _tag: "send"; readonly draft: FrameDraft; readonly kind: MessageKind }
  | { readonly _tag: "tool-call"; readonly bundle: BundleDigest; readonly call: ToolCall };

// The binding names which bundle digests the participants agreed on for
// this conversation, and where the citation rides is open (tasks.md OQ3).
// A fragment binds a peer ONLY through a digest the binding cites: a peer
// who did not honor the cited pin produces provable violations, which is
// how "a norm binds only same-pin participants" (tasks.md inv. 2) is
// enforced without any network agreement check.
export interface NormBinding { readonly pinned: ReadonlySet<BundleDigest> }

// Inbound verdict: governs ATTENTION only. `withhold` is not delete.
export type InboundVerdict =
  | { readonly _tag: "admit" }
  | { readonly _tag: "admit-under-limits"; readonly limits: LimitConstraints }
  | { readonly _tag: "withhold"; readonly finding: NormFinding };

// Outbound verdict: governs whether an action COMPILES. `refuse` fires
// before compilation begins (L5.6); nothing reaches the wire.
export type OutboundVerdict =
  | { readonly _tag: "allow" }
  | { readonly _tag: "allow-under-limits"; readonly limits: LimitConstraints }
  | { readonly _tag: "refuse"; readonly finding: NormFinding };

// The result the Channel consumes. On the inbound attention stream only
// the admit case is emitted; the withhold case carries the finding to the
// agent's response policy off-stream.
export type Screened =
  | { readonly _tag: "admit"; readonly message: InboundMessage }
  | { readonly _tag: "withhold"; readonly finding: NormFinding };
export type Cleared =
  | { readonly _tag: "allow"; readonly action: OutboundSubject }
  | { readonly _tag: "refuse"; readonly finding: NormFinding };

// The enrichment the firewall attaches to an admitted message
// (InboundMessage.context; enrichment is additive and firewall-defined).
// Standing, the fold-computed peer role, any fragments that fired but were
// admitted-under-limits, and the agent-side semantic annotation (never a
// NormFinding). This is the firewall's own FirewallContext realization.
export interface FirewallContext {
  readonly standing: Standing;
  readonly role: Option<RoleName>;
  readonly notes: readonly NormFinding[];     // fired-but-admitted; agent-visible context
  readonly semantic: Option<SemanticAnnotation>;
}

// THE sovereignty guarantee, in one operator. `tightest` keeps the more
// restrictive of two verdicts; there is NO loosening combinator anywhere
// in the module. Composing the three tiers with `tightest` means no
// source can be overridden toward permissiveness: the agent adds
// restriction freely, drops a norm only by un-pinning it, never drops the
// floor. Precedence [floor, norm, agent] is the fold order; it decides
// limit-composition provenance, not who may loosen (no one may).
export const tightestInbound: (a: InboundVerdict, b: InboundVerdict) => InboundVerdict;
export const tightestOutbound: (a: OutboundVerdict, b: OutboundVerdict) => OutboundVerdict;

// Agent-side discretion, OUTSIDE the norm contract. A model or heuristic
// the agent MAY run over admitted content. It yields an agent-local
// annotation, NEVER a NormFinding, and is part of NO digest — so it can
// neither break same-version agreement nor be re-executed as a
// certificate. The endpoint analogue of L6 testimony.
export interface SemanticScreen {
  readonly assess: (message: InboundMessage) => Effect<SemanticAnnotation, never>;
}
export interface SemanticAnnotation {
  readonly concern: SemanticConcern;          // e.g. suspected-deception; agent-local only
  readonly rationale: string;                 // model output; never attributed as norm-provable
}
```

### Sources: `v2/firewall-sources` — the three tiers

```ts
// A tier supplies the rule sets that apply to a crossing. The evaluator
// gathers all three and folds their verdicts with `tightest`.
export interface RuleSetProvider {
  readonly tier: Tier;
  readonly rulesFor: (binding: NormBinding) => Effect<readonly RuleSet[], never>;
}
export type Tier = "floor" | "norm" | "agent";

// The operator's non-negotiable minimum. Cannot be dropped by the agent
// (it sits below the agent tier); a deny-list keyed on institutional
// facts lives here (revocation is the zero policy — the floor refuses a
// sender whose L7 facts show revoked).
export interface DeploymentFloor extends RuleSetProvider {}

// Loads the RuleSet from each pinned bundle the binding cites AND the
// agent pinned. Loading rejects a bundle whose fragments are not in the
// closed vocabulary or reference an unknown fold projection (Errors:
// BundleRejected) — a norm cannot smuggle a non-deterministic rule.
export interface NormSource extends RuleSetProvider {
  readonly load: (digest: BundleDigest) => Effect<RuleSet, BundleRejected>;
}

// The agent's own rules, ALWAYS able to tighten. Contacts standing is one
// input here (an agent-tier rule may refuse a `deny` sender, limit a
// `limit` sender, or apply the default posture) — one trust-data source,
// never a privileged special case. Cedar / OPA / Rego policies, if the
// agent wants them, are a permissible agent-tier backend; they are never
// a NORM backend (a general engine is not deterministic over the fold and
// would fracture same-version agreement).
export interface AgentOverrides extends RuleSetProvider {
  readonly withStanding: (standing: Standing) => readonly RuleFragment[];
}
```

### Findings: `v2/firewall-finding` — the L6 bridge

```ts
// A deterministic classification a fragment produces. The firewall runs
// the fragment live; an L6 monitor runs the SAME fragment over the
// committed ledger and obtains the identical finding (one fragment, two
// runtimes).
export interface NormFinding {
  readonly digest: BundleDigest;              // which bundle's fragment fired
  readonly section: SectionId;                // norm N section S
  readonly subject: FrameRef;                 // conversation + offset of the offending frame
  readonly violation: ViolationKind;
}
export interface FrameRef { readonly conversation: ConversationId; readonly at: Offset }
export type ViolationKind =
  | { readonly _tag: "malformed"; readonly kind: MessageKind }       // shape decode failed
  | { readonly _tag: "out-of-sequence"; readonly kind: MessageKind } // sequence rule false
  | { readonly _tag: "wrong-role"; readonly held: RoleName; readonly kind: MessageKind }
  | { readonly _tag: "over-limit"; readonly kind: MessageKind };

// The certificate any reader re-executes to the identical verdict. It
// pins every input to the computation: the fragment data (bundle digest),
// the interpreter and fold library (both TCB, content-addressed), the
// ledger window, and the L7 fact version (facts are mutable/versioned, so
// a re-execution must read the same version). This is L6.1's `evidence`
// = verify-over-read, specialized to a fired fragment.
export interface RecomputationCertificate {
  readonly finding: NormFinding;
  readonly evaluatorHash: EvaluatorHash;      // the pinned interpreter
  readonly foldLibraryHash: FoldLibraryHash;  // the pinned fold library
  readonly chainRange: ChainRange;            // the committed records the fold read
  readonly factVersion: FactVersion;          // the L7 directory fact-stream position read
}
export const certify: (finding: NormFinding, crossing: InboundCrossing) => Effect<RecomputationCertificate, never>;

// The clause-9 agent-local action taxonomy, DISTINCT from the gate
// verdict. The verdict governs attention (deterministic); the response is
// what the agent chooses to DO (discretion). report-to-L6 and
// seek-reparations carry the certificate — this is the only place a
// finding leaves the endpoint, and it leaves as evidence, by the agent's
// own choice, never as a wire-level verdict (L5.3).
export type Response =
  | { readonly _tag: "disregard" }
  | { readonly _tag: "withdraw" }
  | { readonly _tag: "pursue-otherwise" }
  | { readonly _tag: "report-to-L6"; readonly certificate: RecomputationCertificate }
  | { readonly _tag: "seek-reparations"; readonly certificate: RecomputationCertificate };
```

## Data flow

Two dominant paths. `<<same predicates>>` marks the fragment family that
is shared between the two projections; `[[record intact]]` marks that a
withheld inbound frame stays in the ledger.

Inbound — a peer frame reaching attention:

```
VerifiedFrame(peer P, conv C, kind K)
  + LedgerFold(C)  + FactSnapshot(L7)  + Standing(P from contacts)  + NormBinding
        |
        v
  gather RuleSets by tier
     floor  ── DeploymentFloor.rulesFor(binding)          (operator minimum; L7 deny-list)
     norm   ── NormSource.rulesFor(binding)               (bundles the binding cites AND I pinned)
     agent  ── AgentOverrides.withStanding(Standing(P))   (contacts + my own rules)
        |
        v
  for each pinned bundle B, projection(B).peersObligations(fold, P, at):   <<same predicates>>
        ShapeRule    ── decode P's body vs schema for K      -> malformed?
        SequenceRule ── legalAt(fold, {P, K, at})            -> out-of-sequence?
        RoleRule     ── roleOf(fold, P, at) in allowed?      -> wrong-role?
        LimitRule    ── within bound?                        -> over-limit?
        |  each fired fragment -> NormFinding{digest B, section S, ...}
        v
  per-source InboundVerdict  ── tightestInbound across { floor, norm(s), agent }
        |
        +-- admit -------------------> InboundMessage{ frame, FirewallContext } -> attention
        +-- admit-under-limits ------> InboundMessage + limits/notes -> attention
        +-- withhold(finding) -------> filtered from attention; TranscriptRecord unchanged  [[record intact]]
                                          |
                                          v  (agent response policy — discretion)
                                       certify(finding) -> RecomputationCertificate
                                          |
                                          +-- report-to-L6 / seek-reparations  (agent-local)
```

Outbound — the SAME predicates, subject bound to me:

```
Pending action (send draft kind K | committing tool call)
  + LedgerFold(C)  + FactSnapshot  + NormBinding
        |
        v
  projection(B).myObligations(fold, me, next):     <<same predicates as peersObligations>>
        ShapeRule ── my body encodes to K's schema?
        SequenceRule/RoleRule/LimitRule ── is K a legal move for ME now?
        |
        v
  per-source OutboundVerdict ── tightestOutbound across { floor, norm(s), agent }
        |
        +-- allow --------------> compile: begin / update / commit through Channel   (adds no port)
        +-- allow-under-limits -> compile under limits
        +-- refuse(finding) ----> refused at the INTENT, before compilation begins (L5.6)
                                    (agent-local; no in-flight round stranded; nothing on the wire)
```

The closure the two diagrams share: `peersObligations(fold, P)` and
`myObligations(fold, P)` are the same fragments with the subject swapped.
Under a shared pin and the one total order, my requirement of P equals
P's own outbound gate — so if P's firewall let an action out, mine
classifies it conforming; if P bypassed its gate, mine classifies it
violating, and the finding re-executes to a certificate. The firewall's
inbound check and an L6 monitor's post-facto check are the *same
fragment* over the *same fold*.

Read-only tool calls (projection queries) cross outbound too, but they
commit nothing, so no legal-move gate applies; they may still be limited
(rate). Tool results cross inbound as untrusted content; a bundle's own
`ShapeRule` over its tool outputs is the tool-poisoning defense
(firewall-two-directions).

## Errors

Refusals are values; the hooks' error channel is `never`. A firewall
never throws outward — it fails closed to a refusing verdict (`withhold`
inbound, `refuse` outbound). Every fragment is total: a `ShapeRule`
decode either yields a value or a structural `NormFinding` (a value); a
`SequenceRule` / `RoleRule` / `LimitRule` returns a boolean or a finding,
never throws. This is fail-closed by construction, not by a caught
exception.

The one typed error channel is **bundle load**, where a norm's fragments
are admitted into the evaluator. This is the boundary that keeps the
determinism envelope: a bundle whose fragments are not expressible in the
closed vocabulary, or reference a fold projection not in the pinned
library, is rejected here and never binds.

```ts
export type BundleRejected =
  | { readonly _tag: "unknown-projection"; readonly section: SectionId; readonly name: ProjectionName }
  | { readonly _tag: "unknown-fragment"; readonly section: SectionId }   // outside the four-kind vocabulary
  | { readonly _tag: "schema-invalid"; readonly section: SectionId };    // a ShapeRule body schema won't compile
```

Determinism is **structural, not policed at runtime**: the vocabulary
ships no clock, no random source, no network, no model primitive, so a
fragment *cannot* express non-determinism — there is nothing to detect at
evaluation time. `BundleRejected` only guards the two ways a
syntactically-valid fragment could still fail to be a pure fold read
(an unknown projection, an uncompilable schema). Consequently every
admitted fragment is a pinned deterministic program in the monitors'
sense, and every finding it produces is L6-recomputable.

Handlers over `InboundVerdict`, `OutboundVerdict`, `RuleFragment`,
`ViolationKind`, `Tier`, and `BundleRejected` end in an `absurd(_: never)`
default, so widening any union (a fifth fragment kind, a new violation
class) is a compile error at every site until handled.

## Dependencies

| Library | Version | License | Why this one |
|---|---|---|---|
| `effect` | pin the `v2/*` workspace `effect` (candidate `^3.12`) | MIT | Mandated substrate (constitution constraint). `Schema` is the `ShapeRule` body type and the fragment-data decoder; `Brand` gives the firewall nouns; `Context` binds the sources at the endpoint root. No separate `@effect/schema` in 3.x. |
| pinned fold library | in-tree (`v2` derivations; content-addressed) | in-repo | `applyEntry` / `membersAt` and norm-declared projections are the ONLY way a fragment reads committed state (`layer-interfaces.md` → Derivations, trusted computing base). Imported by reference; its hash is a field of every certificate. Not an external dep. |

No general policy engine (Cedar, OPA/Rego) is a dependency of the norm
path: a norm's fragments must be deterministic *over the fold*, which a
general engine does not model, and a norm authored against a general
engine would fracture same-version agreement across endpoints running
different engine versions. Such engines are a permissible **agent-tier**
backend only (the agent's own overrides), behind `AgentOverrides`, never
in a `RuleSet` a bundle ships. Semantic screening's model runtime lives
behind `SemanticScreen` and is the agent's own choice, in no signature
here.

## Traceability

Spec obligation → the interface that carries it. Laws are
`layer-interfaces.md` § Laws.

| Spec (doc → obligation) | Carried by |
|---|---|
| L5.1 (hooks hold no signing authority; frame + attribution pass unaltered) | `Firewall.inbound`/`outbound` return verdict values; no `Signer` in their requirements; the compile step signs *after* clearing the outbound hook |
| L5.2 (withheld inbound stays out of attention, `read` unchanged) | `InboundVerdict` `withhold` filters the attention stream; the `TranscriptRecord` is never touched (`[[record intact]]`) |
| L5.3 (verdicts agent-local; no interface emits one outward) | `Screened`/`Cleared` are endpoint-local values; a finding leaves only as a `Response` `report-to-L6`/`seek-reparations` the agent chooses, as evidence, never a wire verdict |
| L5.4 (trust-data change is a local act, immediate, zero network) | `AgentOverrides.withStanding` reads contacts `Standing` live; a contact edit changes the next crossing's agent-tier rules with no network step |
| L5.5 (no router-side interface accepts/stores/serves L5 data) | every module is endpoint-composition-local; no port, no router surface (`layer-interfaces.md` → Not ports) |
| L5.6 (illegal committing action refused before compilation; no round stranded) | `outbound` runs `myObligations` on the pending action; `refuse` fires at the intent, before `begin`/`update`/`commit` |
| L4.1 (norms enter only as firewall/turn config; same-version = same digest) | `RuleSet.digest` is the bundle's; `NormSource` loads fragments from the pinned bundle; agreeing on the pin IS agreeing on the gates |
| L6.1 (`evidence` = verify-over-read; findings re-execute) | `certify` produces a `RecomputationCertificate` pinning digest + evaluator + fold-library + chain range + fact version; one fragment, two runtimes |
| screening.md § gate model (programmed from above; inbound structural + semantic; outbound send-when-expected) | norm `RuleSet` programs the gates from above; `Shape`/`Sequence`/`Role` are structural, `SemanticScreen` is the agent-side semantic screen; `myObligations` is send-when-expected |
| screening.md inv. 4 (gate rules are the agent's own, consuming L4 norms + contacts) | the three-tier fold: norm fragments + `AgentOverrides` (contacts one input) + floor, composed by `tightest` |
| screening.md OQ1 (shared, skill-distributable firewall vocabulary) | `v2/firewall-vocab`: the four fragment kinds, shipped as bundle data |
| screening.md OQ2 (violation-response taxonomy; what a report carries) | `Response` (the five, closed by default); a report carries the `RecomputationCertificate` |
| contacts.md inv. 2 (gate = f(frame, attribution, norms, own contacts)) | `InboundCrossing` carries exactly these; `standing` is one field beside `fold`, `facts`, `binding` |
| contacts.md § standing (allow/deny/limit/default posture) | `AgentOverrides.withStanding` maps `Standing` to agent-tier fragments; not privileged over norm/floor |
| tasks.md inv. 2 (a norm binds only same-pin participants) | a fragment applies to peer P only via a digest `NormBinding.pinned` cites; a non-pinning peer produces provable violations, no network check |
| tasks.md inv. 4 (affordance is never the enforcement boundary) | enforcement is the `outbound` hook over `myObligations`, independent of the model-visible tool surface |
| VISION clause 8 (same-version agreement is the only global invariant; bundle is what L5 checks against) | `RuleSet.digest` = the bundle pin; the closure (`peersObligations` = the peer's `myObligations`) holds exactly under a shared digest |
| VISION clause 9 (rules key off communication guarantees + institutional facts L7 records at L1) | fragments read the `fold` (identity, kinds, task state) and `FactSnapshot` (L7 facts); the floor's deny-list keys on revocation (the zero policy) |
| `20260724-firewall-two-directions.md` (two directions; everything crosses; tool traffic included) | `InboundSubject`/`OutboundSubject` cover peer frames, tool results, sends, tool calls; two hooks, no per-counterparty slot |
| `20260724-monitors-are-deterministic-contracts.md` (pinned deterministic program; finding = recomputation) | the closed, total vocabulary + `RecomputationCertificate`; the firewall runs the monitor's own fragment live |
| `20260724-l7-is-policy-attached-to-identity.md` (facts answer what an identity may do; endpoints enforce) | `FactSnapshot` is a read-only ambient input; the finding pins `factVersion`; the floor/norm/agent tiers each enforce their own slice |
| `20260724-norms-are-mcp-skill-bundles.md` (committing tools compile to txns; legal moves from ledger state) | `myObligations` over the fold is the legal-move set; the outbound hook gates the compile step, adding no port |

## Open questions

Each carries a recommended default (the dispatched-mode pick) and an
escalation target.

1. **Fragment form: declarative data + pinned evaluator, or sandboxed
   executable code.** Default: declarative data in the closed
   four-kind vocabulary, interpreted by the endpoint's pinned evaluator
   (TCB). Data makes digest-pinning automatic and L6-recomputation
   trivial, and makes determinism structural (the vocabulary ships no
   non-deterministic primitive) rather than sandbox-policed. Escalation:
   `screening.md` + a decision record.
2. **Is the four-kind vocabulary (shape, sequence, role, limit)
   complete for the two case studies.** Default: yes — arena's turn
   order and role vocabulary are sequence + role, its channel secrecy is
   a scope limit + a shape rule over readable kinds; the bench's
   tolerance of faulty counterparties is expressed as inbound findings
   the agent's response policy disregards. A fifth kind is a
   vocabulary-version change (a new `RuleFragment` arm, breaking every
   exhaustive match until handled). Escalation: `screening.md` acceptance
   against the case-study audits.
3. **Multi-norm composition in one conversation** (tasks.md OQ5).
   Default: all pinned bundles' fragments apply; verdicts compose by
   `tightest` (fail-closed — if any pinned norm forbids a kind, it is
   forbidden). Which norm's `myObligations` display wins for the
   *informative* legal-move view is agent discretion, not a firewall
   decision. Escalation: tasks.md OQ5 / charter #765.
4. **Where the binding's digest citation rides** — conversation-start
   entry vs a standing relationship (tasks.md OQ3, inherited). Default:
   the conversation-start entry carries `NormBinding.pinned`;
   standing-relationship pinning is future. The firewall consumes
   `NormBinding` either way. Escalation: tasks.md OQ3.
5. **Fact-snapshot pinning for L6 re-execution.** L7 facts are mutable
   and versioned; a certificate must cite the fact version so a monitor
   re-reads the same one. Default: the finding cites the directory's
   fact-stream position (`factVersion`); re-execution reads that
   position. This ties firewall provability to the L7 fact-propagation
   question. Escalation: L7 fact-vocabulary chapter + VISION register
   item 5.
6. **Contacts tier placement.** Default: contacts feeds both the floor
   (operator deny-lists) and the agent tier (the agent's own
   allow/limit and default posture), as an ordinary `RuleSetProvider`
   input — never a privileged special case. Escalation: none;
   `endpoints/contacts.md` remains the stopgap data source.
7. **Are the gate-verdict sets closed** at inbound `\{admit,
   admit-under-limits, withhold\}` and outbound `\{allow,
   allow-under-limits, refuse\}`. Default: yes; the five clause-9
   responses are a separate agent-*action* taxonomy (`Response`), not
   gate verdicts. Escalation: `screening.md` OQ2.
8. **Semantic screening stays outside the norm contract.** Default:
   recorded as load-bearing, not open — a norm fragment cannot require a
   model judgment, because a model verdict depends on which model/version
   an endpoint runs, so two endpoints with the identical digest could
   disagree on conformance (same-version agreement, the one global
   invariant, would be violated by construction) and an L6 monitor could
   not re-execute the fragment to an identical verdict (it would be
   testimony, not certificate). Model judgment is therefore necessarily
   agent-side (`SemanticScreen`), non-provable, the endpoint analogue of
   L6 testimony. Escalation: none; this is the argument the determinism
   envelope rests on.

## References

- `docs/spec/endpoints/screening.md` — the gate model, invariants 1–5,
  and open questions 1–4 this proposal fills.
- `docs/spec/endpoints/contacts.md` — the v0 stopgap, here one
  `RuleSetProvider` input, not the design.
- `docs/spec/layer-interfaces.md` — the two hooks, laws L5.1–L5.6, the
  `Channel`/`Txn`/`InboundMessage`/`FirewallContext` surface the hooks
  mount on, and the everyday-vocabulary rule; the firewall as Not-a-port.
- `docs/spec/endpoints/tasks.md` — norms as digest-pinned MCP skill
  bundles; norms as guarantees published upward; legal moves from ledger
  state.
- `v2/VISION.md` — constitution clauses 1, 8, 9.
- `docs/architecture/layers.md` — L5 in the layer model; guarantees flow
  up, configuration flows down.
- `docs/decisions/20260724-{firewall-two-directions,norms-are-mcp-skill-bundles,l7-is-policy-attached-to-identity,monitors-are-deterministic-contracts,collectives-are-ledger-transactions}.md`
  — the layer models this interior realizes.
- Sibling firewall-plan proposals under
  `v2/drafts/firewall-plan-proposals/` — alternative interiors for the
  same open question.
