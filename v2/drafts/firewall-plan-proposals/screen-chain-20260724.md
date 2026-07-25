# Firewall plan, Proposal: the firewall is a screen chain

Status: DRAFT (alternative for the undesigned firewall plan —
`docs/spec/endpoints/screening.md` open question 2;
`docs/spec/layer-interfaces.md` open question 2)

Spec basis: `docs/spec/endpoints/screening.md` (gate model, five
violation responses, invariant 5 pre-compilation refusal);
`docs/spec/endpoints/contacts.md` (the v0 contacts stopgap, one trust
source); `docs/spec/layer-interfaces.md` (two directional hooks, laws
L5.1-L5.6, `InboundMessage { frame, context }`, the port test);
`docs/spec/endpoints/tasks.md`; `v2/VISION.md` clauses 1, 8, 9;
`docs/decisions/20260724-{firewall-two-directions,norms-are-mcp-skill-bundles,l7-is-policy-attached-to-identity,monitors-are-deterministic-contracts,collectives-are-ledger-transactions}.md`;
`docs/architecture/layers.md`.

## Summary

The firewall's interior is **one ordered chain of small screens per
direction**, the netfilter/middleware shape. A **screen** is a focused
function `(crossing, context) -> verdict`: it reads what crosses the
boundary plus exactly the context it declared it needs, and returns
one of three verdicts. The chain runs its screens in order and folds
their verdicts under a single composition law — **most-restrictive-wins**
(the meet of a three-point verdict lattice: `Admit` > `AdmitUnderLimits`
> `Withhold`). Nothing else about the firewall is a new port; the
chain is the opaque interior of the `withFirewall(rules)` decorator the
layer-interface contract already names (`layer-interfaces.md` -> Effect
realization), with `rules` = the assembled `FirewallPlan`.

The composition law does the structural work. Because meet is
commutative, associative, and has `Withhold` as an absorbing bottom:

- **Order is a cost decision, never a correctness one.** Any ordering
  of the same screens yields the same verdict. Ordering only decides
  which context resolvers get forced and which enrichments accumulate
  before a short-circuit. So the assembler is free to run cheap
  deterministic screens first and the expensive model screen last, and
  the semantic screen sees only crossings the cheap prefix admitted.
- **Fail-closed is not special handling.** A screen that throws, times
  out, or exceeds its bound contributes `Withhold`. Bottom absorbs, so
  a failed screen withholds the crossing by construction.
- **Agent sovereignty needs no ordering rule.** Adding a screen of any
  provenance can only tighten (meet with one more term is `<=` the
  original). A hostile norm-shipped screen can withhold too much — a
  self-inflicted denial of the agent's own attention — but can never
  admit what another screen withheld. The agent's own trust screen's
  `Withhold` wins regardless of where a norm screen sits.

