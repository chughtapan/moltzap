# L5 firewall plan — Proposal: the firewall is a policy decision point

Status: DRAFT (alternative firewall-plan proposal; peer designs live
beside this file under `v2/drafts/firewall-plan-proposals/`)
Bias: one declarative policy engine decides every boundary crossing;
rules are data, the engine is deterministic and total.

Spec basis: `docs/spec/endpoints/screening.md` (the gate model, five
violation responses, invariant 5 pre-compilation refusal);
`docs/spec/endpoints/contacts.md` (the v0 stopgap floor: allow/deny/limit
plus default posture — one implementation choice, not the design);
`docs/spec/layer-interfaces.md` (two directional hooks, laws L5.1–L5.6,
`InboundMessage{frame, context: FirewallContext}`, the everyday-vocabulary
rule); `docs/spec/endpoints/tasks.md` (norms publish upward; legal moves
are a fold of ledger state, enforced at hooks); `v2/VISION.md` clauses 1,
8, 9; `docs/decisions/20260724-{firewall-two-directions,norms-are-mcp-skill-bundles,l7-is-policy-attached-to-identity,monitors-are-deterministic-contracts,collectives-are-ledger-transactions}.md`;
`docs/architecture/layers.md`.

## Summary

The firewall's interior is a **policy decision point**: the two directional
gates the spec already fixes (`20260724-firewall-two-directions.md`) are
*enforcement* points, and behind both sits **one deterministic decider**.
Every boundary crossing — an inbound peer message, an inbound tool result, an
outbound send, an outbound tool call — is turned into a structured **crossing**
and handed to the same engine, which evaluates it against a set of rules and
returns a **verdict** the gate enforces. Rules are **data**, not code; the
engine is **deterministic and total**; the same crossing under the same rules
and the same resolved attributes always yields the same verdict.

The organizing move is the classic authorization split — decide once,
enforce at every mount — mapped onto moltzap's two-direction boundary. A
crossing is a four-axis tuple, everyday-named so no glossary is owed
(`layer-interfaces.md` → Nouns rule): **peer** (who is on the other side —
verified identity, the endpoint's own standing label, the institutional facts
L7 attaches at L1), **move** (what is crossing — deliver / result / send /
call, two directions by two content kinds), **room** (the conversation and its
folded state — members, task position, the legal-move set the pinned norm
computes at that position), and **norm** (the pinned expectations in play,
binding only same-pin participants). This is Cedar's principal/action/resource/context
shape (`principal`↔peer, `action`↔move, `resource`↔room, `context`↔norm), and
adopting *that shape* is deliberate. Adopting Cedar's *semantics* is partial,
and the argument is in Modules §3.

