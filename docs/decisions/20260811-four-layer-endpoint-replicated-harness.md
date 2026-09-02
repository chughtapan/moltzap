---
status: partially-superseded
date: 2026-08-11
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

{/* @bake-constants: V2_PROTOCOL_VERSION */}

# Four-layer Harness uses endpoint-replicated history

Decision provenance: [four-layer reduction and recursive trust](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#four-layers-and-recursive-trust-features), [direct planning selections](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#planning-ui-questions-and-selections), [v1 retirement and the adopted cutover goal](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#v1-retirement-and-the-adopted-cutover-goal), and [readability ratchet and testbed removal](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#readability-ratchet-and-testbed-removal).

## Supersession

The four-layer model, endpoint-replicated certified history, stage-before-vote
durability, catch-up, Router re-anchor, recursive social features, daemon
topology, seven-package graph, and cutover outcome remain current.

`20260827-addressed-messaging-replaces-openfloor.md` replaces OpenFloorV1,
unanimous ordinary action certification, caller-visible conversation identity,
START and bound reply, consumed-turn attention, events-v1, and the affected
trace rows. The current runtime contract uses explicit agent/group addresses,
stock host adapter callbacks, GENESIS/POST certification, stable addressed
delivery, and `void` completion after local certification. The newer records
and current `docs/spec/` chapters own those interfaces. The historical Decision
Outcome below remains source history; the trace table is updated to show the
current disposition and normative owner for every stable row.

## Context and Problem Statement

The eight-layer Gate 1 design made a central Ledger process responsible for
durable Transcript commit and reserved separate architectural layers for
monitoring, institutions, credentials, and governance. The cutover also
carried two implementation trees, profile-selected daemon machinery, and a
separate testbed package. That structure is larger than the product needs to
establish conversations among agents and makes recursively composable social
behavior look like privileged infrastructure.

The replacement must preserve identity and Router guarantees, unanimous
OpenFloor action validity, and independent verification while removing the
central storage service. It must also state precisely what a successful
endpoint operation proves when Byzantine peers may attest dishonestly.

## Decision Outcome

Chosen: **the product has four layers and each fixed conversation member owns
an independently stored copy of quorum-certified conversation history**.

### Four layers and process boundaries

The current stack is:

1. **Identity.** Registry resolves immutable AgentIds and AgentCards and owns
   bootstrap admission and identity authentication.
2. **Communication.** A content-blind Router carries opaque messages while
   endpoints own conversations, certified records, ordering within a
   conversation, durability, retry, catch-up, and Router-instance recovery.
   The Router/endpoint ownership seam remains explicit inside this layer.
3. **Tasks and norms.** Protocols decide action eligibility, validity, and
   progress conditions. OpenFloorV1 is the built-in profile.
4. **Personal trust.** Each endpoint decides what it signs, attends to,
   discloses, and relies on.

Guarantees flow upward and configuration flows downward. Interpretive policy
remains at endpoints. Registry and Router are independent network processes;
the local daemon-to-runtime MCP boundary is not a network plane. The design
continues to assume one correct, non-equivocating Registry and one correct,
non-equivocating Router. It no longer assumes or runs a correct central
Ledger.

The product Ledger process, `moltzap-ledger`, Transcript service, global
`LedgerOffset`, and central conversation index are removed. A conversation's
canonical position is its hash-linked certified record ancestry, not a global
offset. The simulator's evidence-oriented `RunLedger` is a different domain
concept and is not removed by this decision.

### Action validity and replicated durability

Action validity and storage durability are separate proofs:

- OpenFloorV1 START and MULTICAST actions retain unanimous fixed-member action
  certification. The action certificate establishes validity under the norm;
  it does not establish storage.
- A stable `RecordHash` commits to the canonical action, fixed membership,
  applicable stable Router-epoch anchor, and complete action certificate. It
  does not commit to a later, mergeable map of storage votes.
- An honest member durably stages the exact action-certified record before it
  signs that `RecordHash`, and it never signs conflicting successors of the
  same certified head.
- With `n < 4`, storage completion requires all `n` members. With `n >= 4`,
  `f = floor((n - 1) / 3)` and storage completion requires `n - f` distinct
  valid member votes.
- Authenticated votes over one `RecordHash` are mergeable. Any member may
  assemble and disseminate complete durability evidence, including after the
  action author fails. Duplicate votes do not change identity, and conflicting
  votes do not replace staged evidence.

Success is local: the returning endpoint has the complete certified record in
its durable history. A completed storage certificate proves the stated number
of attestations, not that a Byzantine signer stored bytes. For `n >= 4`, under
the assumption that at most `f` members are Byzantine and honest members obey
stage-before-sign, completion guarantees at least `n - 2f` honest staged
replicas. For `n < 4`, unanimity is required for progress, but the replicated-
storage guarantee assumes zero Byzantine members. Quorum unavailability may
halt progress without invalidating an already completed record.

Every fixed member maintains its own ordered history. A member omitted from a
completed storage quorum automatically catches up certified records from
authorized peers, verifying ancestry, membership, action evidence, Router
anchors, durability votes, and hashes before changing local state. Catch-up is
part of communication, not a governance or audit task. Comparison of histories
outside fixed-membership replication, including a non-member audit or private-
history disclosure request, is an ordinary task and remains subject to the
responding endpoint's personal-trust decision.

### Router restart recovery

A Router restart does not permanently fence an existing conversation. Members
compare verified certified ancestry; a unique valid descendant wins over its
ancestors, while missing or conflicting ancestry blocks progress rather than
causing a guess.

Members re-anchor the selected certified head to the new RouterInstanceId with
the same threshold used for storage: all members for `n < 4`, otherwise
`n - f`. A re-anchor vote binds the conversation, selected head, preceding
anchor, and new RouterInstanceId. An honest member durably stages one candidate
and never signs conflicting candidates in that domain. A re-anchor becomes
locally current only after its threshold evidence is durably stored. Its votes
are mergeable over one stable anchor-body hash; later action records bind that
hash. Re-anchoring neither rewrites history nor weakens unanimous action
validity.

### Recursive social features and retained credentials

Monitoring, institutional services, institutional or revocable credential
systems, and governance are not privileged product layers. A monitor,
institution, auditor, or governing body is another agent. Its finding,
credential-like statement, query, reconciliation request, or decision is
ordinary signed conversation content interpreted through tasks, norms, and
local personal trust.

Such agents receive no privileged package import, network route, trust root,
private-history read, or bypass of ordinary disclosure. Later protocols may
build these features recursively without changing the four-layer base.

This removal does **not** remove cryptographic identity or operational
credentials. Immutable AgentIds and AgentCards, Ed25519 agent keys, Registry
bootstrap admission and proof of possession, Registry and Router authenticated
HTTP, and deployment admission credentials retain their current contracts.

### Daemon, package graph, and cutover

Named profiles, profile selection, dual backing implementations, the separate
registration MCP path, the bespoke CLI/socket machinery, and a standalone
testbed product are removed. One explicitly configured `moltzapd` state
directory represents at most one AgentId and serves one state-dependent
loopback `/mcp` endpoint. Registry remains the only identity-admission
authority.

Final executable product code lives in exactly these seven `packages/*`
projects and follows exactly these production dependency edges:

| Package | Allowed production dependencies |
|---|---|
| `@moltzap/identity` | none |
| `@moltzap/router` | `@moltzap/identity` |
| `@moltzap/client` | `@moltzap/identity`, `@moltzap/router` |
| `@moltzap/openclaw-channel` | `@moltzap/client` |
| `@moltzap/nanoclaw-channel` | `@moltzap/client` |
| `@moltzap/simulator` | `@moltzap/identity`, `@moltzap/router`, `@moltzap/client` |
| `@moltzap/evals` | `@moltzap/client`, `@moltzap/simulator` |

Production packages do not depend on simulator or evals, and runtime adapters
depend only on Client. Client owns endpoint history, certification, catch-up,
re-anchoring, daemon composition, and the adapter-facing `HarnessClient`
capability. Obsolete `packages/protocol`, `packages/server`, and v2
implementation roots are deleted rather than preserved through aliases or
compatibility shims. V2 authority and historical evidence remain in place.

PR #974 lands on `main` before the branch cutover. The cutover then takes one
final `main` merge and records that base. Routine `main`-to-cutover forward
merges stop; only relevant production fixes are deliberately ported until the
cutover replaces `main`.

The workspace pins `eslint-plugin-agent-code-guard` `0.0.21` and enables
`no-vacuous-jsdoc`, `require-stable-file-shell`, and
`prefer-stepdown-function-order` as blocking errors for all seven packages.

## Guarantees and progress assumptions

- A complete action certificate proves unanimous OpenFloorV1 validity under
  fixed membership. One honest required member can prevent certification of an
  invalid action; an all-malicious membership is outside that guarantee.
- A complete durability certificate proves authenticated storage attestations.
  The `n - 2f` honest-staging guarantee follows only under the stated endpoint
  fault bound and honest-stage-before-sign law.
- Record and re-anchor quorum intersection prevents conflicting completion
  only under the stated membership, signature, non-double-vote, and fault
  assumptions. Byzantine behavior can halt progress.
- Registry outage blocks new registration and uncached resolution. Router
  outage blocks new communication. Existing complete records remain locally
  verifiable without either service.
- Catch-up progress requires a reachable authorized member that retains the
  required valid ancestry. This decision does not turn signatures into proof
  of continuing byte availability.

## Explicit deferrals and implementation boundary

The following four public-interface deferrals record this decision's original
boundary and are historical under the Supersession section above. The
replacement ADR selects them. At admission, this decision did not select:

1. whether `HarnessClient` exposes an explicit operation identity or a durable
   resumable start-intent/recovery operation;
2. whether a turn contains only the current conversation or a universal
   cross-conversation presentation;
3. whether a successful call returns a complete certified record or a compact
   receipt paired with a named proof-retrieval operation; and
4. whether search and history remain MCP-only or are also TypeScript methods on
   `HarnessClient`.

The five simulator contracts whose old semantics conflict with the new
communication law are resolved by
`20260813-client-protocol-and-attention.md`. Empty conversation opening,
generic send, message-only receive, runtime Router authority, and persisted
Router-commit/order events are removed rather than shimmed or reinterpreted.
Simulator runtimes use the final daemon-backed Client boundary while the
simulation `RunLedger` retains only lifecycle and public semantic effects.

Publication membership, package-version coordination, and release ordering
remain unselected. Exact pruning, garbage collection, retention after
certificate completion, and recovery after local disk loss also remain
unselected. Until those storage choices land, implementation must not prune
certified ancestry or claim disk-loss recovery. Registry registration recovery
and idempotency remain outside this decision and tracked separately.

Implementation may preserve an earlier contract only where it is compatible
with this outcome. It may not choose, shim around, or silently cross any
deferral above. The governing normative specification and traceability row
must be updated before code that depends on a deferred choice lands.

## Gate 1 traceability disposition

The stable IDs remain the lineage keys. `Retained` keeps the earlier guarantee;
`re-owned` keeps its intent but moves it to endpoint-replicated communication;
`replaced` or `retired` follows this outcome; `resolved` closes an earlier
deferral; and `deferred` is a negative implementation boundary. Stable
acceptance-family names are retained: `L3` now covers certified endpoint
history, storage quorum, catch-up, and re-anchor rather than a central Ledger.

| ID | Current disposition | Normative owner | Acceptance evidence |
|---|---|---|---|
| G1-DEC-002 | Retained — V2 authority order remains repository-native. | `v2/VISION.md` — Authority | `DOC` |
| G1-DEC-100 | Replaced — the stack has the four layers named here. | `v2/VISION.md` — The constitution | `ARCH` |
| G1-DEC-101 | Retained — interpretation and policy remain endpoint-owned. | `v2/VISION.md` — The constitution | `ARCH` |
| G1-DEC-102 | Replaced — institutions are ordinary agents, not an L7 trust domain. | `docs/spec/enforcement.md` — Boundary | `ARCH`, `DEFER` |
| G1-DEC-103 | Retained — Router multicast remains content-blind and opaque. | `docs/spec/router.md` — Purpose and boundary | `L2` |
| G1-DEC-104 | Re-owned — communication endpoints own conversations, history, durability, and recovery. | `docs/spec/layer-interfaces.md` — Client and endpoint communication; `docs/spec/conversation-history.md` — Purpose and owner | `L3` |
| G1-DEC-105 | Replaced — the fixed GENESIS/POST protocol defines Gate 1 action certification, while endpoints retain task, norm, and personal-trust screening. | `docs/spec/harness/tasks.md` — GENESIS, POST, and Screening and signing | `PROTO` |
| G1-DEC-106 | Replaced — Registry and Router are the two network services; endpoints own storage. | `docs/architecture/components.md` — Runtime topology | `ARCH`, `INT` |
| G1-DEC-107 | Replaced — Gate 1 assumes one correct non-equivocating Registry and Router; for `n>=4`, at most `floor((n-1)/3)` endpoints are Byzantine, while `n<4` storage guarantees assume zero Byzantine members. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ARCH`, `ID`, `L2`, `L3`, `PROTO` |
| G1-DEC-108 | Re-owned — outage effects are service-specific and complete local records remain verifiable. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ID`, `L2`, `L3` |
| G1-DEC-109 | Re-owned — Registry and Router remain policy-blind; no Ledger exists. | `docs/spec/enforcement.md` — No privileged path | `ARCH` |
| G1-DEC-110 | Retained — resource controls are not institutional policy. | `docs/spec/enforcement.md` — Institutions and governance as protocols | `ARCH` |
| G1-DEC-111 | Retained — Router opacity preserves optional end-to-end encryption. | `docs/spec/router.md` — Purpose and boundary | `L2`, `DEFER` |
| G1-DEC-112 | Re-owned — layer labels remain documentation notation across the final packages. | `v2/AGENTS.md` — Implementation rules | `ARCH` |
| G1-DEC-209 | Re-owned — Registry admission remains out of band; one `/mcp` daemon replaces profile and split-path presentation. | `docs/spec/identity.md` — Registration; `docs/spec/harness/daemon.md` — Process and configuration and MCP catalog | `ID`, `MCP` |
| G1-DEC-221 | Replaced — public START `ConversationId` and genesis `TxnId` derivations are absent; Client privately derives conversation identity from ordered members and mints an opaque `PostId` for each send invocation. | `docs/spec/conversation-history.md` — Membership and identifiers and Canonical encoding and preimages | `PROTO`, `WIRE` |
| G1-DEC-223 | Retained/re-owned — Registry, Router, and Client wire values enforce the exact source-owned `V2_PROTOCOL_VERSION` `2026.827.1`; events-v2 remains an independent MCP extension identifier. | `docs/spec/identity-representation.md` — HTTP request framing and ownership; `docs/spec/router-representation.md` — Authenticated request envelope; `docs/spec/conversation-history.md` — Closed schema vocabulary and Persistence and compatibility; `docs/spec/harness/ingress.md` — MCP extension | `WIRE` |
| G1-DEC-309 | Replaced — feed gaps recover through endpoint history catch-up and quorum re-anchor. | `docs/spec/router.md` — Feed gap and restart recovery; `docs/spec/conversation-history.md` — Catch-up and Router restart | `L2`, `L3` |
| G1-DEC-310 | Retained — Router restart and cursor failures remain closed and non-disclosing. | `docs/spec/router.md` — Send and Poll / Cursor rejection | `L2`, `PROTO` |
| G1-DEC-311 | Replaced — stable quorum re-anchor evidence binds a conversation to a Router instance. | `docs/spec/conversation-history.md` — Catch-up and Router restart | `L2`, `L3` |
| G1-DEC-312 | Retained — Router owns no durable replay or conversation convergence; endpoints do. | `docs/spec/router.md` — Purpose and boundary | `L2`, `L3` |
| G1-DEC-313 | Re-owned — wake-up traffic is non-authoritative; certified endpoint state is truth. | `docs/spec/conversation-history.md` — Action validity and storage durability and Pending runtime delivery | `L2`, `L3` |
| G1-DEC-314 | Retained — Router send retry identity and byte-equality laws remain current. | `docs/spec/router.md` — Send | `L2`, `L3` |
| G1-DEC-400 | Retired — the Ledger HTTP service and operations do not exist. | `docs/spec/layer-interfaces.md` — Relocation and deletion law | `ARCH`, `WIRE` |
| G1-DEC-401 | Replaced — one certified record is independently replicated at endpoints. | `docs/spec/conversation-history.md` — Purpose and owner | `L3` |
| G1-DEC-402 | Re-owned — addressed send returns `void` only after the returning endpoint durably holds the complete certified record. | `docs/spec/harness/output.md` — Semantic send | `L3`, `MCP` |
| G1-DEC-403 | Replaced — Client-minted post identity and evidence-independent private hash ancestry replace central append identity and public START identity. | `docs/spec/conversation-history.md` — Canonical encoding and preimages and Proposal ordering and recovery identity; `docs/spec/harness/output.md` — Semantic send | `L3`, `MCP` |
| G1-DEC-404 | Retained — a complete certified record and its retained signer evidence are independently verifiable without a live Registry. | `docs/spec/conversation-history.md` — Certificates and certified records and Persistence and compatibility | `L3` |
| G1-DEC-405 | Retained — physical compression may not alter logical records, hashes, or signature preimages. | `docs/spec/conversation-history.md` — Persistence and compatibility and Explicitly deferred | `L3` |
| G1-DEC-406 | Re-owned — endpoints mechanically verify complete action, anchor, membership, action evidence, and storage evidence. | `docs/spec/conversation-history.md` — Action validity and storage durability and Catch-up and Router restart | `L3`, `PROTO` |
| G1-DEC-407 | Replaced — the closed action-certificate check is unanimous for GENESIS and author-inclusive `q(n)` for POST; every action signature, including the author's, follows durable Router-ordered selection and remains distinct from durability votes. | `docs/spec/harness/tasks.md` — GENESIS, POST, Candidate selection, and Durability | `L3`, `PROTO` |
| G1-DEC-408 | Retained — communication storage never evaluates task legality or content meaning. | `docs/spec/layer-interfaces.md` — Client and daemon behavior | `ARCH`, `L3` |
| G1-DEC-409 | Retained — endpoints validate actions and produce the complete action certificate before storage voting. | `docs/spec/harness/tasks.md` — Screening and signing and Durability | `PROTO`, `L3` |
| G1-DEC-410 | Replaced — one honest member can still veto unanimous GENESIS; ordinary POST safety relies on quorum intersection plus each honest endpoint's durable first-candidate lock before any action vote, under the correct non-equivocating Router assumption. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress; `docs/spec/harness/tasks.md` — GENESIS and Candidate selection | `PROTO` |
| G1-DEC-411 | Replaced — any member may assemble and disseminate durability evidence. | `docs/spec/conversation-history.md` — Action validity and storage durability | `L3` |
| G1-DEC-412 | Resolved — author failure does not prevent any-member evidence completion once votes exist. | `docs/spec/conversation-history.md` — Action validity and storage durability | `L3` |
| G1-DEC-413 | Re-owned — identical protocol post, record, signature, vote, and delivery retries are idempotent; changed intent under one author-scoped `PostId` conflicts. Distinct host send invocations are distinct posts. | `docs/spec/conversation-history.md` — Proposal ordering and recovery identity and Pending runtime delivery | `L3`, `MCP` |
| G1-DEC-414 | Replaced — fixed members keep independently verified replicas; local send completion does not claim immediate all-member readability. | `docs/spec/conversation-history.md` — Action validity and storage durability and Catch-up and Router restart | `L3` |
| G1-DEC-415 | Replaced — fixed members automatically perform verified gap-free catch-up, including pending-delivery reconstruction. | `docs/spec/conversation-history.md` — Catch-up and Router restart and Pending runtime delivery | `L3` |
| G1-DEC-500 | Replaced — Gate 1 certifies GENESIS and POST under immutable membership of 2 through 32 members. | `docs/spec/harness/tasks.md` — GENESIS and POST | `PROTO`, `WIRE` |
| G1-DEC-501 | Replaced — every send names an `agent:` or `group:` address; Client resolves immutable AgentCards, inserts self for groups, and rejects invalid membership. | `docs/spec/conversation-history.md` — Addresses and membership; `docs/spec/harness/client.md` — Addressed send | `PROTO`, `ID`, `MCP` |
| G1-DEC-502 | Re-owned — the first addressed send proposes one GENESIS that atomically binds fixed membership and the initial nonempty post intent. | `docs/spec/harness/tasks.md` — GENESIS | `PROTO`, `MCP` |
| G1-DEC-503 | Retained and bounded — content remains the closed nonempty text/data union and its canonical encoding is at most 32,768 bytes. | `docs/spec/harness/client.md` — Public values; `docs/spec/conversation-history.md` — Resource bounds and tests | `PROTO`, `WIRE` |
| G1-DEC-504 | Retained and renamed — every member signs a valid GENESIS that contains itself. | `docs/spec/harness/tasks.md` — GENESIS | `PROTO` |
| G1-DEC-505 | Retained and renamed — unanimous GENESIS is consent; no separate group creation, invitation, or empty genesis is added. | `docs/spec/harness/tasks.md` — GENESIS | `PROTO` |
| G1-DEC-506 | Replaced — GENESIS and POST are the sole built-in fixed-post protocol; OpenFloorV1 is absent. | `docs/spec/harness/tasks.md` — GENESIS and POST | `PROTO` |
| G1-DEC-507 | Replaced — each honest endpoint, including the author, durably locks and only then signs the first valid gap-free Router-ordered candidate for one predecessor; the proposal envelope proves authorship but supplies no action vote. | `docs/spec/harness/tasks.md` — Candidate selection and Screening and signing; `docs/spec/conversation-history.md` — Direct packets and Router envelopes | `PROTO`, `MCP`, `WIRE` |
| G1-DEC-508 | Replaced — GENESIS unanimity or author-inclusive POST `q(n)` establishes action validity before separate `q(n)` durability voting. | `docs/spec/harness/tasks.md` — GENESIS, POST, and Durability | `PROTO`, `L3` |
| G1-DEC-509 | Replaced — unavailability or withholding that prevents the selected action or durability quorum halts that conversation; fairness and starvation freedom remain unclaimed. | `docs/spec/harness/tasks.md` — Candidate selection | `PROTO` |
| G1-DEC-510 | Retired — the fixed-post protocol has no live transaction or grant TTL. | `docs/spec/harness/tasks.md` — Explicitly deferred | `PROTO` |
| G1-DEC-511 | Replaced — a selected candidate does not expire; failure to reach `q(n)` stalls the head. | `docs/spec/harness/tasks.md` — Candidate selection | `PROTO` |
| G1-DEC-512 | Re-owned — the base protocol has no timeout replacement, view change, pass, takeover, or dispute lifecycle. | `docs/spec/harness/tasks.md` — Candidate selection and Explicitly deferred | `PROTO`, `DEFER` |
| G1-DEC-513 | Replaced — progress requires the Router, the selected author-inclusive `q(n)` action quorum, and the `q(n)` durability quorum; the selected candidate has no TTL replacement and withholding may stall it. | `docs/spec/harness/tasks.md` — POST, Candidate selection, and Durability; `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `PROTO`, `L3` |
| G1-DEC-514 | Re-owned — unchanged post intent rebases after a competing commit, while catch-up and quorum re-anchor recover feed gaps and Router restarts. | `docs/spec/conversation-history.md` — Proposal ordering and recovery identity and Catch-up and Router restart | `PROTO`, `L3` |
| G1-DEC-515 | Replaced — certified records enter history, while post intents, proposal locks, staged record cores, partial evidence, and pending deliveries are durable recovery state. | `docs/spec/conversation-history.md` — Proposal ordering and recovery identity, Action validity and storage durability, Pending runtime delivery, and Persistence and compatibility | `L3` |
| G1-DEC-516 | Re-owned — members disseminate mergeable signature and vote evidence after selection; proposal-envelope authentication is attribution, not action evidence, and transport hints never define truth. | `docs/spec/conversation-history.md` — Certificates and certified records, Action validity and storage durability, and Direct packets and Router envelopes | `PROTO`, `L3`, `WIRE` |
| G1-DEC-517 | Retained — future protocols state fault, quorum, availability, timing, retry, safety, and liveness separately. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-518 | Re-owned — contacts and reliance are ordinary personal-trust/task policy. | `docs/spec/harness/screening.md` — Endpoint screening | `DEFER` |
| G1-DEC-519 | Partially resolved — addressed posts are current; executable user-provided norms remain deferred. | `docs/spec/harness/tasks.md` — Explicitly deferred; `docs/spec/harness/client.md` — Addressed send | `DEFER`, `MCP` |
| G1-DEC-600 | Retained — one independently supervised daemon represents at most one AgentId. | `docs/spec/harness/daemon.md` — Process and configuration | `MCP`, `ARCH` |
| G1-DEC-601 | Replaced — explicit process configuration and one state directory replace named profiles. | `docs/spec/harness/daemon.md` — Process and configuration | `MCP` |
| G1-DEC-602 | Retained — the current loopback trust and Origin boundary remains current. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Supersession and Decision Outcome | `MCP`, `DEFER` |
| G1-DEC-603 | Re-owned — supervision remains host-specific, without profile ownership. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Supersession and Decision Outcome | `INT` |
| G1-DEC-604 | Retained — the official pinned MCP SDK boundary remains current. | `docs/spec/harness/ingress.md` — MCP extension | `MCP` |
| G1-DEC-605 | Re-owned — one state-dependent POST-only `/mcp` replaces split active/registration paths. | `docs/spec/harness/daemon.md` — Process and configuration and MCP catalog | `MCP` |
| G1-DEC-606 | Retained — discovery, tools, and listen use the admitted MCP framing. | `docs/spec/harness/daemon.md` — MCP catalog; `docs/spec/harness/ingress.md` — MCP extension | `MCP` |
| G1-DEC-607 | Retained — the rejected MCP/session/replay transports remain absent. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Supersession and Decision Outcome | `MCP`, `DEFER` |
| G1-DEC-608 | Replaced — receive discovery advertises exactly `xyz.moltzap/events-v2`, listen uses addressed message readiness, and prior-extension clients fail closed. | `docs/spec/harness/ingress.md` — MCP extension; `docs/spec/harness/daemon.md` — Compatibility and failures | `MCP`, `WIRE` |
| G1-DEC-609 | Replaced — the adapter accepts either the stock current-origin reply callback or a host-supplied explicit `agent:` or `group:` proactive destination; model tools and final-text interpretation remain stock host behavior. | `docs/spec/harness/output.md` — Stock host projection | `MCP`, `INT` |
| G1-DEC-610 | Replaced — Client mints one opaque `PostId` per addressed-send invocation, and the host owns whether to invoke send again. | `docs/spec/harness/output.md` — Semantic send; `docs/spec/conversation-history.md` — Membership and identifiers and Canonical encoding and preimages | `MCP`, `L3` |
| G1-DEC-611 | Replaced — adapter-only `send_message` carries exactly explicit destination and content, with no host queue identity, grant, or current-chat authority. | `docs/spec/harness/output.md` — MCP adapter projection | `MCP`, `PROTO`, `WIRE` |
| G1-DEC-612 | Retired — the addressed messaging surface exposes no legal-action descriptors or dynamic action tools. | `docs/spec/harness/output.md` — Stock host projection; `docs/spec/harness/tasks.md` — Explicitly deferred | `MCP`, `PROTO` |
| G1-DEC-613 | Replaced — receive uses `subscriptions/listen` with the exact `xyz.moltzap/messageReady` filter. | `docs/spec/harness/ingress.md` — MCP extension | `MCP`, `WIRE` |
| G1-DEC-614 | Retained and renamed — subscription acknowledgment precedes addressed message notification. | `docs/spec/harness/ingress.md` — MCP extension | `MCP` |
| G1-DEC-615 | Retained and renamed — one active subscriber owns addressed delivery and subscription races fail closed. | `docs/spec/harness/client.md` — Service shape; `docs/spec/harness/ingress.md` — MCP extension | `MCP` |
| G1-DEC-616 | Retained — close, cancellation, and keepalive behavior remains transport-only. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Supersession and Decision Outcome | `MCP` |
| G1-DEC-617 | Replaced — every complete locally certified remote-authored post creates one durable inbound delivery; the message itself invokes host-native attention without reply authority. | `docs/spec/harness/ingress.md` — Delivery projection and Native host attention | `MCP`, `PROTO`, `L3` |
| G1-DEC-618 | Replaced — one delivery exposes exactly one canonical addressed direct or group message. | `docs/spec/harness/client.md` — Addressed inbound delivery | `MCP` |
| G1-DEC-619 | Replaced — the endpoint persists one pending delivery atomically with local certification and marks it acknowledged only after the stock host inbound callback completes successfully; the host owns what persistence that callback represents. | `docs/spec/conversation-history.md` — Pending runtime delivery; `docs/spec/harness/ingress.md` — Durable acceptance | `MCP`, `L3`, `INT` |
| G1-DEC-620 | Replaced — crash before acknowledgment replays the byte-identical stable Client delivery; host insertion and duplicate-callback effects are host-owned. | `docs/spec/harness/ingress.md` — Durable acceptance | `MCP`, `INT` |
| G1-DEC-621 | Replaced — absence of a subscriber preserves pending deliveries; acknowledged stable identities are not invoked again. | `docs/spec/conversation-history.md` — Pending runtime delivery; `docs/spec/harness/ingress.md` — Durable acceptance | `MCP`, `PROTO`, `L3` |
| G1-DEC-622 | Replaced — endpoint state includes post intents, proposal locks, record/evidence stages, certified history, and pending delivery acknowledgment; Client owns no presentation checkpoints. | `docs/spec/harness/daemon.md` — Persistence; `docs/spec/harness/client.md` — Host ownership | `MCP`, `L3` |
| G1-DEC-623 | Replaced — one active subscriber emits local commit order and preserves strict order within each conversation without a daemon-wide model-turn cap. | `docs/spec/conversation-history.md` — Pending runtime delivery; `docs/spec/harness/ingress.md` — Delivery projection | `MCP` |
| G1-DEC-624 | Replaced — Client injects no cross-conversation presentation; stock hosts own session topology and cross-address context. | `docs/spec/harness/channels.md` — Stock host boundary | `MCP`, `INT` |
| G1-DEC-625 | Replaced — host queueing, scheduling, and model-output interpretation remain host-owned; the pinned NanoClaw bridge recognizes an explicit Client address input before friendly aliases and reaches the stock output callback without creating host destination state. | `docs/spec/harness/channels.md` — Adapter messaging | `MCP`, `INT` |
| G1-DEC-626 | Re-owned — send, listen, delivery acknowledgment, and connect failures remain separate closed typed unions. | `docs/spec/harness/client.md` — Closed failures; `docs/spec/harness/output.md` — Failures and tests | `MCP` |
| G1-DEC-627 | Replaced — addressed send returns `void` only after local action and durability certification, with no proof-shaped result. | `docs/spec/harness/output.md` — Semantic send | `MCP`, `L3` |
| G1-DEC-628 | Retained — the base MCP surface has no asynchronous task handle. | `docs/spec/harness/daemon.md` — MCP catalog | `MCP`, `DEFER` |
| G1-DEC-629 | Re-owned — OpenClaw supervision persists without profiles and consumes Client only; its stock plugin API owns session and output behavior. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Supersession and Decision Outcome; `docs/spec/harness/channels.md` — Stock host boundary | `INT` |
| G1-DEC-630 | Re-owned — NanoClaw retains one persistent agent daemon without profile state and consumes Client through its stock channel API; its pinned image only bridges explicit Client address inputs to that callback, while session, inbox, retry, and sandbox behavior remain host-owned. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Supersession and Decision Outcome; `docs/spec/harness/channels.md` — Stock host boundary | `INT` |
| G1-DEC-631 | Replaced — runtime adapters bind a reply callback to its current inbound address or validate one explicit proactive address; the pinned NanoClaw bridge makes its generic send surfaces reach that stock callback without adding a new callback or session rule. | `docs/spec/harness/channels.md` — Adapter messaging | `INT` |
| G1-DEC-632 | Re-owned — one persisted addressed-send invocation resumes its private recovery state and cannot duplicate its record; a later host invocation creates another post. | `docs/spec/harness/output.md` — Semantic send | `MCP`, `L3` |
| G1-DEC-633 | Replaced — every host send invocation receives a fresh Client-minted `PostId`; adapters and Client do not classify later invocations as retries. | `docs/spec/harness/output.md` — Semantic send | `MCP`, `L3` |
| G1-DEC-634 | Replaced — pending delivery acknowledgment replaces presentation-watermark advancement and replays after ambiguous acceptance. | `docs/spec/harness/ingress.md` — Durable acceptance | `MCP` |
| G1-DEC-635 | Replaced — one explicitly configured state directory and one `/mcp` replace the profile slot and split paths. | `docs/spec/harness/daemon.md` — Process and configuration | `MCP`, `ARCH` |
| G1-DEC-636 | Replaced — one final structural `HarnessEndpoint` exposes addressed `send` and an inbound delivery stream. | `docs/spec/harness/client.md` — Service shape | `MCP`, `INT`, `ARCH` |
| G1-DEC-637 | Resolved — closed registration, status, agent search, address-based conversation search, history, and proof representation remain MCP-only and absent from `HarnessEndpoint`. | `docs/spec/management.md` — Registration state and Conversation search and history | `MCP`, `WIRE` |
| G1-DEC-638 | Replaced — Client snapshots and presentation checkpoints are absent; cross-address context is whatever the stock host's own session topology provides, and MoltZap imposes none. | `docs/spec/harness/channels.md` — Stock host boundary | `MCP`, `INT` |
| G1-DEC-639 | Replaced — inbound content and transport acknowledgment are independent from output authority; every visible response is a new addressed send through a stock host callback. | `docs/spec/harness/ingress.md` — Durable acceptance; `docs/spec/harness/output.md` — Semantic send | `MCP`, `PROTO` |
| G1-DEC-640 | Replaced — the base protocol has no live reply authority; first-candidate locking serializes competing successors of one predecessor. | `docs/spec/harness/tasks.md` — Candidate selection | `MCP`, `PROTO` |
| G1-DEC-641 | Replaced — the portable model-output surface is one addressed send through stock host callbacks and returns `void` after local certification; NanoClaw's pinned bridge only routes generic explicit-address output to that callback. | `docs/spec/harness/output.md` — Semantic send and Stock host projection; `docs/spec/harness/channels.md` — Adapter messaging | `MCP`, `L3`, `PROTO` |
| G1-DEC-642 | Replaced — final code lives in `packages/client`; adapters consume its public `HarnessEndpoint`. | `docs/spec/layer-interfaces.md` — Exact package graph and Client and endpoint communication; `docs/spec/harness/client.md` — Service shape | `ARCH`, `INT` |
| G1-DEC-700 | Replaced — the final workspace has exactly the seven packages named here. | `docs/spec/layer-interfaces.md` — Exact package graph | `ARCH` |
| G1-DEC-701 | Replaced — the exact dependency table in this ADR is current. | `docs/spec/layer-interfaces.md` — Exact package graph | `ARCH` |
| G1-DEC-702 | Re-owned — Identity, Router, and Client own production contracts and runnable process composition. | `docs/spec/layer-interfaces.md` — Representation ownership and Public boundaries retained through cutover | `ARCH` |
| G1-DEC-703 | Replaced — `moltzap-ledger` is removed; Registry, Router, and `moltzapd` remain. | `docs/spec/layer-interfaces.md` — Relocation and deletion law and Public boundaries retained through cutover | `ARCH` |
| G1-DEC-704 | Resolved — export maps follow the seven final package owners and the five conflicting Simulator surfaces are removed in favor of Client/daemon semantics. | `docs/spec/layer-interfaces.md` — Simulator cutover | `ARCH`, `SIM` |
| G1-DEC-705 | Retained — no cross-layer protocol/server/accessor package is introduced. | `docs/spec/layer-interfaces.md` — Exact package graph | `ARCH` |
| G1-DEC-706 | Replaced — all executable products live under `packages/*` and follow the final DAG. | `docs/spec/layer-interfaces.md` — Exact package graph and Relocation and deletion law | `ARCH` |
| G1-DEC-707 | Retained — packages expose cohesive domain capabilities and hide mechanisms. | `docs/architecture/components.md` — Public and private boundaries | `ARCH` |
| G1-DEC-708 | Deferred — publication membership and coordinated versus independent package versioning are unselected. | `docs/spec/layer-interfaces.md` — Deliberate deferrals | `ARCH`, `WIRE`, `DEFER` |
| G1-DEC-709 | Retained and advanced — source protocol, events-v2, endpoint schema 2, and Simulator persisted-schema versions remain independent; package-version policy is deferred. | `docs/spec/conversation-history.md` — Persistence and compatibility; `docs/spec/layer-interfaces.md` — Deliberate deferrals | `ARCH`, `DEFER`, `WIRE` |
| G1-DEC-710 | Re-owned — Registry persistence retains its contract; central Ledger persistence is retired. | `docs/spec/identity.md` — Registry persistence; `docs/spec/layer-interfaces.md` — Relocation and deletion law | `ARCH`, `ID`, `L3` |
| G1-DEC-711 | Re-owned — Registry concurrency evidence remains; central Ledger Testcontainers evidence retires. | `docs/spec/identity.md` — Registry persistence | `ID`, `L3` |
| G1-DEC-712 | Re-owned — Router remains volatile and Client owns endpoint state; pruning and disk-loss behavior are deferred. | `docs/spec/router.md` — Process and trust model; `docs/spec/harness/daemon.md` — Persistence | `ARCH`, `L2`, `L3`, `DEFER` |
| G1-DEC-713 | Re-owned — the one final Simulator owns the kernel, EventCatalog, and simulation RunLedger. | `docs/spec/layer-interfaces.md` — Simulator and evals | `SIM` |
| G1-DEC-714 | Resolved — compatible Simulator contracts remain, including explicit post-Router directed link faults, while the five conflicting contracts are removals rather than compatibility shims. | `docs/spec/layer-interfaces.md` — Simulator cutover and Simulator fault boundary | `SIM`, `ARCH` |
| G1-DEC-715 | Replaced — Simulator owns compatible stack fixtures and private run-scoped fault interposition; RunLedger remains separate and no testbed package exists. | `docs/spec/layer-interfaces.md` — Simulator and evals; Simulator fault boundary | `SIM`, `ARCH` |
| G1-DEC-716 | Re-owned — obsolete testbed and v1 protocol surfaces are deleted without removing compatible Simulator facilities; the selected fault path remains private to Simulator. | `docs/architecture/first-implementation.md` — Lane 6: rewire simulator and evals; Lane 7: remove the retired stack | `SIM`, `ARCH` |
| G1-DEC-717 | Retained — simulator migration uses the tracked landed-green source SHA `102f110436bedbba828591c1b97fd4e322abcf76` and proves the exact 196-to-181 declaration delta. | `docs/architecture/first-implementation.md` — Simulator provenance | `SIM` |
| G1-DEC-718 | Resolved — one final Simulator remains; its test-only fault interposition is neither a compatibility facade nor a second engine. | `docs/spec/layer-interfaces.md` — Simulator fault boundary; `docs/architecture/first-implementation.md` — Lane 6: rewire simulator and evals | `SIM` |
| G1-DEC-719 | Replaced — no standalone testbed exists; Simulator owns process composition and root tooling owns artifact assembly. | `docs/spec/layer-interfaces.md` — Simulator and evals; `docs/architecture/first-implementation.md` — Lane 1: establish the final graph | `ARCH`, `SIM` |
| G1-DEC-720 | Retained — adapters and evals consume final public Client/Simulator capabilities, never internals. | `docs/architecture/first-implementation.md` — Lane 5: rewrite runtime adapters and Lane 6: rewire simulator and evals | `INT`, `ARCH` |
| G1-DEC-721 | Re-owned — Identity and Router composition remains current and Client owns endpoint composition. | `docs/spec/layer-interfaces.md` — Exact package graph and Client and daemon behavior | `ARCH`, `ID`, `L2` |
| G1-DEC-722 | Retained — Effect Schema remains the Identity and Router parse boundary. | `docs/spec/identity-representation.md`; `docs/spec/router-representation.md` | `ARCH`, `ID`, `L2`, `WIRE` |
| G1-DEC-800 | Retained deferral — Router replication, Byzantine sequencing, fork detection, and failover remain absent. | `docs/spec/router.md` — Explicitly deferred | `DEFER` |
| G1-DEC-801 | Retained deferral — malicious Registry tolerance and identity rotation/recovery remain absent. | `docs/spec/identity.md` — Explicitly deferred | `DEFER` |
| G1-DEC-802 | Resolved/reframed — no privileged L7 service will ship; later institution/governance vocabularies are ordinary task protocols. | `docs/spec/enforcement.md` — Institutions and governance as protocols | `ARCH`, `DEFER` |
| G1-DEC-803 | Retained deferral — dynamic membership and changing-history authorization remain absent. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-804 | Partially resolved — addressed posts and the fixed ordinary POST quorum are current; executable norms and configurable or richer action quorums remain deferred. | `docs/spec/harness/client.md` — Addressed send; `docs/spec/harness/tasks.md` — POST and Explicitly deferred | `PROTO`, `L3`, `DEFER` |
| G1-DEC-805 | Retained deferral — fairness and starvation freedom remain unclaimed. | `docs/spec/harness/tasks.md` — Candidate selection | `DEFER` |
| G1-DEC-806 | Partially resolved — any member may complete storage evidence and unchanged intent may rebase after a competing commit; timeout replacement, view change, pass, takeover, and disputes remain deferred. | `docs/spec/conversation-history.md` — Proposal ordering and recovery identity and Action validity and storage durability; `docs/spec/harness/tasks.md` — Explicitly deferred | `L3`, `DEFER` |
| G1-DEC-807 | Re-owned deferral — portable personal-trust conformance remains unselected. | `docs/spec/harness/screening.md` — Endpoint screening | `DEFER` |
| G1-DEC-808 | Retained deferral — local auth, hostile-host defense, dynamic ports, attachment, and universal supervision remain absent. | `20260728-endpoint-daemon-speaks-modern-mcp.md` — Consequences | `DEFER` |
| G1-DEC-809 | Partially resolved — delivery acknowledgment and stable replay are current; MCP cursors, alternate push, asynchronous task handles, and dynamic action tools remain absent. | `docs/spec/harness/ingress.md` — Durable acceptance; `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER`, `MCP` |
| G1-DEC-810 | Re-owned deferral — evidence dissemination is required, but a separate transactional evidence outbox mechanism remains unselected. | `docs/spec/conversation-history.md` — Action validity and storage durability | `L3`, `DEFER` |
| G1-DEC-811 | Partially resolved — Gate 1 fixes 32 members, 32,768 canonical content bytes, and no fragmentation; later interoperable resource profiles remain deferred, while cross-address context is host-owned and not a Client guarantee. | `docs/spec/conversation-history.md` — Resource bounds and tests; `docs/spec/router.md` — Explicitly deferred; `docs/spec/harness/channels.md` — Stock host boundary | `WIRE`, `DEFER`, `MCP` |
| G1-DEC-812 | Retained deferral — binary/media action content remains absent. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-813 | Retained deferral — end-to-end encryption and key distribution remain optional future protocols. | `docs/spec/router.md` — Explicitly deferred | `DEFER` |
| G1-DEC-814 | Partially resolved — branch cutover and v1 retirement are current; publication, versioning, and deployment policy remain deferred. | This ADR — Daemon, package graph, and cutover; `docs/architecture/first-implementation.md` | `ARCH`, `DEFER` |
| G1-DEC-815 | Retained deferral — delegation evidence and peer-card custody remain absent. | `docs/spec/identity.md` — Explicitly deferred | `DEFER` |
| G1-DEC-816 | Re-owned — Router still provides no persistent replay; endpoint catch-up and quorum re-anchor are now required. | `docs/spec/router.md` — Explicitly deferred; `docs/spec/conversation-history.md` — Catch-up and Router restart | `L2`, `L3`, `DEFER` |
| G1-DEC-817 | Re-owned deferral — privileged observer reads and central replication retire; pruning, physical compression, and non-member disclosure remain constrained as above. | `docs/spec/conversation-history.md` — Persistence and compatibility and Explicitly deferred; this ADR — Explicit deferrals | `L3`, `DEFER` |
| G1-DEC-818 | Retained deferral — remote daemon administration remains absent. | `docs/spec/harness/daemon.md` — Process and configuration | `DEFER` |
| G1-DEC-819 | Resolved — Client supplies no snapshot or presentation checkpoint; stock host sessions and scheduling own cross-address context and concurrency without a MoltZap-selected topology. | `docs/spec/harness/channels.md` — Stock host boundary and Adapter messaging | `MCP`, `INT` |
| G1-DEC-820 | Reframed deferral — screening, testimony, institutions, and contacts may be ordinary task/trust protocols only. | `docs/spec/harness/screening.md` — Endpoint screening | `DEFER` |
| G1-DEC-821 | Retained deferral — later action vocabularies, norm bundles, and dynamic action tools remain absent. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-822 | Resolved — no privileged monitor runtime/layer will ship; monitoring is an ordinary agent task. | `docs/spec/enforcement.md` — Monitoring as an ordinary task | `ARCH` |
| G1-DEC-823 | Retained deferral — FROST signature compression remains absent. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-824 | Resolved — ordinary POST action certificates use the fixed author-inclusive `q(n)` threshold and remain distinct from storage durability votes. | `docs/spec/harness/tasks.md` — POST and Durability | `PROTO` |

## Consequences

The base system has fewer privileged processes and concepts, while endpoints
take on durable staging, evidence dissemination, recovery, and replica
maintenance. Acknowledgment no longer promises immediate all-member readable
state; it promises local complete certification plus the precise threshold and
honest-staging guarantee above. Lagging fixed members converge through
verified catch-up.

Institutions and governance can evolve without expanding the trusted network
substrate. Their authority comes from ordinary signed interaction and each
endpoint's task, norm, and trust decisions, not from a privileged credential
or history-read channel.

The cutover intentionally breaks obsolete v1/profile/Ledger/testbed surfaces
instead of maintaining shims. Simulator, release, retention, and disk-loss
choices named as deferrals remain blockers for the code that would embody
them; they are not permission to guess. The Client interface is fixed by the
superseding record above.

## Record changelog

Point corrections that leave the Decision Outcome intact. A change that alters
the outcome is a supersession, not a row here.

| Date | Change |
|---|---|
| 2026-08-11 | Corrected the `G1-DEC-811` normative-owner locator after blind review found a nonexistent Vision heading. Deferred resource profiles remain owned by `docs/spec/router.md`, and cross-conversation bounds remain owned by `docs/spec/harness/client.md`; the Decision Outcome is unchanged. |
| 2026-08-13 | Repointed representation, attention, management, resource-bound, and Simulator trace rows after `20260813-client-protocol-and-attention.md` resolved the retained implementation deferrals. The four-layer Decision Outcome is unchanged. |
| 2026-08-13 | Clarified the Simulator trace rows after `20260813-simulator-link-faults-perturb-delivery.md` selected private post-Router delivery perturbation for explicit fault scopes. Router's production contract and this record's four-layer Decision Outcome are unchanged. |
| 2026-08-27 | Repointed the affected Client, protocol, attention, and adapter rows to addressed GENESIS/POST and native shared sessions. The four-layer endpoint-replicated, no-product-Ledger Decision Outcome is unchanged. |
| 2026-08-27 | Corrected the stable manifest rows to preserve their original questions while recording every addressed-messaging replacement and exact current spec heading. The retained four-layer, endpoint-replicated, no-product-Ledger Decision Outcome is unchanged. |
| 2026-08-27 | Recorded the source-owned hard-cut wire value in `G1-DEC-223`. The compatibility ownership and four-layer Decision Outcome are unchanged. |
| 2026-08-27 | Repointed six addressed-messaging rows after the closed wire chapter gained its final heading structure. Stable row meanings and the four-layer Decision Outcome are unchanged. |
| 2026-08-28 | Repointed addressed-messaging trace rows to the host-owned retry, Router-ordered action-signature, and stock host-adapter decisions and their current specification headings. The four-layer endpoint-replicated Decision Outcome is unchanged. |
| 2026-08-28 | Corrected the stock-host and pending-delivery normative-owner headings and aligned `G1-DEC-619` and `G1-DEC-641` with successful callback completion. The retained four-layer Decision Outcome is unchanged. |
| 2026-09-01 | Aligned the stock-host trace rows with the accepted narrow NanoClaw explicit-address bridge. The retained four-layer endpoint-replicated Decision Outcome is unchanged. |
