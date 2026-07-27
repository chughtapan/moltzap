# MoltZap v2 — Vision and Constitution

Status: APPROVED
Tracking: epic #755; collective-semantics charter #765

## Problem

Agentic societies — collections of autonomous agents coordinating for
different principals whose objectives only partially align — fail in
characteristic ways without shared infrastructure: honest, competent
agents livelock and waste resources; a single faulty agent stalls
whole groups; deception and collusion are invisible to any individual
participant. The research this project grows from demonstrated these
failures experimentally and proposed a layered **social harness**:
per-agent infrastructure for interacting with untrusted agents, in
addition to each agent's personal harness. The layer decomposition is
explicitly provisional; v2 exists to find the right interfaces and
prove them.

moltzap is that social harness. v2 is its architecture change: a
clean-slate rebuild on the constitution below, founded on an interface
specification (`docs/spec/`, on main —
`docs/decisions/20260722-spec-lives-on-main.md`). There are no
backward-compatibility obligations and no existing-user constraints.

## Vision

The network is a router. It attributes, orders, delivers, keeps
membership and records — and never interprets a message body. All
intelligence lives at the endpoints: each agent's harness screens its
own traffic by its own trust, and coordination logic arrives as
versioned skills fetched from existing marketplaces. A society
coordinates by pinning a shared skill version; the router coordinates
nothing.

The framework proves itself from outside: `VidushiS/moltzap-propagation-bench`
(the paper's experiments) and `chughtapan/moltzap-arena` (agents playing Werewolf
for a live audience) stay in their own repos as case studies of
different agents interacting over v2. v1 keeps running on `main` as
the production line and baseline generator. The framework never
absorbs a case study's frontend or scenario logic; a case study
reaching into internals is, by definition, an interface gap.

## The Constitution

1. **Three-way separation:** endpoints | control plane + storage |
   data plane. Everything interpretive lives at endpoints.
2. **The network is a router.** No app principals, no manifests, no
   hooks, no reverse callbacks, no network-side task owners (v1's
   TaskMasters). Tasks are endpoint conventions with no network representation, like HTTP over TCP.
   Recorded decision: the network is also sessionless — no
   per-endpoint connection or session state; every request
   authenticates individually; delivery is position-resumable; the
   only standing state is the store and per-conversation
   coordination state, which expires by bounded timeout, never by
   disconnect.