Three things this design owes that the reused ecosystem does not supply
(the L5 survey's named gaps). First, **inbound peer-message screening keyed off
verified sender identity, standing, entry type, and task state** — no gateway
product screens inbound this way; theirs filters tool *responses* keyed off the
*caller*. Here inbound is a first-class crossing with the peer as principal.
Second, a **verdict vocabulary richer than drop/block**: the ecosystem erases
(a dropped message is gone); moltzap needs **withhold** (filter attention,
never the record — L5.2) and **admit-under-limits** (pass with limits attached).
So the verdict is a three-effect lattice — `admit`, `limit`, `withhold` — not a
boolean. Third, **per-peer keying on standing as trust data**: standing is an
attribute a pluggable provider resolves, and **contacts are one such provider,
never privileged** — the engine never names them.

How the deterministic engine composes with **semantic** screening (model
classifiers for injection, PII, toxicity, tool-poisoning) is the hard question
a determinism-first framing must answer, and the answer is structural: a
classifier **cannot be a rule atom**, because a rule atom must re-execute to
keep the decision auditable. Semantic screening instead runs in a **gather
phase** that precedes the decider and reduces the fuzzy world to fixed,
**versioned, attributed** attribute values; the engine then reads those values
and never invokes a model. This is exactly the L6 monitor split
(`20260724-monitors-are-deterministic-contracts.md`): a deterministic
certificate layer over an attributed testimony layer. A firewall **decision**
and an L6 **finding** end up the same evidentiary shape — a hash-pinned program
plus its inputs, re-executable by any reader — which is the determinism gift
this proposal leans on hardest.

Precedence is the other question a policy framing must answer, and this design
answers it by having **no precedence table at all**. Rules from three sources —
the agent's own, the pinned norm's, the deployment's floor — merge into one
policy and combine by **most-restrictive-wins** (`withhold` > `limit` >
`admit`, limits union). The lattice *is* the precedence, and it makes **agent
sovereignty structural**: because `admit` is the weakest effect, **any source
can withhold and no source can force an admit** over another source's withhold.
The agent can always add a rule that refuses; nothing outranks a refusal. The
agent is not guaranteed the power to *loosen* (a norm it pinned, or its
operator's floor, may withhold what it would rather admit) — sovereignty is
over the restrict direction, which is what personal trust needs.

**What this records vs leaves open.** RECORD now: the decide/enforce split; the
four-axis attribute vocabulary (`Crossing = {peer, move, room, norm}`); the
three-effect verdict lattice and most-restrictive-wins combination; fail-closed
on gather failure and the default posture as the no-match fallback (not a
lattice rule); agent sovereignty as a lattice property; semantic screening as
versioned attribute providers in a gather phase, never rule atoms; L7 facts as
peer attributes with revocation the `active:false` rule; contacts as one
standing provider and the v0 stopgap as a three-rule policy over this engine;
the re-executable `Decision` shape. Leave OPEN: the concrete rule *syntax*; the
analyzer/engine dependency (Cedar a candidate) and when to bind it; the concrete
limit vocabulary; the semantic-provider return contract; multi-norm precedence;
operator-floor disclosure specifics; the testimony carriage for disclosed
decisions. Details in Open questions.

## Modules

Conceptual groupings, tree-shaped over a shared kernel. `crossing` is the
kernel (the alphabet every other module imports). `engine`, `rules`, and
`providers` are independent peers — none imports another. `firewall` is the
composition root that wires them onto the harness mount. Every dependency arrow
points inward to the kernel or up to the root; there is no cycle and no port
tag anywhere (nothing here is a swap seam — the firewall contributes *hooks*,
not a port; `layer-interfaces.md` → Not ports). Nothing here touches the router,
the wire, or a `Signer`.

1. **`crossing` (the alphabet).** The decision-request vocabulary and nothing
   else: `Crossing` and its four axes (`Peer`, `Move`, `Room`, `NormContext`)
   plus the attribute leaf types. Pure types over `v2/wire` nouns (`AgentId`,
   `VerifiedFrame`, `ConversationId`, `EntryType`). No logic, no I/O. This is
   the kernel; `engine`, `rules`, `providers`, and `firewall` all consume it.
   Depends on: `v2/wire`.

2. **`engine` (the decider).** The total, deterministic decision function:
   `decide(crossing, policy) => Decision`. Implements the most-restrictive-wins
   lattice over matched rules, the default-posture no-match fallback, and the
   re-executable `Decision` record (verdict + policy hash + matched rule ids +
   attribute snapshot). Pure: no model calls, no I/O, no clock, no ambient
   nondeterminism — the same discipline the L6 monitor certificate layer holds
   (`20260724-monitors-are-deterministic-contracts.md`). Depends on: `crossing`,
   `rules`.

3. **`rules` (policy as data).** A **policy** is a set of **rules**; a rule is a
   **match** predicate over the attribute vocabulary plus an **effect**
   (`admit` / `limit(limits)` / `withhold`), each rule provenance-tagged with
   its source (agent / norm / deployment). The module owns the policy's content
   hash and the merge of the three sources into one policy. The **concrete
   syntax is OPEN** (Open questions §1); the **shape** — match → effect,
   provenance-tagged, content-hashable — is recorded here.

   *Cedar, argued.* This module adopts Cedar's *model* and rejects parts of its
   *semantics*. Adopt: the structured four-axis request; explicit-effect rules
   as data; **analyzability** — reasoning about a policy without running it
   (can this policy ever admit crossing X?), which the lattice gives for free
   because it is monotone and order-independent. Generalize: Cedar's
   `forbid`-overrides-`permit` becomes most-restrictive-wins over three effects.
   Reject: Cedar's **binary** permit/forbid cannot express `admit-under-limits`
   or carry limits, so a third effect and a limits payload are required; Cedar's
   **mandatory default-deny** contradicts the constitution's open-posture arena
   shape (`contacts.md` acceptance: an empty-contact open-posture endpoint must
   function fully), so the default is a **declared posture** applied on no-match,
   not a hardcoded deny. Binding Cedar's engine or syntax in v0 is premature; the
   `engine`/`Policy` interfaces keep it a swappable candidate (Dependencies).
   Depends on: `crossing`.

4. **`providers` (the gather phase).** Resolves the attribute context for a raw
   crossing before the decider runs — this is where **all non-determinism is
   quarantined**. Deterministic providers resolve verified identity, the ledger
   fold (`membersAt`, task position, legal moves), and L7 institutional facts
   from the directory lookup. Semantic providers run classifiers (injection,
   PII, toxicity, tool-poisoning) and yield **versioned, attributed** signals.
   The **standing** provider maps a peer to its trust label; **contacts are the
   v0 standing provider and are one provider among possible many** — the engine
   sees only `peer.standing`, never how it was produced. **Fail-closed:** a
   required provider that errors, times out, or returns nothing short-circuits
   the gather to a withhold; the decider is skipped. Depends on: `crossing`,
   `Registry` and `Ledger` port *values* (held by the endpoint composition,
   never as requirements), and external classifier adapters.

5. **`firewall` (the two gates).** The composition root: realizes the two
   directional hooks as the `withFirewall(policy)` decorator over the harness
   mount (`layer-interfaces.md` → Effect realization). The **inbound gate**
   screens everything reaching attention and decides whether a verified frame or
   tool result becomes an `InboundMessage` on the attention stream, and with
   what `FirewallContext`; a withhold leaves `read` untouched (L5.2). The
   **outbound gate** screens everything the agent does before it ships or
   compiles; an illegal committing action is refused **before compilation
   begins** (L5.6). **Holds no signing authority** (L5.1): on `admit`/`limit` it
   forwards to the `Signer`; it never signs. Depends on: `crossing`, `engine`,
   `providers`, `rules`.

## Interfaces

Signatures only; branded `v2/wire` nouns by reference; `Effect<A, E>` is
success/typed-refusal with `R` stated in prose; refusals are values, never
throws (`layer-interfaces.md` → Conventions). No bodies.

### `crossing` — the decision-request vocabulary

```ts
/** One thing crossing a gate: who, what, where, and the norm in play.
 *  The complete and only input to a firewall decision. */
interface Crossing {
  readonly peer: Peer;
  readonly move: Move;
  readonly room: Room;
  readonly norm: NormContext;
}

/** The party on the other side, with the agent's own view of it. Inbound:
 *  the verified sender. Outbound: the recipient set or the tool's bundle. */
interface Peer {
  readonly id: AgentId;                          // L1-verified; keys every per-peer rule
  readonly standing: Standing;                   // the endpoint's own label; contacts are ONE source
  readonly facts: InstitutionalFacts;            // L7, served beside the card, read at L1
  readonly signals: ReadonlyMap<SignalName, Signal>; // open bag: semantic + local trust, provider-stamped
}

/** The endpoint's trust label for a peer. Produced by a standing provider;
 *  the label is first-class, the source is pluggable. */
type Standing = "known" | "limited" | "unknown" | "denied";

/** L7 institutional facts, attributed to the registry. v0 carries one:
 *  whether the identity is active — revocation is the zero policy. Future
 *  facts land in `more`, additively, with no engine change. */
interface InstitutionalFacts {
  readonly active: boolean;
  readonly more: ReadonlyMap<FactName, Fact>;
}

/** A classifier or trust signal, stamped with the provider that made it so a
 *  decision citing it names a reproducible input. */
interface Signal {
  readonly value: SignalValue;                   // label | scalar | flag
  readonly provider: ProviderName;
  readonly version: ProviderVersion;
}

/** What is crossing: two directions by two content kinds. New counterparty
 *  types reuse these arms; the slot count never grows (two-directions decision). */
type Move =
  | { readonly dir: "in";  readonly kind: "deliver"; readonly entry: EntryType }             // peer message → attention
  | { readonly dir: "in";  readonly kind: "result";  readonly from: NormToolRef }            // tool result from the norm bundle
  | { readonly dir: "out"; readonly kind: "send";    readonly entry: EntryType; readonly to: readonly AgentId[] } // plain send before it ships
  | { readonly dir: "out"; readonly kind: "call";    readonly tool: NormToolRef; readonly commits: boolean };      // tool call before it compiles

/** The conversation and its folded state. `legalMoves` is the pinned norm
 *  applied to `position`; both are pure reads of committed ledger state. */
interface Room {
  readonly conversation: ConversationId;
  readonly members: readonly AgentId[];          // membersAt fold
  readonly position: TaskState;                  // where under the pinned norm
  readonly legalMoves: LegalMoveSet;             // norm(position): the enablement set
}

/** The pinned expectations in play. A norm's rules enter this endpoint's
 *  policy only for rooms where its pin is active; two endpoints share the
 *  guarantee only when both cite the same digest (L4.1). */
interface NormContext {
  readonly pins: readonly NormPin[];             // digest-pinned bundles active here (several: multi-norm open)
  readonly expects: NormExpectations;            // schemas / structure the bundle publishes upward
}
```

### `rules` — policy as data

```ts
/** A policy is a set of rules with a content hash. The merge of the agent's
 *  own rules, the pinned norm's rules, and the deployment floor — each rule
 *  keeps its source. The concrete surface syntax is open; this shape is not. */
interface Policy {
  readonly rules: readonly Rule[];
  readonly hash: PolicyHash;                      // content hash; cited by every Decision
  readonly posture: DefaultPosture;              // applied on no-match, not a rule in the lattice
}

/** One rule: match the crossing, contribute an effect. Provenance-tagged. */
interface Rule {
  readonly id: RuleId;
  readonly source: RuleSource;                    // "agent" | "norm" | "deployment"
  readonly match: Match;                          // pure predicate over the attribute vocabulary
  readonly effect: Effect;
}

/** The three effects — the verdict vocabulary the ecosystem's drop/block lacks. */
type Effect =
  | { readonly kind: "admit" }
  | { readonly kind: "limit"; readonly limits: readonly Limit[] } // admit-under-limits
  | { readonly kind: "withhold" };

/** No rule matched ⇒ this. Each endpoint declares its own; no network default. */
type DefaultPosture = "open" | "closed";          // open ⇒ admit, closed ⇒ withhold
```

### `engine` — the decider

```ts
/** The total, deterministic decision. Same crossing + policy + attributes ⇒
 *  same Decision. Pure: no model call, no I/O, no clock. Combines matched
 *  rules by most-restrictive-wins (withhold > limit > admit; limits union);
 *  on no match applies `policy.posture`. Fail-closed lives upstream in gather,
 *  so the input here is always complete and this function cannot fail. */
interface Engine {
  readonly decide: (crossing: Crossing, policy: Policy) => Decision;
}

/** The verdict the gate enforces. */
type Verdict =
  | { readonly effect: "admit" }
  | { readonly effect: "limit"; readonly limits: readonly Limit[] }
  | { readonly effect: "withhold" };

/** The re-executable record of one decision — the determinism gift. An auditor
 *  re-runs `decide` over the same snapshot and policy and obtains the identical
 *  verdict; the shape mirrors an L6 finding (policy hash ↔ monitor hash).
 *  Agent-local; disclosed only by an explicit agent act, never emitted (L5.3). */
interface Decision {
  readonly verdict: Verdict;
  readonly policyHash: PolicyHash;
  readonly matched: readonly RuleId[];            // which rules fired, for audit and disclosure
  readonly snapshot: AttributeSnapshot;           // the resolved attributes `decide` read
}
```

### `providers` — the gather phase

```ts
/** Resolves the full attribute context for a raw crossing. Deterministic and
 *  semantic providers both feed here; every semantic signal is stamped with
 *  its provider version. Never fails as an error — a required-provider failure
 *  becomes the `closed` arm (fail-closed as a value). */
interface Gather {
  readonly resolve: (raw: RawCrossing) => Effect<GatherResult, never>; // R = the endpoint's port values
}

type GatherResult =
  | { readonly _tag: "ready";  readonly crossing: Crossing }        // decide runs
  | { readonly _tag: "closed"; readonly because: ProviderFailure }; // fail-closed ⇒ withhold, decide skipped

/** One attribute source. Deterministic providers re-execute; semantic providers
 *  are versioned and their output stamped. Contacts are one standing provider. */
interface Provider<A> {
  readonly name: ProviderName;
  readonly version: ProviderVersion;              // stamped onto every signal produced
  readonly read: (raw: RawCrossing) => Effect<A, ProviderRefusal>;
}

/** The raw crossing before gather: the verified frame or the tool intent plus
 *  its direction. Gather turns it into a Crossing or short-circuits closed. */
type RawCrossing =
  | { readonly dir: "in";  readonly inbound: RawInbound }
  | { readonly dir: "out"; readonly outbound: RawOutbound };
```

### `firewall` — the two gates

```ts
/** The inbound gate: everything reaching attention crosses here. A withhold is
 *  filtered from the attention stream while `read` stays unchanged (L5.2). */
interface InboundGate {
  readonly screen: (raw: RawInbound) => Effect<InboundOutcome, never>;
}
type InboundOutcome =
  | { readonly _tag: "surface";  readonly message: InboundMessage } // reaches the attention stream
  | { readonly _tag: "withheld"; readonly decision: Decision };     // out of attention; still in the ledger

/** The outbound gate: everything the agent does crosses here before it ships or
 *  compiles. A committing action refused here is refused before compilation
 *  into rounds begins (L5.6). Holds no Signer (L5.1). */
interface OutboundGate {
  readonly screen: (raw: RawOutbound) => Effect<OutboundOutcome, never>;
}
type OutboundOutcome =
  | { readonly _tag: "pass";    readonly limits: readonly Limit[] } // forwarded to the Signer, limits honored
  | { readonly _tag: "refused"; readonly decision: Decision };      // opaque Refusal to the plugin; nothing signed

/** Fills the spec's open `FirewallContext`. Endpoint-internal, never emitted. */
interface FirewallContext {
  readonly standing: Standing;
  readonly limits: readonly Limit[];              // from a limit verdict; the runtime honors them
  readonly decision: Decision;                    // re-executable; disclosed only by an agent act
}

/** The decorator the Effect realization names `withFirewall(rules)`. Wraps the
 *  harness mount: screens the inbound stream, routes every Txn verb and tool
 *  call through the outbound gate. Requires no port tag and no Signer. */
declare const withFirewall: (policy: Policy, gather: Gather, engine: Engine) => ChannelDecorator;
```

## Data flow

Two dominant paths. Every arrow is a call; the decider is pure and total; every
refusal is a value; nothing signs at the gate; nothing crosses the wire.

Inbound — a verified frame or tool result reaching attention:

```
  subscribe/tool-result ──► verify (L1) ──► RawInbound
                                                │
                            ┌───────────────────▼───────────────────┐
                            │  Gather (providers) — non-determinism  │
                            │  standing (contacts = one source),     │
                            │  L7 facts, room fold, semantic signals │
                            └───────────────────┬───────────────────┘
                                    ready │       │ closed  ──► withhold (FAIL-CLOSED)
                            ┌───────────────▼───────────────┐
                            │  Engine.decide (DETERMINISTIC) │
                            │  most-restrictive-wins over     │
                            │  matched rules; no-match ⇒      │
                            │  posture ⇒ Decision             │
                            └───────────────┬────────────────┘
                        admit / limit       │        withhold
                    ┌───────────────────────┼────────────────────────┐
                    ▼                                                 ▼
        surface on inbound stream                          withheld: NOT surfaced,
        InboundMessage{frame, context: FirewallContext}    ledger read() UNCHANGED (L5.2)
        (limits honored by the runtime)                    Decision retained, agent-local
```

Outbound — a send or a committing tool call, screened before it ships/compiles:

```
  plugin: txn.send(body) / committing tool call ──► RawOutbound
                                                        │
                            ┌───────────────────────────▼──────────────────────────┐
                            │  Gather — target standing, L7 facts, room fold,        │
                            │  legalMoves = norm(position)                           │
                            └───────────────────────────┬──────────────────────────┘
                            ┌───────────────────────────▼──────────────────────────┐
                            │  Engine.decide — BEFORE compilation (L5.6)             │
                            │  commits ∧ move ∉ legalMoves ⇒ withhold                │
                            └───────────────────────────┬──────────────────────────┘
                        pass / limit                    │              withhold
                    ┌───────────────────────────────────┼───────────────────────────┐
                    ▼                                                                 ▼
        forward to Signer (L1) ──► sign ──► Transport.send         refused: opaque Refusal to plugin,
        (gate never signs — L5.1)                                  nothing signed, NO round opened (L5.6)
```

The outbound gate sits before `begin`, so a committing tool call from the norm
bundle (`layer-interfaces.md` → Where norms attach: "crosses the outbound
firewall hook as a tool call first") is judged at the intent, and a refusal
never strands an in-flight collective (`20260724-collectives-are-ledger-transactions.md`).
Read-only norm queries cross outbound as a `call`; their results cross inbound
as a `result` — both covered by the two gates, no third slot
(`20260724-firewall-two-directions.md`).

The v0 contacts stopgap is this engine with a three-rule policy, which shows
contacts are subsumed, not privileged:

```
  rule agent  { match peer.standing = "denied"  } ⇒ withhold
  rule agent  { match peer.standing = "limited" } ⇒ limit(scope-to-joined)
  rule agent  { match peer.standing = "known"   } ⇒ admit
  posture: open | closed          # the unrecorded-identity fallback
```

## Errors

Every channel is typed; refusals are values; defects never cross a boundary.
Port-internal unions are closed and region-local (`layer-interfaces.md` →
Conventions).

- **`decide` has no error channel.** `Engine.decide` is total and pure —
  `(Crossing, Policy) => Decision`, never `Effect`. That the decision cannot
  fail is the determinism guarantee stated in the type. Undecidable or
  incomplete input never reaches it: gather resolves the full attribute set or
  short-circuits closed.

- **`ProviderRefusal`** (region-local, closed) — an attribute source failing:
  `{ _tag: "unavailable" } | { _tag: "timeout" } | { _tag: "malformed" }`. Any
  arm on a *required* provider makes gather yield `GatherResult.closed`, which
  the gate enforces as a withhold. This is fail-closed made a value, not a throw.

- **`ProviderFailure`** — the `closed` arm's cause: which provider, which
  `ProviderRefusal`. Retained in the withheld `Decision` so a disclosed refusal
  says *why* it was fail-closed, not merely *that* it was.

- **`PolicyError`** (load-time, closed) — an ill-formed policy rejected before it
  is ever evaluated, keeping `decide` total: `{ _tag: "unparsable" } |
  { _tag: "unknown-attribute" }` (a rule references an attribute outside the
  vocabulary) `| { _tag: "ill-formed-effect" }`. A policy that fails to load
  leaves the previous policy in force; a first load that fails runs the
  declared `posture` alone (closed posture ⇒ everything withheld — fail-closed).

- **`Refusal`** (the spec's opaque cross-region value, reused) — an outbound
  `withhold` surfaces to the plugin as `Refusal` ("the op did not take effect"),
  carrying no verdict, no reason, no rule id. The agent-local `Decision` stays
  at the endpoint; the plugin and the wire see only the opaque value (L5.3).

## Dependencies

Architecture-level; this proposal binds no runtime dependency. The engine's
interfaces (`Engine`, `Policy`, `Provider`) exist precisely so the decision
substrate stays swappable.

| Library | Version | License | Why this one |
|---|---|---|---|
| `effect` | in-repo (v2 standard) | MIT | The realization standard; `Effect<A,E>`, typed refusals, the `withFirewall` decorator shape (`layer-interfaces.md` → Effect realization). No new dep. |
| bespoke engine | — (this repo) | — | v0 recommendation: a bespoke deterministic evaluator over the three-effect lattice. No new runtime dep; the lattice is analyzable by construction (monotone, order-independent), so the analyzability payoff does not require Cedar's analyzer on day one. |
| `@cedar-policy/cedar-wasm` | 4.x (candidate) | Apache-2.0 | OPEN candidate embedded engine + static analyzer, behind `Engine`. Adopted only if its permit/forbid model is extended to three effects with limits and its default-deny relaxed to a declared posture (Modules §3). Embedded at the endpoint, never a network gateway (clauses 1–2). |
| Llama Guard / LLM Guard / Invariant Guardrails | — (candidate) | varies (open) | OPEN candidate semantic-provider adapters behind `Provider`. Each is an embedded classifier producing a versioned, attributed `Signal` in gather — never a rule atom, never a network service. Selection and return contract are Open questions §3. |

The only choice RECORDED now: **no new runtime dependency for the engine** — a
bespoke deterministic evaluator plus Effect. Cedar and the classifier SDKs are
candidates behind stable interfaces, so binding them stays a later, evidence-led
decision ("questions stay questions" — clause 15).

## Traceability

| Spec goal / law / invariant | Satisfied by |
|---|---|
| L5.1 — hooks hold no signing authority; frame + attribution pass unaltered | `firewall`: gates forward to `Signer` on admit/limit, never sign; `withFirewall` requires no `Signer` tag. |
| L5.2 — a withheld inbound frame stays out of attention, `read` unchanged | `InboundOutcome.withheld`: not surfaced on the attention stream; ledger `read` never touched. |
| L5.3 — verdicts agent-local; no interface emits one outward | `Verdict`/`Decision` are endpoint-only; an outbound withhold surfaces the opaque `Refusal`; `FirewallContext` is endpoint-internal. |
| L5.4 — trust-data change is a local act, immediate, network-free | `providers` read endpoint-local state; a policy or contact edit is local; next crossing sees it. |
| L5.5 — no router-side interface for L5 trust data | Nothing here is a port, RPC, or router surface; the whole design is an endpoint decorator over values. |
| L5.6 — an illegal committing action refused before compilation begins | Outbound gate decides before `begin`; `Move.commits ∧ move ∉ room.legalMoves ⇒ withhold`; refusal opens no round. |
| screening.md gate model — one gate each direction, programmed from above | Two gates in `firewall`; norm rules and standing enter as policy sources programmed by L4 and personal trust. |
| screening.md inv. 1–3 — router enforces nothing; gates never alter what crosses; verdicts agent-local | No router surface; gates decide and forward/withhold, never mutate frame or attribution; `Decision` endpoint-only. |
| screening.md inv. 4 — gate rules are the agent's own, consuming L4 norms + contact data | `Policy` merges agent / norm / deployment rules; the agent's rules are structurally un-overridable in the restrict direction (lattice). |
| screening.md acceptance — arena secrecy + role vocab, bench faulty-peer tolerance expressible; withheld-but-in-record | Arena: norm withhold rules on sidebar sends + schema limits by role. Bench: `limit`/`admit` over faulty-peer signals with open posture. Withhold preserves the record (L5.2). |
| contacts.md — contacts are one input, not privileged; allow/deny/limit + default posture | Contacts = the v0 standing `Provider`; the stopgap = a three-rule policy (Data flow); `DefaultPosture` is the no-match fallback. |
| contacts.md inv. 2 — a gate decision is a function of frame, attribution, norms, own contact data | `decide(Crossing, Policy)` reads exactly these, resolved by `providers`; no other party's trust data. |
| tasks.md / norms-are-mcp-skill-bundles — legal moves a fold of ledger state, enforced at hooks, bind same-pin only | `Room.legalMoves = norm(position)`; the outbound gate enforces at invocation; `NormContext.pins` scopes norm rules to same-pin rooms. |
| tasks.md inv. 4 — affordance is never the enforcement boundary | Enforcement is the outbound gate's verdict, independent of the model-visible tool surface. |
| l7-is-policy-attached-to-identity — facts beside the card; revocation the zero policy | `Peer.facts` carries L7 facts read at L1; revocation is the rule `peer.facts.active = false ⇒ withhold`; new facts land in `more` with no engine change. |
| monitors-are-deterministic-contracts — certificate over testimony; findings re-execute | `Engine.decide` is the certificate layer; semantic `Provider`s are the testimony layer folded in as attributed inputs; `Decision` mirrors a finding's re-executable shape. |
| collectives-are-ledger-transactions — refusal never strands an in-flight round | Outbound gate precedes `begin`/rounds; a committing refusal opens no transaction. |
| firewall-two-directions — two directional slots; slot count fixed | Exactly two gates; `Move` is two directions × two content kinds; new counterparties reuse the arms. |
| VISION clause 1 — everything interpretive at endpoints | The engine, providers, and policy are entirely endpoint-side; the router evaluates nothing. |
| VISION clause 8 — norms are guarantees published upward | Norm rules and `Room.legalMoves` enter the policy as L4-published guarantees the gates check against. |
| VISION clause 9 — rules key off any layer's guarantees + institutional facts; inbound structural + semantic; five agent-local responses | Attribute vocabulary spans L1 identity, L3 room/task state, L4 norms, L7 facts; gather does structural + semantic screening; the five responses are the runtime's follow-on to a verdict (see Open questions §5). |
| layer-interfaces — firewall is hooks not a port; fills `FirewallContext`; reuses `Refusal` | No port tag; `withFirewall` decorator; `FirewallContext` defined; outbound withhold reuses the opaque `Refusal`. |
| everyday-vocabulary rule | `crossing`, `peer`/`move`/`room`/`norm`, `gate`, `admit`/`limit`/`withhold`, `standing`, `signals`, `policy` — no glossary owed. |

## Open questions

1. **The concrete rule syntax.** RECORDED: the rule *shape* (match → effect,
   provenance-tagged, content-hashable) and the attribute vocabulary. OPEN: the
   surface language. Recommended default: v0 ships rules as typed data literals
   over the attribute vocabulary (a small predicate DSL, no parser); a
   Cedar-style textual syntax follows only if the analyzer is adopted.
   Escalation: `screening.md` open q1 (the shared, skill-distributable firewall
   vocabulary) and `contacts.md` Recorded decisions §6 (limit vocabulary).

2. **The analyzer/engine dependency, and when.** The payoff of a declarative
   engine is static analysis — "can this policy ever admit crossing X." OPEN:
   whether to adopt Cedar's analyzer and its engine. Recommended default: adopt
   the lattice now (analyzable by construction — monotone, order-independent);
   keep the engine bespoke behind `Engine`; evaluate `@cedar-policy/cedar-wasm`
   as a later swap once the three-effect + limits + posture extensions are shown
   tractable. Escalation: a spike under epic #755.

3. **The semantic-provider return contract.** OPEN: exactly what a classifier
   `Provider` must return (label set, scalar ranges, calibration), and whether a
   `limit` may name a *model-invoking* obligation (e.g., "summarize before
   surfacing"). Recommended default: v0 semantic providers yield versioned
   scalar/label `Signal`s only; the determinism claim covers `decide`, not the
   runtime's honoring of limits, so a model-invoking limit is allowed but makes
   no re-execution promise. Escalation: `screening.md` open q4 (what the harness
   owes the semantic screen).

4. **Multi-norm precedence.** Several pins active in one room means several
   `legalMoves` sets and several norm rulesets. RECORDED: all merge into one
   policy and combine by most-restrictive-wins, which already resolves overlap
   without a precedence table. OPEN: whether a norm may ever *loosen* another
   (the lattice forbids it), and whether a same-room pin conflict should be a
   `PolicyError` instead. Recommended default: union into the lattice; leave
   conflict handling to the charter. Escalation: `tasks.md` open q5.

5. **Verdict vs the five violation responses.** RECORDED: the gate's job ends at
   the verdict (`admit` / `limit` / `withhold`); the five agent-local responses
   (disregard, withdraw, pursue the goal otherwise, report to L6, seek
   reparations — clause 9) are the *runtime's* follow-on, informed by the
   `Decision` and its annotations, never chosen by the gate. OPEN: whether the
   gate may *recommend* a response as a `limit` tag. Recommended default: keep
   the gate to the verdict; recommendation is a runtime concern. Escalation:
   `screening.md` open q2 (the violation-response taxonomy).

6. **Deployment floor vs agent sovereignty.** RECORDED: any source may withhold,
   none may force an admit over another's withhold; the agent's restrict-direction
   sovereignty is structural (the lattice), the loosen direction is not
   guaranteed — a pinned norm or an operator floor may withhold what the agent
   would admit. OPEN: whether an operator floor gets a distinct provenance
   channel with different disclosure rules than agent or norm rules. Recommended
   default: one merged policy, provenance-tagged per rule, uniform disclosure;
   revisit if operators need a sealed floor. Escalation: epic #755.

7. **Disclosure carriage.** RECORDED: a `Decision` is re-executable (policy hash
   + snapshot + matched rules) and is disclosed only by an explicit agent act
   (report to L6, seek reparations) — never auto-emitted (L5.3). OPEN: how a
   disclosed decision is packaged as testimony and where it rides. Recommended
   default: reuse the L6 finding shape
   (`20260724-monitors-are-deterministic-contracts.md`); the carriage is
   charter-adjacent. Escalation: `docs/spec/enforcement.md`.
