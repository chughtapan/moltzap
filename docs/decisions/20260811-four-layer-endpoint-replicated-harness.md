---
status: accepted
date: 2026-08-11
decision-makers: Tapan Chugh
---

# Four-layer Harness uses endpoint-replicated history

Decision provenance: [four-layer reduction and recursive trust](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#four-layers-and-recursive-trust-features), [direct planning selections](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#planning-ui-questions-and-selections), [v1 retirement and the adopted cutover goal](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#v1-retirement-and-the-adopted-cutover-goal), and [readability ratchet and testbed removal](../decision-evidence/20260811-four-layer-v2-cutover-trajectory.md#readability-ratchet-and-testbed-removal).

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

This decision does not select the following public-interface details:

1. whether `HarnessClient` exposes an explicit operation identity or a durable
   resumable start-intent/recovery operation;
2. whether a turn contains only the current conversation or a universal
   cross-conversation presentation;
3. whether a successful call returns a complete certified record or a compact
   receipt paired with a named proof-retrieval operation; and
4. whether search and history remain MCP-only or are also TypeScript methods on
   `HarnessClient`.

It also does not resolve five simulator contracts whose old semantics conflict
with the new communication law: empty conversation opening, generic send,
message-only receive without record proof or reply authority, bearer/raw-
Router runtime authority, and persisted events that describe a durable Router
commit/order. Every other simulator contract remains current where compatible.
These five contracts require a separately admitted narrow break/version or a
sound explicit exemption; an inert field, lazy-send translation, or semantic
reinterpretation under an existing persisted tag is not compatibility.

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
| G1-DEC-100 | Replaced — the stack has the four layers named here. | `v2/VISION.md` — Constitution | `ARCH` |
| G1-DEC-101 | Retained — interpretation and policy remain endpoint-owned. | `v2/VISION.md` — Constitution | `ARCH` |
| G1-DEC-102 | Replaced — institutions are ordinary agents, not an L7 trust domain. | `docs/spec/enforcement.md` — Boundary | `ARCH`, `DEFER` |
| G1-DEC-103 | Retained — Router multicast remains content-blind and opaque. | `docs/spec/router.md` — Purpose and boundary | `L2` |
| G1-DEC-104 | Re-owned — communication endpoints own conversations, history, durability, and recovery. | `docs/spec/layer-interfaces.md` — Communication; `docs/spec/conversation-history.md` — Purpose and owner | `L3` |
| G1-DEC-105 | Retained — tasks/norms own eligibility and action validity; OpenFloorV1 remains built in. | `docs/spec/harness/tasks.md` — Purpose and fixed profile | `PROTO` |
| G1-DEC-106 | Replaced — Registry and Router are the two network services; endpoints own storage. | `docs/architecture/components.md` — Runtime topology | `ARCH`, `INT` |
| G1-DEC-107 | Replaced — trusted Registry/Router and the endpoint quorum fault assumptions above govern. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ARCH`, `ID`, `L2`, `L3`, `PROTO` |
| G1-DEC-108 | Re-owned — outage effects are service-specific and complete local records remain verifiable. | `docs/spec/layer-interfaces.md` — Trust, safety, and progress | `ID`, `L2`, `L3` |
| G1-DEC-109 | Re-owned — Registry and Router remain policy-blind; no Ledger exists. | `docs/spec/enforcement.md` — Network admission | `ARCH` |
| G1-DEC-110 | Retained — resource controls are not institutional policy. | `docs/spec/enforcement.md` — Network admission | `ARCH` |
| G1-DEC-111 | Retained — Router opacity preserves optional end-to-end encryption. | `docs/spec/router.md` — Purpose and boundary | `L2`, `DEFER` |
| G1-DEC-112 | Re-owned — layer labels remain documentation notation across the final packages. | `v2/AGENTS.md` — Implementation rules | `ARCH` |
| G1-DEC-209 | Re-owned — Registry admission remains out of band; one `/mcp` daemon replaces profile and split-path presentation. | `docs/spec/identity.md` — Registration; `docs/spec/harness/daemon.md` — Registration state | `ID`, `MCP` |
| G1-DEC-223 | Retained for Registry and Router; the obsolete Ledger-version qualifier is retired. | `docs/spec/identity-representation.md`; `docs/spec/router-representation.md` | `WIRE` |
| G1-DEC-309 | Replaced — feed gaps recover through endpoint history catch-up and quorum re-anchor. | `docs/spec/router.md` — Recovery; `docs/spec/conversation-history.md` — Fixed-member catch-up and Router restart and re-anchoring | `L2`, `L3` |
| G1-DEC-310 | Retained — Router restart and cursor failures remain closed and non-disclosing. | `docs/spec/router.md` — Send and cursor rejection | `L2`, `PROTO` |
| G1-DEC-311 | Replaced — stable quorum re-anchor evidence binds a conversation to a Router instance. | `docs/spec/conversation-history.md` — Router restart and re-anchoring | `L2`, `L3` |
| G1-DEC-312 | Retained — Router owns no durable replay or conversation convergence; endpoints do. | `docs/spec/router.md` — Purpose and boundary | `L2`, `L3` |
| G1-DEC-313 | Re-owned — wake-up traffic is non-authoritative; certified endpoint state is truth. | `docs/spec/conversation-history.md` — Vote dissemination and completion | `L2`, `L3` |
| G1-DEC-314 | Retained — Router send retry identity and byte-equality laws remain current. | `docs/spec/router.md` — Send | `L2`, `L3` |
| G1-DEC-400 | Retired — the Ledger HTTP service and operations do not exist. | `docs/spec/layer-interfaces.md` — Process boundaries | `ARCH`, `WIRE` |
| G1-DEC-401 | Replaced — one certified record is independently replicated at endpoints. | `docs/spec/conversation-history.md` — Purpose and owner | `L3` |
| G1-DEC-402 | Replaced — success means the returning endpoint durably holds the complete certified result. | `docs/spec/harness/output.md` — Success | `L3`, `MCP` |
| G1-DEC-403 | Replaced — `RecordHash` ancestry and stable retry identity replace offsets and central append. | `docs/spec/conversation-history.md` — Canonical order and Retry and idempotency boundary | `L3` |
| G1-DEC-404 | Retained — a complete certified record is independently verifiable without a live Registry. | `docs/spec/conversation-history.md` — Fixed profile and vocabulary | `L3` |
| G1-DEC-405 | Retained — physical compression may not alter logical records, hashes, or signature preimages. | `docs/spec/conversation-history.md` — Canonical order and local persistence | `L3` |
| G1-DEC-406 | Re-owned — endpoints mechanically verify complete action, anchor, membership, and storage evidence. | `docs/spec/conversation-history.md` — Action validity is not storage durability and Fixed-member catch-up | `L3`, `PROTO` |
| G1-DEC-407 | Re-owned — unanimous action signers and `n-f` storage voters are distinct closed checks. | `docs/spec/conversation-history.md` — Action validity is not storage durability | `L3`, `PROTO` |
| G1-DEC-408 | Retained — communication storage never evaluates task legality or content meaning. | `docs/spec/enforcement.md` — Endpoint interpretation | `ARCH`, `L3` |
| G1-DEC-409 | Retained — endpoints validate actions and produce the complete action certificate before storage voting. | `docs/spec/harness/tasks.md` — Action certification | `PROTO`, `L3` |
| G1-DEC-410 | Retained — one honest unanimous signer can prevent invalid action certification. | `docs/spec/layer-interfaces.md` — Trust and safety | `PROTO` |
| G1-DEC-411 | Replaced — any member may assemble and disseminate durability evidence. | `docs/spec/conversation-history.md` — Vote dissemination and completion | `L3` |
| G1-DEC-412 | Resolved — author failure does not prevent any-member evidence completion once votes exist. | `docs/spec/conversation-history.md` — Vote dissemination and completion | `L3` |
| G1-DEC-413 | Re-owned — identical record/vote retries are idempotent; the exact client recovery surface is deferred. | `docs/spec/conversation-history.md` — Retry and idempotency boundary; this ADR — Explicit deferrals | `L3`, `DEFER` |
| G1-DEC-414 | Replaced — members keep local replicas; acknowledgment does not prove immediate all-member readability. | `docs/spec/conversation-history.md` — Threshold and guarantee and Fixed-member catch-up | `L3` |
| G1-DEC-415 | Replaced — fixed members automatically perform verified peer catch-up. | `docs/spec/conversation-history.md` — Fixed-member catch-up | `L3` |
| G1-DEC-500 | Retained — START and MULTICAST use immutable membership epoch 0. | `docs/spec/harness/tasks.md` — Fixed profile | `PROTO` |
| G1-DEC-501 | Retained — START resolves a nonempty set of other immutable agents and rejects invalid membership. | `docs/spec/harness/output.md` — Conversation start | `PROTO`, `ID` |
| G1-DEC-502 | Retained — START atomically includes fixed membership and initial nonempty content. | `docs/spec/harness/output.md` — Conversation start | `PROTO` |
| G1-DEC-503 | Retained — content remains the closed nonempty text/data union. | `docs/spec/harness/tasks.md` — Content | `PROTO`, `WIRE` |
| G1-DEC-504 | Retained — every member signs a valid START that contains itself. | `docs/spec/harness/tasks.md` — START | `PROTO` |
| G1-DEC-505 | Retained — unanimous START is consent; no separate invitation round is added. | `docs/spec/harness/tasks.md` — START | `PROTO` |
| G1-DEC-506 | Retained — OpenFloorV1 remains the sole built-in norm. | `docs/spec/harness/tasks.md` — Fixed profile | `PROTO` |
| G1-DEC-507 | Retained — the first valid BEGIN in shared Router order wins contention. | `docs/spec/harness/tasks.md` — Contention | `PROTO` |
| G1-DEC-508 | Retained — unanimous ACK/grant and unanimous action certification remain separate from storage quorum. | `docs/spec/harness/tasks.md` — Grant and certification | `PROTO`, `L3` |
| G1-DEC-509 | Retained — withholding may halt protocol progress. | `docs/spec/harness/tasks.md` — Conditional liveness | `PROTO` |
| G1-DEC-510 | Retained — live transaction TTL remains protocol-fixed. | `docs/spec/harness/tasks.md` — TTL | `PROTO` |
| G1-DEC-511 | Retained — expiry abandons the volatile fold without changing certified history. | `docs/spec/harness/tasks.md` — TTL | `PROTO` |
| G1-DEC-512 | Retained — no pass, abort, renewal, takeover, or dispute lifecycle is added. | `docs/spec/harness/tasks.md` — Explicit deferrals | `PROTO`, `DEFER` |
| G1-DEC-513 | Re-owned — progress requires Router, required action signers, and the storage threshold, not a Ledger. | `docs/spec/harness/tasks.md` — Conditional liveness; `docs/spec/conversation-history.md` — Fault, safety, and progress matrix | `PROTO`, `L3` |
| G1-DEC-514 | Replaced — endpoint catch-up and quorum re-anchor recover feed gaps and Router restarts; exact client retry representation is deferred. | `docs/spec/conversation-history.md` — Fixed-member catch-up and Router restart and re-anchoring; this ADR — Explicit deferrals | `PROTO`, `L3`, `DEFER` |
| G1-DEC-515 | Replaced — only certified records enter history, while staged records and partial votes may be durable recovery state. | `docs/spec/conversation-history.md` — Canonical order and local persistence | `L3` |
| G1-DEC-516 | Re-owned — members disseminate mergeable votes and evidence; hints never define truth. | `docs/spec/conversation-history.md` — Vote dissemination and completion | `PROTO`, `L3` |
| G1-DEC-517 | Retained — future norms state fault, quorum, availability, timing, retry, safety, and liveness separately. | `docs/spec/harness/tasks.md` — Conditional liveness | `DEFER` |
| G1-DEC-518 | Re-owned — contacts and reliance are ordinary personal-trust/task policy. | `docs/spec/harness/screening.md` — Personal trust | `DEFER` |
| G1-DEC-519 | Retained — addressed turns and executable user-provided norms remain deferred. | `docs/spec/harness/tasks.md` — Explicit deferrals | `DEFER` |
| G1-DEC-600 | Retained — one independently supervised daemon represents at most one AgentId. | `docs/spec/harness/daemon.md` — Purpose and ownership | `MCP`, `ARCH` |
| G1-DEC-601 | Replaced — explicit process configuration and one state directory replace named profiles. | `docs/spec/harness/daemon.md` — Process state | `MCP` |
| G1-DEC-602 | Retained — the current loopback trust and Origin boundary remains current. | `docs/spec/harness/daemon.md` — Trust assumptions | `MCP`, `DEFER` |
| G1-DEC-603 | Re-owned — supervision remains host-specific, without profile ownership. | `docs/spec/harness/daemon.md` — Supervision | `INT` |
| G1-DEC-604 | Retained — the official pinned MCP SDK boundary remains current. | `docs/spec/harness/daemon.md` — MCP transport | `MCP` |
| G1-DEC-605 | Re-owned — one state-dependent POST-only `/mcp` replaces split active/registration paths. | `docs/spec/harness/daemon.md` — MCP transport | `MCP` |
| G1-DEC-606 | Retained — discovery, tools, and listen use the admitted MCP framing. | `docs/spec/harness/daemon.md` — MCP transport | `MCP` |
| G1-DEC-607 | Retained — the rejected MCP/session/replay transports remain absent. | `docs/spec/harness/daemon.md` — MCP transport | `MCP`, `DEFER` |
| G1-DEC-608 | Retained — receive capability discovery remains versioned. | `docs/spec/harness/daemon.md` — Receive extension | `MCP` |
| G1-DEC-609 | Retained — model output is START or bound reply, never generic send. | `docs/spec/harness/output.md` — Purpose and boundary | `MCP` |
| G1-DEC-610 | Deferred — the exact public operation-identity/recovery surface is unselected. | `docs/spec/harness/output.md` — Explicitly deferred | `MCP`, `DEFER` |
| G1-DEC-611 | Re-owned — reply remains bound to live authority; exact protocol representation belongs to the output spec. | `docs/spec/harness/output.md` — Bound reply | `MCP`, `PROTO` |
| G1-DEC-612 | Retained — task actions use stable closed descriptors. | `docs/spec/harness/tasks.md` — Legal actions | `MCP`, `PROTO` |
| G1-DEC-613 | Retained — receive uses the declared MCP listen capability and filter. | `docs/spec/harness/daemon.md` — Receive extension | `MCP` |
| G1-DEC-614 | Retained — subscription acknowledgement precedes turn notification. | `docs/spec/harness/daemon.md` — Receive extension | `MCP` |
| G1-DEC-615 | Retained — one listener owns turn delivery and races fail closed. | `docs/spec/harness/daemon.md` — Receive extension | `MCP` |
| G1-DEC-616 | Retained — close, cancellation, and keepalive behavior remains transport-only. | `docs/spec/harness/daemon.md` — MCP transport | `MCP` |
| G1-DEC-617 | Re-owned — only a complete certified record plus live reply authority invokes the runtime. | `docs/spec/harness/ingress.md` — Attention and authority | `MCP`, `PROTO`, `L3` |
| G1-DEC-618 | Deferred — exact current- versus cross-conversation turn context is unselected. | `docs/spec/harness/client.md` — Explicitly deferred | `MCP`, `DEFER` |
| G1-DEC-619 | Re-owned — at-most-once attention state, if retained, belongs to the endpoint store. | `docs/spec/harness/ingress.md` — Delivery law | `MCP`, `L3` |
| G1-DEC-620 | Retained — an ambiguous post-commit delivery write may lose the turn and does not create replay. | `docs/spec/harness/ingress.md` — Delivery law | `MCP` |
| G1-DEC-621 | Retained — no stream consumes no attention; one consumed head is not offered again. | `docs/spec/harness/ingress.md` — Delivery law | `MCP`, `PROTO` |
| G1-DEC-622 | Replaced — endpoint history, staged evidence, and certified completion replace offsets and Ledger receipts; context checkpoints remain deferred. | `docs/spec/harness/daemon.md` — Endpoint state; `docs/spec/harness/client.md` — Explicitly deferred | `MCP`, `L3`, `DEFER` |
| G1-DEC-623 | Retained — grants and turns serialize per conversation without a daemon-wide protocol cap. | `docs/spec/harness/ingress.md` — Same-conversation exclusion | `MCP` |
| G1-DEC-624 | Deferred — cross-conversation presentation and its bounds are unselected. | `docs/spec/harness/client.md` — Explicitly deferred | `MCP`, `DEFER` |
| G1-DEC-625 | Retained — host queue/steer policy cannot bypass one bound reply. | `docs/spec/harness/client.md` — Bound reply | `MCP`, `INT` |
| G1-DEC-626 | Re-owned — failures remain closed and typed; their exact final public set belongs to the output spec. | `docs/spec/harness/output.md` — Errors | `MCP` |
| G1-DEC-627 | Replaced — local certified success replaces Ledger acknowledgement and offsets; returned representation is deferred. | `docs/spec/harness/output.md` — Success; this ADR — Explicit deferrals | `MCP`, `L3`, `DEFER` |
| G1-DEC-628 | Retained — the base MCP surface has no asynchronous task handle. | `docs/spec/harness/daemon.md` — MCP tools | `MCP`, `DEFER` |
| G1-DEC-629 | Re-owned — OpenClaw supervision persists without profiles and consumes Client only. | `docs/spec/harness/daemon.md` — Supervision; `docs/spec/layer-interfaces.md` — Adapters | `INT` |
| G1-DEC-630 | Re-owned — NanoClaw retains one persistent agent daemon without profile state and consumes Client only. | `docs/spec/harness/daemon.md` — Supervision; `docs/spec/layer-interfaces.md` — Adapters | `INT` |
| G1-DEC-631 | Retained — runtime bridges cannot bypass bound reply authority. | `docs/spec/harness/client.md` — Bound reply | `INT` |
| G1-DEC-632 | Re-owned — identical completed replies cannot duplicate records; exact public recovery/result surface is deferred. | `docs/spec/harness/output.md` — Retry; this ADR — Explicit deferrals | `MCP`, `L3`, `DEFER` |
| G1-DEC-633 | Deferred — START retry safety remains required, but its public operation-identity/recovery representation is unselected. | `docs/spec/harness/output.md` — Explicitly deferred | `MCP`, `L3`, `DEFER` |
| G1-DEC-634 | Deferred — attention checkpoint mechanics depend on the unresolved context choice. | `docs/spec/harness/client.md` — Explicitly deferred | `MCP`, `DEFER` |
| G1-DEC-635 | Replaced — one explicitly configured state directory and one `/mcp` replace the profile slot and split paths. | `docs/spec/harness/daemon.md` — Process and paths | `MCP`, `ARCH` |
| G1-DEC-636 | Replaced — one final Client implementation replaces dual-track compatibility; its exact public methods remain deferred. | `docs/spec/harness/client.md` — Purpose and explicit deferrals | `MCP`, `INT`, `ARCH`, `DEFER` |
| G1-DEC-637 | Re-owned — management search/history remain local-authorized operations; TypeScript method exposure is deferred. | `docs/spec/management.md` — Search and history; this ADR — Explicit deferrals | `MCP`, `DEFER` |
| G1-DEC-638 | Deferred — universal cross-conversation context and checkpoints are unselected. | `docs/spec/harness/client.md` — Explicitly deferred | `MCP`, `DEFER` |
| G1-DEC-639 | Retained — content/history and live reply authority remain independent. | `docs/spec/harness/ingress.md` — Content and reply authority | `MCP`, `PROTO` |
| G1-DEC-640 | Retained — at most one live reply authority exists per conversation. | `docs/spec/harness/ingress.md` — Same-conversation exclusion | `MCP`, `PROTO` |
| G1-DEC-641 | Re-owned — the surface remains START plus bound reply and no generic send; operation and result representation are deferred. | `docs/spec/harness/output.md` — Purpose and explicit deferrals | `MCP`, `L3`, `PROTO`, `DEFER` |
| G1-DEC-642 | Replaced — final code lives in `packages/client`; adapters consume its `HarnessClient`. | `docs/spec/layer-interfaces.md` — Package graph; `docs/spec/harness/client.md` — Purpose | `ARCH`, `INT` |
| G1-DEC-700 | Replaced — the final workspace has exactly the seven packages named here. | `docs/spec/layer-interfaces.md` — Package graph | `ARCH` |
| G1-DEC-701 | Replaced — the exact dependency table in this ADR is current. | `docs/spec/layer-interfaces.md` — Package graph | `ARCH` |
| G1-DEC-702 | Re-owned — Identity, Router, and Client own production contracts and runnable process composition. | `docs/spec/layer-interfaces.md` — Package ownership | `ARCH` |
| G1-DEC-703 | Replaced — `moltzap-ledger` is removed; Registry, Router, and `moltzapd` remain. | `docs/spec/layer-interfaces.md` — Public binaries | `ARCH` |
| G1-DEC-704 | Re-owned — export maps follow the seven final package owners; exact simulator-conflicting surfaces remain deferred. | `docs/spec/layer-interfaces.md` — Public exports; this ADR — Explicit deferrals | `ARCH`, `SIM`, `DEFER` |
| G1-DEC-705 | Retained — no cross-layer protocol/server/accessor package is introduced. | `docs/spec/layer-interfaces.md` — Package graph | `ARCH` |
| G1-DEC-706 | Replaced — all executable products live under `packages/*` and follow the final DAG. | `docs/spec/layer-interfaces.md` — Package graph and isolation | `ARCH` |
| G1-DEC-707 | Retained — packages expose cohesive domain capabilities and hide mechanisms. | `docs/architecture/components.md` — Deep-module rules | `ARCH` |
| G1-DEC-708 | Deferred — publication membership and coordinated versus independent package versioning are unselected. | `docs/spec/layer-interfaces.md` — Explicitly deferred | `ARCH`, `WIRE`, `DEFER` |
| G1-DEC-709 | Retained — MCP and simulator persisted-schema versions remain independent; package-version policy is deferred. | `docs/spec/layer-interfaces.md` — Version contract | `ARCH`, `DEFER` |
| G1-DEC-710 | Re-owned — Registry persistence retains its contract; central Ledger persistence is retired. | `docs/spec/identity.md` — Registry persistence; `docs/spec/layer-interfaces.md` — Removed services | `ARCH`, `ID`, `L3` |
| G1-DEC-711 | Re-owned — Registry concurrency evidence remains; central Ledger Testcontainers evidence retires. | `docs/spec/identity.md` — Registry persistence | `ID`, `L3` |
| G1-DEC-712 | Re-owned — Router remains volatile and Client owns endpoint state; pruning and disk-loss behavior are deferred. | `docs/spec/router.md` — Process model; `docs/spec/harness/daemon.md` — Endpoint state | `ARCH`, `L2`, `L3`, `DEFER` |
| G1-DEC-713 | Re-owned — the one final Simulator owns the kernel, EventCatalog, and simulation RunLedger. | `docs/spec/layer-interfaces.md` — Simulator | `SIM` |
| G1-DEC-714 | Re-owned — all compatible latest-main Simulator contracts remain; five authority conflicts are deferred. | `docs/architecture/first-implementation.md` — Simulator port; this ADR — Explicit deferrals | `SIM`, `DEFER` |
| G1-DEC-715 | Replaced — Simulator owns compatible stack fixtures and RunLedger remains separate; no testbed package exists. | `docs/spec/layer-interfaces.md` — Simulator | `SIM`, `ARCH` |
| G1-DEC-716 | Re-owned — obsolete testbed and v1 protocol surfaces are deleted without removing compatible simulator facilities. | `docs/architecture/first-implementation.md` — Removal boundary | `SIM`, `ARCH` |
| G1-DEC-717 | Retained — simulator migration uses a tracked landed-green source SHA. | `docs/architecture/first-implementation.md` — Simulator provenance | `SIM` |
| G1-DEC-718 | Resolved — one final simulator remains; no compatibility facade or second engine survives. | `docs/architecture/first-implementation.md` — Cutover | `SIM` |
| G1-DEC-719 | Replaced — no standalone testbed exists; Simulator owns process composition and root tooling owns artifact assembly. | `docs/spec/layer-interfaces.md` — Simulator; `docs/architecture/first-implementation.md` — Build ownership | `ARCH`, `SIM` |
| G1-DEC-720 | Retained — adapters and evals consume final public Client/Simulator capabilities, never internals. | `docs/architecture/first-implementation.md` — Boundaries | `INT`, `ARCH` |
| G1-DEC-721 | Re-owned — Identity and Router composition remains current and Client owns endpoint composition. | `docs/spec/layer-interfaces.md` — Construction handoffs | `ARCH`, `ID`, `L2` |
| G1-DEC-722 | Retained — Effect Schema remains the Identity and Router parse boundary. | `docs/spec/identity-representation.md`; `docs/spec/router-representation.md` | `ARCH`, `ID`, `L2`, `WIRE` |
| G1-DEC-800 | Retained deferral — Router replication, Byzantine sequencing, fork detection, and failover remain absent. | `docs/spec/router.md` — Explicitly deferred | `DEFER` |
| G1-DEC-801 | Retained deferral — malicious Registry tolerance and identity rotation/recovery remain absent. | `docs/spec/identity.md` — Explicitly deferred | `DEFER` |
| G1-DEC-802 | Resolved/reframed — no privileged L7 service will ship; later institution/governance vocabularies are ordinary task protocols. | `docs/spec/enforcement.md` — Recursive agents | `ARCH`, `DEFER` |
| G1-DEC-803 | Retained deferral — dynamic membership and changing-history authorization remain absent. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-804 | Re-owned — executable norms and non-unanimous **action** quorums remain deferred; the distinct storage quorum is resolved here. | `docs/spec/harness/tasks.md` — Explicitly deferred; `docs/spec/conversation-history.md` — Threshold and guarantee | `PROTO`, `L3`, `DEFER` |
| G1-DEC-805 | Retained deferral — fairness and starvation freedom remain unclaimed. | `docs/spec/harness/tasks.md` — Conditional liveness | `DEFER` |
| G1-DEC-806 | Partially resolved — any member may complete storage evidence; action recovery, pass/abort/renewal, and disputes remain deferred. | `docs/spec/conversation-history.md` — Vote dissemination and completion; `docs/spec/harness/tasks.md` and `docs/spec/harness/output.md` — Explicitly deferred | `L3`, `DEFER` |
| G1-DEC-807 | Re-owned deferral — portable personal-trust conformance remains unselected. | `docs/spec/harness/screening.md` — Explicitly deferred | `DEFER` |
| G1-DEC-808 | Retained deferral — local auth, hostile-host defense, dynamic ports, attachment, and universal supervision remain absent. | `docs/spec/harness/daemon.md` — Explicitly deferred | `DEFER` |
| G1-DEC-809 | Retained deferral — MCP replay, cursors, alternate push, async handles, and dynamic tools remain absent. | `docs/spec/harness/ingress.md`; `docs/spec/harness/output.md` — Explicitly deferred | `DEFER` |
| G1-DEC-810 | Re-owned deferral — evidence dissemination is required, but a transactional outbox mechanism is unselected. | `docs/spec/conversation-history.md` — Vote dissemination and completion | `L3`, `DEFER` |
| G1-DEC-811 | Retained deferral — later resource profiles remain absent; cross-conversation bounds follow the interface deferral. | `v2/VISION.md` — Open questions; `docs/spec/harness/client.md` — Explicitly deferred | `DEFER` |
| G1-DEC-812 | Retained deferral — binary/media action content remains absent. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-813 | Retained deferral — end-to-end encryption and key distribution remain optional future protocols. | `docs/spec/router.md` — Explicitly deferred | `DEFER` |
| G1-DEC-814 | Partially resolved — branch cutover and v1 retirement are current; publication, versioning, and deployment policy remain deferred. | This ADR — Daemon, package graph, and cutover; `docs/architecture/first-implementation.md` | `ARCH`, `DEFER` |
| G1-DEC-815 | Retained deferral — delegation evidence and peer-card custody remain absent. | `docs/spec/identity.md` — Explicitly deferred | `DEFER` |
| G1-DEC-816 | Re-owned — Router still provides no persistent replay; endpoint catch-up and quorum re-anchor are now required. | `docs/spec/router.md` — Explicitly deferred; `docs/spec/conversation-history.md` — Fixed-member catch-up and Router restart and re-anchoring | `L2`, `L3`, `DEFER` |
| G1-DEC-817 | Re-owned deferral — privileged observer reads and central replication retire; pruning, physical compression, and non-member disclosure remain constrained as above. | `docs/spec/conversation-history.md` — Canonical order and local persistence and Explicitly deferred; this ADR — Explicit deferrals | `L3`, `DEFER` |
| G1-DEC-818 | Retained deferral — remote daemon administration remains absent. | `docs/spec/management.md` — Explicitly deferred | `DEFER` |
| G1-DEC-819 | Deferred — cross-conversation context, concurrency, and bounds follow the unselected client-context contract. | `docs/spec/harness/client.md` — Explicitly deferred | `DEFER` |
| G1-DEC-820 | Reframed deferral — screening, testimony, institutions, and contacts may be ordinary task/trust protocols only. | `docs/spec/harness/screening.md` — Explicitly deferred | `DEFER` |
| G1-DEC-821 | Retained deferral — later action vocabularies, norm bundles, and dynamic action tools remain absent. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-822 | Resolved — no privileged monitor runtime/layer will ship; monitoring is an ordinary agent task. | `docs/spec/enforcement.md` — Recursive agents | `ARCH` |
| G1-DEC-823 | Retained deferral — FROST signature compression remains absent. | `docs/spec/harness/tasks.md` — Explicitly deferred | `DEFER` |
| G1-DEC-824 | Retained deferral — non-unanimous action certificates remain absent and are distinct from storage quorum. | `docs/spec/harness/tasks.md` — Action certification | `PROTO`, `DEFER` |

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
instead of maintaining shims. Interface, simulator, release, retention, and
disk-loss choices named as deferrals remain blockers for the code that would
embody them; they are not permission to guess.