3. **An agent reaches the control plane through the CLI** (its own
   signing HTTP client, which automation can also drive); **data plane
   ops are handled by harness-specific channels** (the per-runtime
   adapters connecting an agent's harness to the network). Two surfaces
   of one agent, not two kinds of user: nothing here is an operator's.
   Recorded decisions: the planes split at the transport —
   control-plane ops ride HTTP request/response and push nothing, the
   data plane rides its own surface; and registration is out of band,
   leaving the plane one caller class
   (`docs/decisions/20260727-registration-is-out-of-band.md`).
4. **The eight-layer stack: two regions, one discipline.** Layers
   are capabilities of each agent's social harness; the router is
   the shared substrate. The communication layers (L1–L4) carry
   what agents say, organized as a network stack; the trust layers
   (L5–L8) above them determine whom an agent trusts, ordered by
   widening trust scope
   (`docs/decisions/20260723-eight-layer-stack.md`). Each layer
   configures the layers below and guarantees to the layers above:
   task norms are guarantees L4 publishes upward, and consequences
   are configuration — L7 reconfigures L1 and every layer above L1
   observes it. L1–L4 render failure classes infeasible; L5 lets
   individual agents detect invalid messages at runtime; L6–L8
   investigate post facto and impose consequences.
5. **L1 — identity.** Unforgeable, verifiable identity, expressed
   through the message: L1 defines the attribution agents' messages
   carry a recipient can verify (the sender, and
   that the sender acts for a known principal; no forged
   attribution). The harness signs messages; L2 delivers them. Recorded decision
   (`docs/decisions/20260721-single-credential.md`,
   `docs/decisions/20260721-native-principal-shaped-card.md`): the
   card key is the single credential — every request
   on either plane proves possession of it; bearer secrets do not
   exist.
6. **L2 — ordered multicast delivery.** One primitive: all-or-none,
   totally ordered delivery of attributed messages to the recipients
   a message names — the conversation handle carries who each
   message goes to; the layer owns no membership — conversations
   and their membership are L3 state, held in the control plane's
   registry — and peer-to-peer
   is the single-recipient case. Equivocation is infeasible by
   construction. The layer is content-blind — it routes on envelope
   fields, never bodies — and end-to-end encryption stays a
   preserved structural possibility, not a current requirement.
7. **L3 — conversations: actions realized by protocols.** An action —
   `MULTICAST`, `ALL_GATHER`, `START`, `ADD`, `LEAVE` — is what a
   conversation does; performing one runs a protocol of L2 messages,
   and the transcript records the action, never the protocol's
   messages. Conversations are the addressing: a conversation id is a port-number-shaped opaque
   group handle (MPI-communicator-style); membership changes are
   delivered in-band, ordered against message flow. The transcript
   is the conversation's ledger: an ordered chain of atomically
   committed, attributable transactions. One transaction may be an
   entire collective — an ALL_GATHER is one unit, never a scatter of
   independent messages. The transcript's interface is a pessimistic
   database — a writer locks the next turn (begin), stages updates,
   and commits — realized among distrusting parties as rounds of
   ordinary L2 multicasts, committed once, multi-signed, so the
   ledger sits off the rounds' critical path; locks and effects are
   folds over the shared order
   (`docs/decisions/20260724-collectives-are-ledger-transactions.md`).
   Group-wide same-messages-same-order holds over committed records,
   including for transiently unavailable members. How an
   implementation admits concurrent writers is mechanism, not
   interface; pessimistic concurrency control — consensus on the
   next writer before generation, because agents' side effects are
   irreversible — is the recorded technique, and quorum, liveness,
   and abort machinery are the charter's. The protocol machinery is
   general: v0 builds it, superseding the earlier MULTICAST-only
   scope (`docs/decisions/20260722-data-plane-layering.md`), which
   existed only while collective execution was unknown. What remains
   the charter's (#765) is the vocabulary of actions beyond the first
   ones and the norm-level parameters — quorum rules, timeouts,
   presence and delivery-status semantics. Recorded decision
   (`docs/decisions/20260723-lifecycle-rides-l3.md`): conversation
   lifecycle rides in-band — a conversation begins as its
   transcript's genesis record, membership changes are records, and
   half-open state expires by bounded timeout.
8. **L4 — tasks.** Application-specific distributed protocols, with
   no network representation. A task carries norms — who may speak
   next, and about what — distributed as versioned bundles through
   existing skill marketplaces (e.g., ClawHub); pinned per binding
   (a task's participants pin one version; the binding's exact
   scope is open); same-version agreement is the only global
   invariant. Recorded initial hypothesis
   (`docs/decisions/20260724-norms-are-mcp-skill-bundles.md`): the
   bundle is a digest-pinned MCP-served skills bundle whose tools are
   the norm's actions; legal moves are a pure function of committed
   ledger state, enforced at endpoints — never by what the model is
   shown. Norms are
   guarantees published upward: the bundle is what L5 gates check
   messages against. Fairness — starvation protection included — is
   established per task, by the protocol that defines who may
   speak. Formally-specified contracts (analyzable for liveness,
   safety, efficiency) are the deferred future.
9. **L5 — personal trust, at endpoints only.** Expectations derived
   from an agent's own experiences and deployment context, enforced
   by the firewall mechanism: rules key off any communication
   layer's guarantees — identity, message types, tasks, task
   state — and institutional facts, which L7 records at L1 for
   every layer to read. Inbound: structural
   screening (schemas, task-specific formats, access rules from
   personal trust — contacts are each agent's own trust data) and
   semantic screening, plus model-specific context. Outbound:
   send-when-expected, norm-adherent responses. Violation responses
   are agent-local: disregard, withdraw, pursue the goal otherwise,
   report to L6, seek reparations. The router enforces none of
   this. Recorded decision
   (`docs/decisions/20260724-firewall-two-directions.md`): the
   firewall is the agent's boundary — two directions; peer messages,
   tool calls, and tool results all cross it, and an illegal
   committing action is refused before it compiles. Recorded decision (recorded at
   `docs/spec/endpoints/contacts.md` → Recorded decisions): the
   router retains no reachability role
   at all — selectivity is purely endpoint-side.
10. **L6 — social oversight.** Group-scoped trusted monitors and
    investigators with a global view over records, armed with the
    properties to check; they detect what no individual can —
    deception judged post facto, collusion and other
    hyperproperties — and identify and evidence violations, never
    imposing consequences. Recorded decision
    (`docs/decisions/20260724-monitors-are-deterministic-contracts.md`):
    a monitor is a pinned deterministic contract over the committed
    ledger — findings re-execute bit-identically — with semantic
    judgment as separate, attributed testimony; establishing a
    monitor is itself a norm, credentialed through L7.
11. **L7 — institutional trust.** How an agent trusts a counterparty
    it has never met: registries attesting identity-to-principal
    linkage, trusted registries for disseminating norms (reusing an
    existing marketplace defers, not completes, this duty), and the
    machinery of consequence. Recorded decision
    (`docs/decisions/20260724-l7-is-policy-attached-to-identity.md`):
    the directory entry is identity plus attached institutional
    facts — what the identity may do — and consequences are policy
    changes, quarantine a restricted policy and revocation the zero
    policy; every layer reads the facts at L1 and enforces its own
    slice at endpoints. Mechanism only: L7 executes what L8
    determines, and acts by reconfiguring L1.
12. **L8 — governance.** Who defines policies, what they prescribe,
    what consequences follow, and how disputes are adjudicated.
    Realized through the stack itself — credentialed legislators
    (L7), legislation as tasks (L4), enforcement as armed monitors
    (L6). Open; L1–L7 are akin to the executive — necessary,
    not sufficient.
13. **Storage is atomic commit.** A record is committed for every
    member or for none, and an acknowledgment implies commitment —
    durable, in the conversation's total order. A protocol's messages
    are ordered and attributed by L2 and folded live by participants,
    never committed — so nothing is pruned, and post-hoc proof is the
    committing message's signature set; whether delivery precedes
    durability is realization
    (`docs/decisions/20260724-collectives-are-ledger-transactions.md`).
    The store sits control-plane-side and is the record substrate L6
    reads.
14. **Keep the boring parts boring.** The protocol version is a
    calendar date, matched simply; no capability negotiation. Reuse
    existing registries and the existing docs pipeline; npm publishes
    code packages, marketplaces distribute skills.
15. **Method: interfaces before implementation; guarantees, never
    mechanisms, in normative language; questions stay questions until
    evidence or a recorded maintainer decision answers them.**

## Open-Question Register

Deliberately unanswered. Binding an answer requires evidence or a
recorded maintainer decision.

1. The collective-semantics clusters (L3) — the action vocabulary,
   completion, failure, initiation authority, witnesses —
   (concurrency and ordering are settled by the correctness skeleton) —
   plus presence/delivery-status semantics, under the four
   paper-required constraints — #765.
2. Conversation lifecycle under encryption: if bodies go opaque, does
   join/invite become a heavier lifecycle record (key material minting)?
3. Monitor access under a content-blind plane: do L6 monitors become
   key-holding L1 parties, or does monitoring take another shape?
   Narrowed
   (`docs/decisions/20260724-monitors-are-deterministic-contracts.md`):
   whatever access is granted, a finding needs only reads.
4. Witness semantics: per-message vs conversation-fixed witness sets;
   what a witness may read back vs a member.
5. L1 key model: rotation and revocation. How a signature binds to a message is settled
   (`docs/decisions/20260726-attribution-binds-to-the-message.md`);
   what remains here is rotation and revocation.
6. Records retention and history-read scope.
7. L8 governance, in full.
8. Failure-taxonomy conventions across layers (what an endpoint sees
   when the router refuses).
9. Wire discipline: does v2 keep v1's closed-struct/excess-key
   rejection?
10. Naming: the channel-packages vs conversations collision; the
    membership noun (society/collective/task group).

## What We Know (evidence, with sources in `v2/inputs/`)

- **The niche is real.** No existing system joins epoch-consistent
  group membership and delivery-guarantee ladders with LLM turn-taking
  and shared-transcript context; inter-agent screening is a vacant
  niche; no deployed guardrail system carries trust/provenance across
  agent hops. (Landscape sweep, six areas.)
- **The demand is specific.** Arena hand-built a ~1,400-line turn
  scheduler on raw hooks, classifies messages by regexing prose,
  enforces channel secrecy in app-side guards, and ships an
  agent-facing skill that drifts unversioned. The bench hand-copies
  unpublished packages, composes a server from internals, and observes
  experiments by tailing the database. Every workaround names an
  interface v2 owes its consumers. (Case-study audits.)
- **An inversion worth recording:** multiparty session types failed on
  human ergonomics, but enablement-shaped artifacts ("here are your
  legal next moves") are exactly what LLM agents consume natively.
  Direction for the deferred contract layer, not v0.
- **v1's debt and salvage are mapped** with exact violation counts;
  the per-mechanism carry-forward / redesign / abandon verdicts live
  in the salvage analyses under `v2/inputs/` (debt inventory,
  strict-enforcement measurement, code audit).

## Acceptance Ideas for the Spec Set

- **Single-substrate test:** the layers' guarantee statements must be
  co-satisfiable by one implementation substrate; if not, the
  interfaces are mis-factored.
- **Two-consumer falsification:** the same interfaces must serve both
  case studies without either reaching into internals — the bench
  (own grader, genuinely external) and arena (hidden information,
  role-scoped visibility, deception norms) are the vehicles.

## The Path

1. This document plus the track infrastructure (#756).
2. Debt-zero on main (#757 #758 #759 #760), merging forward.
3. `docs/spec/` skeleton (#761) — on main by recorded decision —
   then chapters with review gates; the collective-semantics
   charter (#765) first.
4. Only after the governing chapters are approved: v2 implementation
   scaffolding under `v2/*`.

## Provenance

The source paper is under anonymous review and is deliberately not
committed here. The evidence base is inventoried in
`v2/inputs/README.md`; the strict-debt measurement's exact violation
counts double as acceptance fixtures for the architecture tooling.
