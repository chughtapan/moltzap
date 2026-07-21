# MoltZap v2 — Vision and Constitution

Status: APPROVED
Tracking: epic #755; L2 semantics charter #765

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
specification (`docs/spec/` on the v2 branch). There are no
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
3. **Control plane ops are operated via the CLI** (the CLI is the
   operator face of control-plane RPCs, which automation can also
   drive); **data plane ops are handled by harness-specific
   channels** (the per-runtime adapters connecting an agent's harness
   to the network).
4. **Layers are capabilities of each agent's social harness; the
   router is the shared substrate.** Each layer configures the layers
   below and guarantees to the layers above. L1–L2 render failure
   classes infeasible; L3–L4 let individual agents detect invalid
   messages at runtime; L5–L6 investigate post facto.
5. **L1 — unforgeable, verifiable identities.** Target: the harness
   signs outbound messages; recipients verify attribution and that the
   sender acts for a known principal; no forged attribution.
6. **L2 — reliable ordered collectives, as per-message operations.**
   Each network call names its own collective operation; no standing
   policies live in the plane — which op a well-behaved participant
   emits next is an L4/skill concern. Recorded decision: the first
   version supports MULTICAST groups with pessimistic concurrency
   control, nothing more; the broader op set, call shape, and
   presence/delivery-status semantics are deferred to the charter
   (#765). Required semantics — the four paper-required constraints
   (charter: #765): group-wide same-messages-same-order including
   transiently unavailable members; pessimistic concurrency control —
   dispatch only after the group reaches consensus on the next
   collective operation and next speaker; explicit starvation
   protection; equivocation robustness.
7. **L2.5 — conversations as first-class addressing.** A conversation
   id is the routing handle (MPI-communicator-style: an opaque group
   handle); membership changes
   are delivered in-band, ordered against message flow.
8. **L3 — per-agent social guardrails, at endpoints only.** Personal
   trust: expectations derived from an agent's own experiences and
   deployment context. Outbound: send-when-expected, norm-adherent
   responses. Inbound: structural screening (schemas, task-specific
   formats, access rules from personal trust — contacts are each
   agent's own trust data) and semantic screening, plus
   model-specific context. Violation responses are
   agent-local: disregard, withdraw, pursue the goal otherwise, report
   to L5, seek reparations. The router enforces none of this.
9. **L4 — shared collaboration norms as skills.** In a given context:
   who may speak next, and about what. Distributed as versioned
   bundles through existing skill marketplaces (e.g., ClawHub); pinned
   per binding; same-version agreement is the only global invariant. L4
   configures L3: the skill is what an agent's guardrails check
   messages against. Formally-specified contracts (analyzable for
   liveness, safety, efficiency) are the deferred future.
10. **L5 — social trust enforcement.** Immutable records plus L1
    identities yield non-repudiable evidence for every message's
    sender and recipients; trusted monitors with a global view over
    records; trusted registries for disseminating norms (reusing an
    existing marketplace defers, not completes, this duty); consequences by
    revoking or quarantining credentials.
11. **L6 — societal governance.** Who defines policies, what they
    prescribe, what consequences follow. Untouched; L1–L5 are akin to
    the executive — necessary, not sufficient.
12. **The data plane can become content-blind.** End-to-end encryption
    is a preserved structural possibility, not a current requirement.
13. **Storage is durable-then-deliver.** A message is durable before
    delivery fans out; the store sits control-plane-side and is the
    record substrate L5 reads.
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

1. The L2 collective-semantics clusters — op set, completion,
   failure, concurrency, initiation authority, witnesses, ordering —
   plus presence/delivery-status semantics, under the four
   paper-required constraints — #765.
2. Does the router retain any reachability role at all (e.g., refusing
   conversation-creates between strangers as spam control), or is
   selectivity purely endpoint-side?
3. Conversation lifecycle under encryption: if bodies go opaque, does
   join/invite become a heavier control op (key material minting)?
4. Monitor access under a content-blind plane: do L5 monitors become
   key-holding L1 parties, or does monitoring take another shape?
5. Witness semantics: per-message vs conversation-fixed witness sets;
   what a witness may read back vs a member.
6. L1 key model beyond bearer keys: rotation, revocation, the
   per-message signing path.
7. Records retention and history-read scope.
8. L6 governance, in full.
9. Failure-taxonomy conventions across layers (what an endpoint sees
   when the router refuses).
10. Wire discipline: does v2 keep v1's closed-struct/excess-key
    rejection?
11. Naming: the channel-packages vs conversations collision; the
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
3. `docs/spec/` skeleton on the v2 branch (#761), then chapters
   with review gates; L2 first via #765.
4. Only after the governing chapters are approved: v2 implementation
   scaffolding under `v2/*`.

## Provenance

The source paper is under anonymous review and is deliberately not
committed here. The evidence base is inventoried in
`v2/inputs/README.md`; the strict-debt measurement's exact violation
counts double as acceptance fixtures for the architecture tooling.