Five kinds of screen coexist in the one chain, distinguished by three
pieces of declared metadata, never by a bespoke interface: **cost tier**
(structural < trust < rate < norm < semantic — sets the default order),
**provenance** (built-in, norm-shipped, agent-authored — sets which
context a screen may reach and the same-pin binding), and **determinism**
(deterministic vs testimony — the monitors two-layer split applied inside
the firewall: deterministic screens' verdicts form a re-executable
**certificate**; the semantic screen's verdict is **attributed testimony**).
The chain's output is `FirewallContext` = the provenance-stamped
enrichment accumulated by the screens that ran, which is exactly the
`context` field `InboundMessage` already carries to the runtime.

What this proposal deliberately does **not** invent: any wire surface
(no verdict, screen, or trust datum leaves the endpoint), any router
role (the router enforces none of it), any new signing authority (the
chain holds no `Signer`), and any privileged status for contacts
(`standing` is one context need among institutional facts, the norm
fold, and the transcript). Contacts stay one trust source behind the
trust screen (`contacts.md`).

## Modules

Five conceptual modules, **tree-shaped**: `compose` is the composition
root; `chain`, `screen`, `context`, and `verdict` are its bounded
peers, and none of the four peers imports another except along the
one-directional stack `chain -> screen -> {verdict, context}` and
`context -> verdict`. Package layout is a realization choice; a module
may be one file or share a package with its neighbor.

1. **`verdict`** — the composition algebra. The three-point verdict
   lattice (`Admit | AdmitUnderLimits | Withhold`), the `meet`
   (most-restrictive-wins) operator, and the certificate/testimony
   decomposition (`CertificateVerdict`, `Testimony`). Pure; no I/O.
   The whole composition law lives here as checkable properties.
   Public surface: `Verdict`, `meet`, `CertificateVerdict`, `Testimony`,
   `Decision`. Depends on: `wire` (for `Limit`), `effect`.

2. **`screen`** — the stage interface. `Screen<C, N>`: a focused
   function over a crossing `C` and a needs-scoped context `N`, plus
   the declared metadata (`id`, `provenance`, `determinism`, `cost`,
   `needs`) that lets the chain order, scope, and audit it. The
   `Crossing` sum (inbound message / inbound tool result / outbound
   send / outbound tool call). This is the proposal's core contribution:
   the one interface every screen implements regardless of provenance.
   Public surface: `Screen`, `Crossing`, `InboundCrossing`,
   `OutboundCrossing`, `Provenance`, `Determinism`, `CostTier`,
   `ScreenError`. Depends on: `verdict`, `context`, `wire`, `effect`.

3. **`context`** — lazy context provision and least-authority scoping.
   The `Need` token set (`standing`, `facts`, `fold`, `norm-text`,
   `transcript`, `classifier`), the `Resolvers` record the endpoint
   composition supplies (each memoized and forced on first read), the
   `ScopedContext<N>` projection that hands a screen only the resolvers
   it declared, and the `FirewallContext` enrichment the chain
   accumulates and stamps with provenance. Boundary validation of every
   external input (contacts store, ledger fold, registry facts, model
   judge) lives at these resolvers. Public surface: `Need`, `Resolvers`,
   `ScopedContext`, `ContextProvider`, `FirewallContext`, `Annotation`,
   `Standing`, `InstitutionalFacts`, `LegalMoves`, `NormText`, `Judge`.
   Depends on: `verdict`, `wire`, `effect`.

4. **`chain`** — the runner. One ordered list of screens per direction;
   folds their verdicts under `meet` with short-circuit at `Withhold`;
   forces each screen's declared resolvers lazily; absorbs any screen
   failure into `Withhold` (fail-closed); accumulates enrichment;
   splits the certificate from the testimony. This is the netfilter
   engine, and `Firewall.inbound` / `Firewall.outbound` are exactly
   what the two directional hooks call. Public surface: `Chain`,
   `FirewallPlan`, `Firewall`, `StageOutcome`. Depends on: `screen`,
   `context`, `verdict`, `effect`.

5. **`compose`** — assembly, provenance, and placement. Builds the
   built-in screens, loads norm-shipped screens from the pinned MCP
   bundle under the same-pin binding, registers the agent's own
   screens, and orders them by the placement law (structural gate
   front, cost ascending, provenance containment). Produces the
   `FirewallPlan` the `withFirewall` decorator holds. The composition
   root; nothing depends on it. Public surface: `assemble`,
   `builtInScreens`, `loadNormScreens`, `FirewallPlan` (re-exported),
   `NormPin`, `PlacementError`. Depends on: `chain`, `screen`,
   `context`, `effect`.

Design-pattern names for the reader: `screen` is **Strategy** (one
interface, many interchangeable focused implementations); `chain` is
**Chain of Responsibility** with a lattice fold instead of first-match;
`context` is a lazily-resolved **Facade** over the endpoint's ports so
no screen names a port; `compose` is the **composition root**.

## Interfaces

TypeScript, Effect as the substrate. Error channels are typed; success
carries the guarantee. No function bodies (architecture). `Effect<A, E>`
elides the `R` channel; requirements are stated per module above.

### The composition algebra (`verdict`)

```ts
import type { Brand } from "effect/Brand";
import type { Effect } from "effect/Effect";
import type { Option } from "effect/Option";

/** Endpoint-defined, opaque constraint under which a crossing is admitted
 *  (contacts.md rec. 6: the limit vocabulary stays endpoint-local). */
export type Limit = string & Brand.Brand<"Limit">;
export type Limits = ReadonlySet<Limit>;

/**
 * The three-point verdict lattice, from most permissive (top) to most
 * restrictive (bottom):
 *   Admit  >  AdmitUnderLimits(S)  >  Withhold
 * `AdmitUnderLimits` with an empty set normalizes to `Admit`. Withhold is
 * the absorbing bottom. Inbound reads Withhold as "kept out of attention,
 * still in the record"; outbound reads it as "does not ship / does not
 * compile". One algebra, two readings.
 */
export type Verdict =
  | { readonly _tag: "Admit" }
  | { readonly _tag: "AdmitUnderLimits"; readonly limits: Limits }
  | { readonly _tag: "Withhold"; readonly reason: Reason };

/** Why a screen withheld or limited. Agent-local only (L5.3); never on the wire. */
export type Reason = string & Brand.Brand<"Reason">;

/**
 * Most-restrictive-wins (the meet of the lattice). Commutative,
 * associative, idempotent; `Admit` is the identity, `Withhold` is
 * absorbing; two `AdmitUnderLimits` meet to the union of their limits.
 * This single operator is the whole composition law (verdict property CL1).
 */
export declare const meet: (a: Verdict, b: Verdict) => Verdict;

/** The re-executable part: the meet of the deterministic screens only.
 *  Any party holding the cited inputs recomputes it bit-identically
 *  (monitors decision -> certificate layer). */
export interface CertificateVerdict {
  readonly verdict: Verdict;
  readonly screens: readonly ScreenId[];       // the deterministic screens that contributed
}

/** The semantic screen's attributed judgment (monitors decision -> testimony
 *  layer). Trusted by attribution, not re-execution; never presented as part
 *  of the certificate. */
export interface Testimony {
  readonly judge: JudgeId;
  readonly judgeVersion: string;
  readonly inputs: InputDigest;                // digest of the crossing + context the judge saw
  readonly verdict: Verdict;
  readonly signature: Signature;
}

/** The chain's full result for one crossing. `verdict` is the meet of
 *  `certificate.verdict` and (if it ran) `testimony.verdict`. */
export interface Decision {
  readonly verdict: Verdict;
  readonly certificate: CertificateVerdict;
  readonly testimony: Option<Testimony>;
  readonly context: FirewallContext;           // accumulated enrichment (context module)
  readonly trace: readonly StageOutcome[];      // per-screen audit, agent-local
}

export type ScreenId = string & Brand.Brand<"ScreenId">;       // content hash of the screen's definition
export type JudgeId = string & Brand.Brand<"JudgeId">;
export type InputDigest = string & Brand.Brand<"InputDigest">;
export type Signature = Uint8Array & Brand.Brand<"Signature">;
```

### The screen (`screen`)

```ts
import type { VerifiedFrame, ConversationId, Body } from "../wire";

/** What crosses the boundary. Two directions, each with the two crossing
 *  kinds firewall-two-directions names. A screen handles the crossing type
 *  it is typed over and nothing else. */
export type Crossing = InboundCrossing | OutboundCrossing;

export type InboundCrossing =
  | { readonly _tag: "Message"; readonly frame: VerifiedFrame }             // a delivered peer frame, attribution verified
  | { readonly _tag: "ToolResult"; readonly call: ToolRef; readonly result: Body }; // a norm-bundle output (untrusted inbound content)

export type OutboundCrossing =
  | { readonly _tag: "Send"; readonly conversation: ConversationId; readonly body: Body } // a plain send before it ships
  | { readonly _tag: "ToolCall"; readonly tool: ToolRef; readonly args: Body };           // a tool call before it compiles (L5.6 lands here)

export type ToolRef = string & Brand.Brand<"ToolRef">;                     // norm://<bundle-digest>#<tool>

/** Where a screen came from. Same interface, different trust and reach. */
export type Provenance =
  | { readonly _tag: "BuiltIn" }                                           // the harness ships it (trusted computing base)
  | { readonly _tag: "NormShipped"; readonly pin: NormPin }                // from the pinned L4 bundle; binds only same-pin peers (PL4)
  | { readonly _tag: "AgentAuthored" };                                    // the agent's own rule

/** Deterministic screens are re-executable (certificate); the semantic
 *  screen is attributed testimony. The one bit that routes a screen's
 *  verdict into the two-layer split (CL6). */
export type Determinism =
  | { readonly _tag: "Deterministic" }
  | { readonly _tag: "Testimony"; readonly judge: JudgeId };

/** Ascending expected cost. Sets the default assembly order (PL2). */
export type CostTier = "structural" | "trust" | "rate" | "norm" | "semantic";

export type NormPin = string & Brand.Brand<"NormPin">;                     // the bundle digest both binding participants cite

/**
 * The one interface every screen implements. `N` is the set of context
 * needs the screen declares; `ScopedContext<N>` (context module) hands it
 * exactly those resolvers and no others, so a screen cannot reach context
 * it did not declare (least authority by construction — types beat tests).
 */
export interface Screen<C extends Crossing, N extends Need = Need> {
  readonly id: ScreenId;                       // content hash — its re-execution identity
  readonly provenance: Provenance;
  readonly determinism: Determinism;
  readonly cost: CostTier;
  readonly needs: ReadonlySet<N>;              // declared; the chain forces only these, lazily
  readonly handles: (crossing: C) => boolean;  // which crossing arms this screen applies to
  readonly screen: (crossing: C, ctx: ScopedContext<N>) => Effect<Verdict, ScreenError>;
}

/** A screen's own typed failure. The runner maps any ScreenError, and any
 *  timeout/bound overrun, to `Withhold` (fail-closed, CL4). Screen authors
 *  return typed errors; the chain absorbs them. */
export type ScreenError =
  | { readonly _tag: "Malformed"; readonly detail: string }   // structural screen: crossing fails its schema
  | { readonly _tag: "ContextUnavailable"; readonly need: Need } // a declared resolver refused
  | { readonly _tag: "JudgeUnavailable" }                     // semantic screen: the model did not answer
  | { readonly _tag: "Timeout" };
```

### Lazy context and least-authority scoping (`context`)

```ts
import type { AgentId, TranscriptRecord } from "../wire";

/** The context vocabulary. Every screen declares a subset; the provider
 *  resolves each lazily and at most once per crossing. Everyday tokens,
 *  not a schema: what a screen might need to see. */
export type Need =
  | "standing"      // the sender's contact-data standing (contacts.md) — one trust source, not privileged
  | "facts"         // institutional facts L7 records at L1 for the sender (l7-is-policy decision)
  | "fold"          // legal-move projection over committed ledger at the pinned norm (norms-as-bundles)
  | "norm-text"     // the pinned bundle's schemas and prose for this binding
  | "transcript"    // a bounded window of prior committed records (semantic context)
  | "classifier";   // the model judge (semantic screens only)

/** What the endpoint composition supplies. Each field is a resolver the
 *  provider memoizes; forcing it is where boundary validation of the
 *  external input happens (contacts store, ledger read, registry lookup,
 *  model client). Screens never hold these directly. */
export interface Resolvers {
  readonly standing: Effect<Standing, ContextRefused>;
  readonly facts: Effect<InstitutionalFacts, ContextRefused>;
  readonly fold: Effect<LegalMoves, ContextRefused>;
  readonly "norm-text": Effect<NormText, ContextRefused>;
  readonly transcript: Effect<readonly TranscriptRecord[], ContextRefused>;
  readonly classifier: Judge;
}

/** A screen declaring needs `N` receives exactly those resolvers. Reaching
 *  for an undeclared need is a compile error, not a runtime check. */
export type ScopedContext<N extends Need> = Pick<Resolvers, N>;

/** Builds a per-crossing resolver record; memoizes so an expensive
 *  resolver (fold, classifier) is forced at most once, and only if a
 *  non-short-circuited screen declares it (laziness law CL3). Provided by
 *  the EndpointComposition, which alone holds the ports behind these. */
export interface ContextProvider {
  readonly forInbound: (crossing: InboundCrossing) => Resolvers;
  readonly forOutbound: (crossing: OutboundCrossing) => Resolvers;
}

/** Contact standing: the v0 contacts stopgap, consumed as data (contacts.md). */
export type Standing =
  | { readonly _tag: "Allow" }
  | { readonly _tag: "Deny" }
  | { readonly _tag: "Limit"; readonly limits: Limits }
  | { readonly _tag: "Unknown" };              // no record; the endpoint's default posture applies

/** Institutional facts served beside the card at lookup (l7 decision).
 *  v0's fact set is the single active bit; the vocabulary grows without a
 *  new need token. */
export interface InstitutionalFacts {
  readonly active: boolean;
  readonly facts: ReadonlyMap<string, string>; // versioned, attributed to the institution; opaque here
}

/** The legal-move set: a pure fold over committed ledger state at the
 *  pinned norm (norms-as-bundles). Deterministic; globally re-executable. */
export interface LegalMoves {
  readonly legal: (crossing: Crossing) => boolean;
  readonly foldHash: string;                   // pinned fold-library hash (monitors: trusted computing base)
}

export interface NormText {
  readonly pin: NormPin;
  readonly schemas: ReadonlyMap<string, Schema>;
  readonly prose: string;
}
export type Schema = unknown & Brand.Brand<"Schema">;   // a decode schema for a norm message shape; opaque here

/** The semantic judge. The one non-deterministic resolver; its output is
 *  testimony, never certificate. */
export interface Judge {
  readonly judge: (input: JudgeInput) => Effect<Testimony, JudgeUnavailable>;
}
export interface JudgeInput {
  readonly crossing: Crossing;
  readonly transcript: readonly TranscriptRecord[];
  readonly norm: Option<NormText>;
}

export type ContextRefused = { readonly _tag: "ContextRefused"; readonly need: Need };
export type JudgeUnavailable = { readonly _tag: "JudgeUnavailable" };

/** The chain's enrichment output. Each annotation is stamped with the
 *  screen that produced it and its provenance, so a downstream screen or
 *  the runtime can decide whether to trust a norm-shipped annotation.
 *  This IS the `context` field of `InboundMessage` (layer-interfaces). */
export interface FirewallContext {
  readonly annotations: readonly Annotation[];
}
export interface Annotation {
  readonly source: ScreenId;
  readonly provenance: Provenance;
  readonly key: string;                        // "standing" | "role" | "legal-move" | "classification" | ...
  readonly value: string;                      // opaque annotation payload
}
```

### The runner and the two hooks (`chain`)

```ts
/** One ordered chain of screens for one direction. Order is set by the
 *  assembler (placement law); by CL1 it does not change the verdict. */
export interface Chain<C extends Crossing> {
  readonly screens: readonly Screen<C, Need>[];
}

/** Both directions. The opaque value the `withFirewall(plan)` decorator
 *  holds (layer-interfaces -> Effect realization; open question 2's
 *  "rules value is firewall-plan territory"). */
export interface FirewallPlan {
  readonly inbound: Chain<InboundCrossing>;
  readonly outbound: Chain<OutboundCrossing>;
}

/** What the two directional hooks call. The `never` error channel is the
 *  point: the firewall always returns a Decision (possibly Withhold), never
 *  throws at its caller — refusals are values. Fail-closed lives inside. */
export interface Firewall {
  readonly inbound: (crossing: InboundCrossing) => Effect<Decision, never>;
  readonly outbound: (crossing: OutboundCrossing) => Effect<Decision, never>;
}

/** Builds a Firewall from a plan and the endpoint's context provider. The
 *  runner: filter by `handles`; fold verdicts under `meet`; stop at the
 *  first Withhold (CL3); force each screen's declared resolvers lazily;
 *  wrap each screen in a bound and map failure/timeout to Withhold (CL4);
 *  stamp and accumulate enrichment; split certificate from testimony (CL6). */
export declare const firewall: (plan: FirewallPlan, ctx: ContextProvider) => Firewall;

/** Per-screen audit record; agent-local, never emitted (L5.3). */
export interface StageOutcome {
  readonly screen: ScreenId;
  readonly provenance: Provenance;
  readonly determinism: Determinism;
  readonly verdict: Verdict;
  readonly forced: ReadonlySet<Need>;          // which resolvers this screen actually caused to compute
}
```

### Assembly, provenance, placement (`compose`)

```ts
/** The pieces that assemble into a plan. Built-ins and agent-authored
 *  screens are always present; norm-shipped screens enter per binding. */
export interface ChainParts {
  readonly builtIn: readonly Screen<Crossing, Need>[];
  readonly agentAuthored: readonly Screen<Crossing, Need>[];
  readonly normShipped: readonly Screen<Crossing, Need>[];
}

/**
 * Orders parts into a plan by the placement law:
 *   PL1 structural built-in gate pinned to the front;
 *   PL2 cost ascending (structural < trust < rate < norm < semantic);
 *   PL3 provenance containment — reject a NormShipped screen that declares
 *       `standing` or `facts` (the agent's private trust data);
 *   PL4 keep a NormShipped screen only for crossings whose binding cites
 *       its pin (same-pin binding).
 * PL2's order is a default; an agent may reorder within a direction (CL2
 * makes it verdict-safe) but not move the structural gate off the front.
 */
export declare const assemble: (parts: ChainParts) => Effect<FirewallPlan, PlacementError>;

/** The harness's own screens: structural schema/version/entry-type gate,
 *  a rate/volume screen, and the outbound send-when-expected screen.
 *  Trusted computing base; content-hashed. */
export declare const builtInScreens: (config: BuiltInConfig) => readonly Screen<Crossing, Need>[];

/** Loads the norm's screens from its pinned MCP bundle (norms-as-bundles):
 *  the structural schema screens and the legal-move screen (the L5.6
 *  outbound refusal). Each is stamped NormShipped with the bundle's pin.
 *  A digest mismatch or an over-reaching need declaration fails here, not
 *  in the chain. */
export declare const loadNormScreens: (pins: readonly NormPin[]) => Effect<readonly Screen<Crossing, Need>[], LoadError>;

export interface BuiltInConfig {
  readonly defaultPosture: "open" | "closed";  // contacts.md: the endpoint's posture toward unrecorded identities
  readonly rateWindow: RateWindow;
}
export type RateWindow = { readonly per: "minute" | "hour"; readonly max: number };

export type PlacementError =
  | { readonly _tag: "NormReachesPrivateTrust"; readonly screen: ScreenId; readonly need: Need } // PL3 violation
  | { readonly _tag: "NoStructuralGate" };                                                       // PL1 violation
export type LoadError =
  | { readonly _tag: "PinMismatch"; readonly pin: NormPin }
  | { readonly _tag: "BundleUnavailable"; readonly pin: NormPin };
```

## Data flow

Two chains, one runner. Every arrow is a screen call or a lazy resolver
force. `X` marks a short-circuit (first `Withhold` stops the fold; no
later screen runs, its resolvers stay unforced).

### Inbound: a delivered frame reaching attention

```
delivered frame ── verify (L1, upstream) ──► InboundCrossing{Message, VerifiedFrame}
                                                     │
                                                     ▼
  running meet := Admit ;  FirewallContext := {}
                                                     │
  ┌── screen 1  structural  (built-in, deterministic, needs {})            cost: structural
  │      schema / version / entry-type over the frame bytes
  │      ├─ Malformed / bad version  ──► Withhold  ──X  (record unchanged; L5.2)
  │      └─ ok ──► Admit ;  annotate {schema, entryType}
  │
  ├── screen 2  trust       (agent-authored, deterministic, needs {standing, facts})  cost: trust
  │      force standing (contacts), force facts (L7 at L1)   ── one lookup each, memoized
  │      ├─ Deny / inactive ──► Withhold  ──X
  │      ├─ Limit(S)        ──► AdmitUnderLimits(S) ;  annotate {standing: limited}
  │      └─ Allow / Unknown+open ──► Admit ;  annotate {standing}
  │
  ├── screen 3  norm        (norm-shipped, deterministic, needs {fold, norm-text})    cost: norm
  │      force fold (legal-move projection over committed ledger at the pin)
  │      ├─ not a legal inbound move under the pinned norm ──► Withhold ──X
  │      └─ legal ──► Admit ;  annotate {legal-move, role}          [same-pin only, PL4]
  │
  └── screen 4  semantic    (agent-authored, TESTIMONY, needs {transcript, classifier})  cost: semantic
         force classifier over the frame + transcript window
         ├─ judge unavailable / timeout ──► Withhold  (fail-closed, CL4)
         ├─ suspected injection / deception ──► Withhold ;  emit Testimony
         └─ benign ──► Admit ;  emit Testimony {judge, version, inputs, signature}
                                                     │
                                                     ▼
   Decision{ verdict = meet(screens 1..4),                       (most-restrictive-wins, CL1)
             certificate = meet(screens 1..3),                   (deterministic → re-executable, CL6)
             testimony   = screen 4's Testimony (if it ran),     (attributed, not re-executable)
             context     = accumulated annotations,              (= InboundMessage.context)
             trace       = per-screen outcomes }                 (agent-local; never on the wire, L5.3)
                                                     │
                        Admit / AdmitUnderLimits ────┴──► runtime attention (Channel.inbound)
                        Withhold ───────────────────────► kept out of attention; read() still returns it (L5.2)
```

### Outbound: a send / a committing tool call before it ships or compiles

```
runtime intent ──► OutboundCrossing{Send | ToolCall}
                          │
                          ▼
  ┌── screen 1  structural  (built-in)     well-formed body / args
  ├── screen 2  send-when-expected (built-in)  is a send expected of this agent now?
  ├── screen 3  norm legal-move (norm-shipped, deterministic, needs {fold})
  │      is this a legal committing move under the pinned norm?
  │      └─ illegal committing action ──► Withhold  ──X   (L5.6: refused BEFORE compilation begins)
  └── screen 4  semantic (optional, testimony)  outbound content policy
                          │
                          ▼
   Decision.verdict :
     Admit / AdmitUnderLimits ──► the send ships / the tool call compiles to a transaction
                                   (Channel.begin/update/commit, or Txn.send) — hooks hold no
                                   signing authority; the Signer runs downstream (L5.1)
     Withhold ─────────────────► the action does not ship / does not compile; no begin() is issued,
                                   so no in-flight collective round is stranded (L5.6)
```

Note the L5.6 ordering: the outbound chain runs on the **intent**
(`ToolCall` crossing) before any `begin`/`update`/`commit`. A `Withhold`
means compilation never starts, so refusal cannot strand a round.

## Errors

Typed channels only; no throw reaches the firewall's caller. Three tiers.

- **`Verdict` is the success value, not an error.** Every screen and the
  chain itself return `Verdict` (`Admit | AdmitUnderLimits | Withhold`) in
  the **success** channel. It is a closed, exhaustive union, agent-local,
  and never emitted outward (L5.3). `Withhold` carries a `Reason` for the
  agent's own use; the reason never crosses the boundary.

- **`ScreenError` is a screen's own typed failure, absorbed by the runner.**
  A screen may fail with `Malformed`, `ContextUnavailable`,
  `JudgeUnavailable`, or `Timeout`. The runner catches every `ScreenError`
  (and any bound overrun) and maps it to `Withhold` — **fail-closed is a
  ⊥ verdict** (CL4), not a separate code path. Consequently `Firewall.inbound`
  and `Firewall.outbound` have a `never` error channel: the firewall always
  produces a `Decision`.

- **Assembly-time errors are typed and fail the plan, not a crossing.**
  `PlacementError` (`NormReachesPrivateTrust`, `NoStructuralGate`) and
  `LoadError` (`PinMismatch`, `BundleUnavailable`) surface when the plan is
  built (`assemble`, `loadNormScreens`), before any crossing runs. A norm
  bundle that reaches for the agent's private trust data, or whose pin does
  not match, never enters the chain.

Exhaustiveness rule: every union here (`Verdict`, `Crossing` arms,
`Provenance`, `Determinism`, `Standing`, `ScreenError`, `PlacementError`,
`LoadError`) is matched with a `never`-typed default. `Need` and `CostTier`
are closed string unions in v0; a future decision widening the context
vocabulary or the cost tiers adds arms, and every exhaustive match breaks
until the new arm is handled.

## Dependencies

Spec-track design doc; it installs nothing. Versions are recommended pins
for the implementer. The public screen/chain surface names **none** of the
adapter-tier libraries; they appear only inside the resolvers the
`ContextProvider` supplies, behind the endpoint composition.

| Library | Version | License | Why (and where) |
|---|---|---|---|
| `effect` | ^3.x (pin at W1) | MIT | The realization substrate: `Effect`, `Stream`, `Option`, `Schema`, `Brand`. The only dependency the screen/chain/verdict surface needs. |
| (MCP client, SEP-2640 skills ext.) | — (interim vehicle) | — | `loadNormScreens` fetches the digest-pinned norm bundle over MCP (norms-as-bundles decision). Adapter-tier, inside the `ContextProvider`; the norm screen at the surface is just a `Screen`. |
| (model client) | — (deployment choice) | — | The `Judge` resolver behind the semantic screen. Adapter-tier; a deployment with no model simply omits the semantic screen (skippable-by-config, CL2). |

No screen, chain, or verdict signature depends on a storage, transport,
model, or MCP library: the contacts store, the ledger fold, the registry
facts lookup, and the model judge all live behind `Resolvers`, which the
`ContextProvider` (endpoint composition) provides. Constitution clause 1
(everything interpretive at endpoints) holds structurally.

## Traceability

Spec citation -> the module or law that carries it.

| Spec citation | Carried by |
|---|---|
| `screening.md` inv. 1 / `layer-interfaces.md` L5.5 (router enforces no L5 rule; endpoint-side only) | The whole chain runs inside `EndpointComposition`; no signature names the router. `context` resolvers are endpoint-held. |
| `screening.md` inv. 2 / L5.1 (gates never alter the crossing; hooks hold no signing authority) | `Screen.screen` returns a `Verdict`; it receives the crossing by value and cannot mutate it or sign. `Firewall` holds no `Signer`; the Signer runs downstream of the outbound hook (data flow). |
| `screening.md` inv. 2 acceptance / L5.2 (withheld inbound stays in the record) | `Firewall.inbound` returns `Withhold`; the runner keeps the crossing out of `Channel.inbound` only. `Ledger.read` is untouched — the firewall filters attention, never the record. |
| `screening.md` inv. 3 / L5.3 (verdicts agent-local; none on the wire) | `Verdict`, `Decision`, `StageOutcome`, `Reason` are endpoint-only types; no interface emits them. |
| `screening.md` inv. 4 / L5.4 (gate rules are the agent's own; nothing configured by the plane) | `assemble` composes built-in + agent-authored + norm-shipped screens from endpoint inputs; the plane provides none. |
| `screening.md` inv. 5 / L5.6 (illegal committing action refused before compilation; no stranded round) | The outbound chain runs on the `ToolCall` intent before `begin`; a `Withhold` means no compilation starts (data flow, outbound). |
| `firewall-two-directions.md` (two directional slots; every counterparty crosses the same two) | `FirewallPlan { inbound, outbound }`; `Crossing = InboundCrossing \| OutboundCrossing` covers messages, tool results, sends, tool calls with no per-counterparty slot. |
| `norms-are-mcp-skill-bundles.md` (legal moves = fold over committed ledger; enforced at hooks, not prompts) | The `fold` resolver -> `LegalMoves.legal`; the norm legal-move `Screen` enforces at invocation. Affordance is never the boundary (tasks.md inv. 4). |
| `norms-are-mcp-skill-bundles.md` (digest-pinned bundle; same-version = same digest) | `NormPin`; `loadNormScreens` fails on `PinMismatch`; PL4 keeps a norm screen only for same-pin bindings. |
| `monitors-are-deterministic-contracts.md` (two layers: certificate re-executable, testimony attributed) | `Determinism`; `Decision.certificate` (meet of deterministic screens) vs `Decision.testimony`; each `Screen.id` is its content hash. CL6. |
| `l7-is-policy-attached-to-identity.md` (institutional facts served beside the card; every layer reads them) | The `facts` `Need` -> `InstitutionalFacts`; the trust screen keys off standing AND facts, not contacts alone. |
| `contacts.md` (contacts are one endpoint-local trust source, not privileged) | `standing` is one `Need` among six; the trust screen is one screen among five. `Standing` mirrors allow/deny/limit + default posture. |
| `tasks.md` inv. 2, 4 (a norm binds only its pinners; affordance never the enforcement boundary) | PL4 (same-pin binding); the norm legal-move screen refuses at invocation regardless of the model-visible surface. |
| `layer-interfaces.md` `InboundMessage { frame, context }` (enrichment additive, firewall-defined) | `FirewallContext.annotations` is exactly this `context`; enrichment accumulates from the screens that ran, provenance-stamped. |
| `layer-interfaces.md` -> Not ports (firewall asserts expressibility, not equivalence; interior is undesigned) | The chain is the `withFirewall(rules)` decorator's interior; `rules` = `FirewallPlan`. No screen is a port; two agents' plans are intentionally different. |
| `VISION.md` clause 9 (rules key off any communication layer's guarantee + institutional facts; five violation responses) | `Need` spans identity (`standing`/`facts`), message type/task state (`fold`/`norm-text`), transcript; the five responses are the agent's action on a `Withhold`/`AdmitUnderLimits` `Decision`, chosen by the runtime, not the firewall. |
| `VISION.md` clause 1 (everything interpretive at endpoints) | All resolvers and screens are endpoint-held; the surface names no router type. |
| Acceptance: arena channel secrecy + role-scoped conventions; bench tolerance of faulty peers | Arena: a norm-shipped structural + legal-move screen per pinned game bundle (secrecy = withhold cross-role crossings); bench: a trust screen with a tolerant default posture admitting-under-limits. Both are `ChainParts`, no port tag, no router change. |

## Open questions

Each carries a recommended default.

1. **Fail-open for the semantic screen (availability vs safety).** A slow
   or down model makes the semantic screen `Withhold` every crossing it
   gates — a self-inflicted denial of attention when the deterministic
   prefix already admitted. Some deployments would rather admit-under-limits
   when the judge is unavailable. *Recommended default:* **fail-closed**, per
   the hard constraint — `JudgeUnavailable`/`Timeout` map to `Withhold`. A
   per-screen fail-open posture is not offered in v0. Escalation:
   `docs/spec/endpoints/screening.md`.

2. **Is stage order agent-configurable, or is cost-tier order fixed?**
   CL2 makes any order verdict-safe, so reordering is a pure cost/enrichment
   choice. *Recommended default:* `assemble` produces the cost-ascending
   order as the default; an agent may reorder within a direction but PL1
   pins the structural gate to the front (a malformed crossing must never
   reach an expensive resolver). Escalation: `docs/spec/endpoints/screening.md`.

3. **The shared, skill-distributable firewall vocabulary** (deferred at
   `contacts.md` rec. 6; `layer-interfaces.md` open q2). This proposal fixes
   six `Need` tokens, five `CostTier`s, and a `Limit` as an opaque brand.
   *Recommended default:* ship these as the v0 vocabulary; a norm-shippable
   rule-authoring format (how a bundle declares a screen's needs/cost/
   determinism as metadata, mirroring skills-as-groups) is future design.
   Escalation: `docs/spec/endpoints/screening.md`.

4. **Multi-norm composition in one conversation** (`tasks.md` open q5).
   Several pinned norms contribute several norm-shipped screens to one chain.
   *Recommended default:* each norm's screens join the chain independently
   and compose by `meet` like any other screens — precedence is
   most-restrictive-wins, so no norm's projection "wins" over another; the
   strictest legal-move set binds. Escalation: `docs/spec/endpoints/tasks.md`.

5. **Does a certificate-grade withholding auto-commit as L6 evidence?**
   The deterministic prefix's `CertificateVerdict` is re-executable and
   would make strong L6 evidence ("report to L6", "seek reparations" from
   the taxonomy). *Recommended default:* **no** — the `Decision` is
   agent-local (L5.3); committing a finding to L6 is the agent's explicit
   "report to L6" response, never automatic. The certificate is the
   receipt the agent *may* choose to file. Escalation:
   `docs/spec/enforcement.md`.

6. **Testimony idempotency across recovery.** A model judgment is expensive
   and re-runs on replay. *Recommended default:* `Testimony` carries an
   `InputDigest`; caching a judgment by `(InputDigest, judgeVersion)` is an
   endpoint optimization, out of the interface. Escalation:
   `docs/spec/endpoints/screening.md`.

7. **Enrichment trust for norm-shipped annotations.** A `NormShipped`
   screen writes provenance-stamped annotations; a downstream agent-authored
   screen or the runtime sees the stamp. *Recommended default:* annotations
   are advisory and provenance-stamped; no screen's verdict may depend on an
   annotation it did not itself derive from a resolver (keeps each screen
   independently testable). Escalation: `docs/spec/endpoints/screening.md`.
