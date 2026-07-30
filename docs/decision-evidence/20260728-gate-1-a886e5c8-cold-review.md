# Blind decision review — Gate 1 candidate `a886e5c8`

This is a non-normative review record. The candidate failed because the
current Gate 1 contract does not classify the Registry's fault or trust
assumption. Preserve this attempt when a corrected candidate is reviewed.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `gate-1-a886e5c8-20260728` |
| Candidate commit | `40b236d771b216b9e6e117e536e74947e2efce8d` |
| Candidate tree | `a886e5c8270fb39f8bdc5d69d525f32b551d9644` |
| Candidate content digest | `git-tree-sha1:a886e5c8270fb39f8bdc5d69d525f32b551d9644` |
| Digest scope | All tracked and non-ignored untracked paths in the 939-file working candidate, including Git path, mode, symlink, and blob semantics |
| Digest command | Fresh temporary index: `git read-tree HEAD`, `git add -A`, then `git write-tree`, with `GIT_INDEX_FILE` set for all three commands |
| Reviewer-independent digest | `source-tree-sha256:3048f4691c651650caa2fb7814c73cba0c3f929791e0c30f32ac58fce3b0fddc` |
| Verbatim response digest | `sha256:033ab804eb6dceaa9216e23eebab02b6a2b0dc2849e64ec79c6afbeba46905a1` |
| Reviewer | fresh Codex agent `/root/cold_review_a886e5c8` |
| Reviewer session | `019fab0b-a5f9-78c3-a40b-8047288ff0a2` |
| Review started | `2026-07-28T23:24:55.379Z` |
| Review finished | `2026-07-28T23:41:35.183Z` |
| Review duration | 16 minutes, 39.804 seconds |
| Review budget | One uninterrupted fresh-agent context, maximum 45 minutes |
| Rerun of | none |
| Rerun reason | none |

The reviewer independently measured the candidate twice and reported the
same source-tree digest, 57 modified or deleted entries, and 15 untracked
entries both times.

## Fresh-context attestation

- [x] The reviewer did not author or reconcile the candidate decision.
- [x] The reviewer received no inherited conversation, summary, memory,
      private state, or earlier review output about the candidate.
- [x] The reviewer received only the candidate repository root and the six
      fixed questions.
- [x] The reviewer received no design summary, diff tour, ADR or file pointer,
      search term, expected answer, or answer key.
- [x] The reviewer navigated the repository independently using checked-in
      entry points, repository-native indexes, ordinary search, and history.
- [x] The reviewer did not ask the author for help or modify the candidate.
- [x] No author intervention occurred during the run.

The fresh agent was created with no forked turns. Its start and finish events,
session ID, prompt call, tool trail, and final answer are present in the
orchestrator's stored session. The reviewer reported the same isolation facts
in its answer.

## Prompt record

The exact submitted prompt has SHA-256
`c5e834134aa1df7ae141b6fb1cffe788e638efd4bc8c5efceadbb65d0d02191e`.
The display below redacts only the machine-local absolute repository path;
the six questions are unchanged.

```text
Candidate repository root: [machine-local path redacted]

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.
```

## Reviewer response — verbatim

{/* VERBATIM_RESPONSE_START */}
Overall result: **FAIL**. The design and lineage are largely discoverable, but the Gate 1 fault model never classifies the Identity Registry’s correctness or equivocation behavior, even though all L1 attribution guarantees depend on Registry-issued cards.

Candidate observed:

- HEAD: `40b236d771b216b9e6e117e536e74947e2efce8d`
- Source-tree SHA-256: `3048f4691c651650caa2fb7814c73cba0c3f929791e0c30f32ac58fce3b0fddc`
- Digest scope: every tracked and non-ignored untracked path, sorted, hashing each path, filesystem mode, and Git blob.
- State remained stable across two measurements: 57 modified/deleted entries and 15 untracked entries.
- No author intervention occurred.
- `git diff --check`, Mermaid validation, and broken-link validation passed.

## 1. Current decision

The candidate makes the repository-first Gate 1 architecture freeze current. It resolves the fact that earlier ADRs and normative pages described incompatible transports, layer ownership, identity, endpoint surfaces, and package layouts, while much of the intended design existed only in a review conversation.

The binding outcome is:

- Reconcile and land the full repository-native design on `main` before simulator landing, package scaffolding, or product implementation.
- Run independent Registry, Router, and Ledger processes plus one daemon per AgentId.
- Keep interpretation at endpoints.
- Make L1 immutable identity, L2 opaque globally ordered AgentId multicast, L3 endpoint reliability/certification plus mechanical Ledger commit, and L4 the built-in `OpenFloorV1`.
- Use one immutable X.509 AgentCard and Ed25519 key per AgentId.
- Use exact-versioned authenticated HTTP POST network operations with deterministic CBOR and bounded Router polling.
- Commit one self-contained canonical TranscriptRecord per certified action.
- Expose loopback MCP with exactly `start_conversation`, `reply`, and one turn-ready subscription.
- Use six deep packages and one Moltzap CalVer.
- Port one verified simulator kernel as an external system driver.
- Require source-event provenance and a candidate-bound blind review for ADR changes.

Authority and binding status are discoverable as follows:

1. `AGENTS.md` and `v2/VISION.md` are design law.
2. Current ADR `Decision Outcome` sections and explicitly retained `Supersession` scope are binding.
3. `docs/spec/` owns normative public interfaces and failure outcomes.
4. `docs/architecture/` is lower-authority orientation and execution guidance, except where the freeze explicitly assigns repository process, sequencing, persistence, or provenance ownership there.
5. ADR Context, Considered Options, and Consequences are historical explanation rather than current contract.
6. `docs/decision-evidence/` and `v2/inputs/` are non-normative evidence; `v2/drafts/` and superseded ADR bodies are historical input.
7. Sections explicitly labelled non-normative, such as control-plane persistence realization and layer-interface Effect realization, do not establish public compatibility requirements.

Verdict: **PASS**.

## 2. Earlier outcomes and current normative owners

Seven earlier outcomes are fully superseded:

- JSON-RPC interim control encoding → closed per-operation HTTP/CBOR.
- Interim request-signature profile → separate normal/bootstrap RFC 9421 profiles plus COSE message attribution.
- L7 policy attached to identity → separate L1 Registry and future L7 institutions.
- Firewall-as-generic-MCP-middleware → the concrete daemon/SharedCore boundary.
- MCP skill-bundle norms → built-in `OpenFloorV1` and legal-action descriptors.
- Protocol-package version → shared `v2/VERSION`.
- Registration outside the plane with one registered caller → a concrete pre-card Registry control operation.

Sixteen records retain only explicit scope:

- Network-as-router retains endpoint interpretation and removal of network app machinery; Ledger now owns Transcript storage.
- Native principal-shaped card remains; Gate 1 closes its fields and lifecycle.
- Physical control/data split remains; WebSocket and undecided data-plane language are replaced.
- Sessionlessness retains per-request authentication; durable replay/offline-convergence claims are replaced.
- One credential remains for normal operation; registration is the bootstrap exception.
- Top-level `v2/*` and zero-v1-import isolation remain; package layout is now fixed.
- X.509 remains the card container; “container-neutral/swappable” language is replaced.
- Separate data-plane/layer responsibility remains; conversation-aware L2 and Router-owned convergence are removed.
- Directory lookup serving complete cards remains; cards are immutable and contain no L7 facts.
- Eight layers and guarantee/configuration direction remain; L2/L3 and L1/L7 boundaries are narrowed.
- Testbed substitution/fault-injection remains; it is no longer an alternate production data plane.
- In-band START genesis remains; membership is fixed epoch 0 with no ADD/LEAVE.
- One endpoint-certified action becoming one atomic record remains; Ledger grant/policy enforcement is removed.
- Two directional endpoint crossings remain; generic send and norm-bundle tools are replaced.
- Self-contained message attribution remains; raw-byte signing is replaced by deterministic CBOR/COSE.
- Grant-before-generation, autonomous protocol mechanics, and endpoint validation remain; old Harness/Channel ports are replaced by daemon MCP.

Three earlier decisions remain accepted without semantic replacement:

- `AGENTS.md` is the instruction source.
- The spec set lives on `main`.
- Deterministic monitors versus attributed testimony remains future L6 design, with no Gate 1 monitor runtime.

Current normative ownership is discoverable through the freeze inventory:

- Layer and fault laws: `v2/VISION.md`, `docs/spec/layer-interfaces.md`, `docs/spec/enforcement.md`.
- Identity/authentication: `docs/spec/identity.md`, `docs/spec/cli.md`.
- Router: `docs/spec/data-plane.md`.
- Ledger/Transcript: `docs/spec/control-plane.md`.
- OpenFloor: `docs/spec/endpoints/tasks.md`.
- Daemon/MCP/model boundary: `docs/spec/endpoints/daemon.md` and `screening.md`.
- Packages/version: `docs/spec/layer-interfaces.md`.
- Simulator sequencing/provenance: `docs/architecture/first-implementation.md` and `v2/inputs/simulator-handoff-20260728.md`.

Verdict: **PASS**.

## 3. Implementation effects and assumptions

The required sequence is:

1. Land this reviewed freeze on `main`.
2. Produce and verify the immutable simulator source handoff.
3. Merge `main` forward into `v2` and scaffold only the six projects/manifests.
4. Accept `docs/spec/wire-profile.md`, its focused ADR, and two-implementation vectors.
5. Only then implement product, protocol, clients, servers, or the simulator port.

The principal implementation requirements are:

- L1: immutable Registry-attested X.509 cards, one Ed25519 key per AgentId, complete card lookup/list, pre-card registration with admission code and proof of possession, normal RFC 9421 authentication, no rotation/revocation.
- L2: one in-memory correct Router, explicit AgentId recipients, one global RouterSequence, byte-preserved opaque bodies, bounded 25-second polling, instance fencing, `feed_gap`, `router_restarted`, and `retry_identity_unknown`.
- L3: endpoints own protocol reliability and certification; Ledger accepts only author-submitted unanimous START/MULTICAST certificates, mechanically checks exact bindings/signatures, and atomically commits one canonical record.
- L4: fixed epoch-0 membership, START plus MULTICAST, unanimous START signatures, first-BEGIN-by-L2-order, unanimous ACK grant, separate final signatures, 90-second TTL, and no fairness/takeover/recovery protocol.
- MCP: one trusted-local daemon per AgentId at a stable loopback port; exact July 2026 core pin; POST-only discovery/tools/listen; exactly two tools; one listener; at-most-once attention; tool success only after Ledger commit.
- Packages: exactly identity, transport, transcript, endpoint, simulator, and testbed, with the recorded DAG, exports, binaries, and zero v1 imports.
- Simulator/testbed: one simulator kernel, `StackProvider` owned by simulator, production Live Layer supplied by testbed, and product Transcript kept separate from simulation RunLedger.
- Consumers: OpenClaw and NanoClaw supervise/use the daemon contract; propagation bench, arena, evals, and runtime integrations remain external consumers. V1 is not retrofitted and production publishing/cutover is deferred.

Discoverable assumptions include:

- Endpoints may be Byzantine.
- Router is assumed correct and non-equivocating.
- Ledger is assumed correct and durable.
- One honest required member prevents an invalid unanimous certificate; unanimously malicious certification is outside the guarantee.
- Safety is timing-independent.
- Timely progress requires Router, Ledger, every fixed member, and the author through append within the 90-second window.
- Any unavailable or withholding member may halt progress; no fairness is promised.
- Router restart fences old-instance conversations; a completed old-instance certificate may append once.
- Local host processes are trusted; local daemon authentication is absent.
- Network service operations require TLS.
- Attention is at-most-once and may be permanently lost after a committed watermark reservation.
- Moltzap compatibility is exact `v2/VERSION`; MCP and simulator persisted-schema versions are independent; no version negotiation or v1 compatibility exists inside `v2/*`.

The missing assumption is material: no current authority says whether the Identity Registry is assumed correct/non-equivocating, potentially Byzantine, or merely unavailable. Identity safety depends on its uniqueness, key binding, and attestation behavior. This cannot be inferred from the Router/Ledger assumptions.

Verdict: **FAIL**.

## 4. Source-event attribution

Every ADR names one accountable human: **Tapan Chugh**. The ledgers explicitly warn that a stored `user` role does not authenticate who controlled the session account and that `decision-makers` does not convert assistant prose into a human quotation.

The current Gate 1 trajectory cites Codex session `019fa633-abe3-7223-8c51-6d061f5c5855`, with native turn/event/timestamp locators and assistant message IDs where available. Its material calls are:

- Layer/fault boundary: user places reliability at L3, separates L1 and L7, selects L1-only network admission, selects the trusted Gate 1 sequencer/store assumption, and selects conditional per-protocol liveness.
- Identity: selects RFC 9421 option A, reverses to `defer`, then reverses back with `actually assume A and ocnitnue`; answers `out of band.` to the key-lifecycle question; selects cache option C; states registration is a control operation rather than data-plane traffic.
- Transcript: selects endpoint-certified storage, initially selects threshold/group certification, later selects COSE profiles, inline evidence plus possible compression, typed retry IDs, one canonical append, later recovery protocols, Gate 1 multisignatures with later dispute work, and defers transcript-read epoch policy.
- OpenFloor: selects fixed membership and conditional liveness, defers NormPin, states TTL-only is fine for Gate 1; `OpenFloorV1` and the complete flow appear in an assistant proposal.
- Network wire: selects typed retry IDs and closed schemas, says restart fencing is a future problem, requests HTTP POST polling, and separates owned network wire from local MCP.
- Daemon: reverses the earlier stdio shape to a long-lived HTTP MCP daemon, defers local-process security under a trusted-local assumption, and states only one adapter per daemon may own it.
- Model surface: selects shared mechanics/enforcement, states `start conversation` plus `reply` and no generic send, has a structured function output selecting action tools, then directly corrects that to “B shaped for now” with action-specific tools left for the future, and asks for pushed notifications.
- Packages/simulator: requests networking vernacular, Ousterhout-style deep modules, and building on the “stable-ish” simulator; the assistant proposes the exact six names; the user changes versioning to one shared version.
- Freeze/process: requires the complete plan and durable decision record to be reconciled in the repository for a cold reader, then replies `go` after the assistant plan; requests root ADR-process formalization, a blind teammate gate, compacted trajectories, and later corrects editorialization with “This is like git blame not a psychoanalysis.”

The current trajectory records twelve source-gap clusters:

1. Three-process topology, complete endpoint/Ledger boundary, and all stated safety consequences were assembled later.
2. Complete card fields, name rule, bootstrap schema, key handling, nonce persistence, and exclusions were not separately selected.
3. Exact certificate fields, signer checks, author-only append, ACID order, hash preimages, and ambiguous recovery were specified later.
4. No direct user event names OpenFloorV1 or accepts its complete flow, unanimity, 90-second value, or content union.
5. Exact HTTP paths, CBOR catalog, polling bound, cursor/gap/retry/instance details were assistant-authored.
6. MCP pin, discovery, errors, frames, ports, watermarks, loss semantics, and receipts were assistant-authored.
7. Exact notification schema, ID derivation, retry receipt/fingerprint, error set, and watermarks were assistant-authored.
8. Exact package names, DAG, ownership, exports, binaries, CalVer location, and independent-version exceptions were assistant-authored.
9. Simulator APIs, StackProvider ownership, RunLedger separation, SHA gate, testbed boundary, and exclusions were assistant-authored.
10. `go` did not separately approve every trace row, owner, evidence family, deferral, or later reconciliation.
11. Exact blind-review questions, duration, artifact fields, rerun rules, and PASS/FAIL rules were assistant-authored.
12. No later event approves the compactor’s exact excerpt/headings selection.

The older origins trajectory cites three Claude JSONL sessions, S1–S3, with UUID, parent UUID, prompt/request/message IDs, timestamps, stored roles, literal excerpts, and separate commit effects. It contains per-ADR evidence for the surviving router, instruction-source, card/X.509, plane split, sessionlessness, single-credential, top-level-v2, data-layering, spec-on-main, card-serving, eight-layer, testbed, lifecycle, collective, firewall-boundary, monitor, message-attribution, and grant-before-generation decisions.

It also records 22 explicit gaps: full removed-router machinery; package instruction mechanics; card projections; exact physical split; resumability/TTL details; credential consequences; the v2-layout reversal and branch mechanics; X.509 mappings; encoding consequences; exact data-plane guarantees; spec branch/review mechanics; directory cache behavior; exact layer guarantees/fault propagation; testbed equivalence details; nonce/freshness details; lifecycle verbs; the full collective profile; firewall implementation details; L7 cache/active-bit consequences; the exact monitor contract; norm digest/placement details; and direct selection of the old registration/operator-key outcome.

Verdict: **PASS**.

## 5. Adversarial consistency check

The strongest apparent historical contradiction is `20260724-l7-is-policy-attached-to-identity.md`, which says institutional facts are served with identity. It is correctly resolved:

- Its frontmatter is `superseded`.
- Its Supersession section states that L1 Registry and L7 institutions are separate services/trust domains.
- `20260728-layer-boundaries-and-fault-model.md`, `v2/VISION.md`, and `docs/spec/enforcement.md` own the current rule.
- The old body is historical only.

The same resolution applies to old WebSocket/JSON-RPC, generic-send, channel, MCP-skill-bundle, protocol-package, and Router-owned-Transcript language. Drafts and inputs are explicitly non-normative, and `docs/spec/endpoints/channels.md` is an explicit supersession stub.

The unresolved blocker is the Registry fault assumption:

- `AGENTS.md` and the Gate 1 freeze explicitly classify a correct Router, a correct durable Ledger, and Byzantine endpoints.
- `v2/VISION.md → Trust and failure envelope` adds availability effects but still does not classify Registry correctness.
- `docs/spec/identity.md` relies on Registry uniqueness, immutable card issuance, principal/key binding, and attestation.
- No current ADR or spec states what safety survives Registry equivocation or corruption.

This cannot be resolved by choosing a lower-authority interpretation. The current authority chain must either add a correct/non-equivocating Registry assumption and its availability consequences, or define the tolerated Registry fault behavior.

Verdict: **FAIL**.

## 6. Implementation readiness

A teammate cannot yet implement the full Gate 1 system without prohibited choices. The repository intentionally permits only the freeze and later project scaffolding before the exact byte contract.

Deliberate blocking prerequisites:

- The freeze must pass review and land on `main`.
- The simulator handoff remains `pending`, with landed SHA and evidence unset.
- `v2/VERSION` and the six package projects do not yet exist.
- Phase 2A must add and accept `docs/spec/wire-profile.md`.
- That catalog must assign AgentName grammar, identifier prefixes, X.509/OIDs, CBOR keys, COSE headers/contexts, all protocol message schemas and recipient sets, hash/ID preimages, retry-equality preimages, PollCursor representation, HTTP result/error mappings, and exact MCP JSON Schemas, with two independent vector implementations.

The 25 deliberate post-Gate-1 deferral groups are:

- G1-DEC-800: Router replication, Byzantine sequencing, fork detection.
- 801: key/card rotation, revocation, recovery, encrypted/external custody.
- 802: L7 institutions and governance effects.
- 803: dynamic membership and history authorization.
- 804: executable norms, NormPin, non-unanimous quorum, addressed turns.
- 805: fairness and starvation freedom.
- 806: append takeover, exact-attempt recovery, pass/abort/renewal, disputes.
- 807: portable semantic L5/contacts conformance.
- 808: local daemon authentication, hostile-host defense, discovery, universal supervision.
- 809: MCP acknowledgement/replay/cursors/GET/webhooks/resource wakeups/tasks/dynamic tools.
- 810: transactional commit-hint outbox.
- 811: protocol-negotiated resource maxima, with the documented unbounded exceptions.
- 812: raw bytes, media, files, images, audio, and metadata content.
- 813: required end-to-end encryption/key distribution.
- 814: publishing, deployment, cutover, v1 retrofit/retirement.
- 815: delegation evidence and peer-card custody.
- 816: persistent feeds, offline convergence, transparent Router restart, network push.
- 817: observer reads, Ledger replication, physical compression.
- 818: final CLI naming, interactive prompts, remote daemon administration.
- 819: daemon-wide concurrency caps and bounded cross-conversation snapshots.
- 820: semantic screening/testimony/institution/contact composition and portable L5 behavior.
- 821: post-Gate-1 vocabulary, distributed norms, per-action tools.
- 822: L6 monitor runtime.
- 823: FROST compression.
- 824: non-unanimous action certificates.

The accidental gap is the Registry trust/fault classification. The source-event gaps are provenance gaps, not permission for an implementer to reopen current ADR outcomes, but they require explicit maintainer review during admission.

Verdict: **FAIL**.

Final per-question result: **PASS, PASS, FAIL, PASS, FAIL, FAIL**. Overall: **FAIL; rerun with a different fresh reviewer after the Registry fault model and all affected trace/spec text are reconciled into a newly frozen candidate.**
{/* VERBATIM_RESPONSE_END */}

## Independently discovered evidence

These paths and headings are copied from the reviewer's answer. They were not
supplied in the prompt.

| Repository path | Heading or role discovered | What the reviewer used it to establish |
|---|---|---|
| `AGENTS.md` | ADR process, authority order, blind teammate gate | Binding hierarchy and review rules |
| `docs/decisions/README.md` | Canonical reading guidance and records | Current status, lineage, and entry points |
| `docs/decisions/20260728-gate-1-architecture-freeze.md` | Decision Outcome and manifest | Current Gate 1 decision inventory and owners |
| `v2/VISION.md` | Gate 1 profile; Trust and failure envelope | Constitutional layer and stated fault assumptions |
| `docs/spec/layer-interfaces.md` | Trust, safety, and progress | Normative fault, safety, and liveness contract |
| `docs/spec/identity.md` | AgentCard; Registration | Registry authority and the missing Registry fault assumption |
| `docs/spec/data-plane.md` | Router contract | L2 carrier and restart behavior |
| `docs/spec/control-plane.md` | Ledger and Transcript contract | Mechanical commit and acknowledgment semantics |
| `docs/spec/endpoints/daemon.md` | Daemon and MCP surface | Local endpoint model boundary |
| `docs/spec/endpoints/tasks.md` | OpenFloorV1 | Gate 1 L4 behavior |
| `docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md` | Gate 1 source-event groups | Calls, reversals, deferrals, and source gaps |
| `docs/decision-evidence/20260720-20260727-v2-design-origins-trajectory.md` | Origins source-event groups | Earlier calls and source gaps |
| `docs/architecture/first-implementation.md` | Sequenced implementation gates | Pre-code prerequisites |
| `v2/inputs/simulator-handoff-20260728.md` | Handoff status | Pending simulator prerequisite |

## Discovery trail

This is a concise record of the reviewer's stored tool trail, not a
retrospective ideal reading order.

| Order | Independent navigation step | Result |
|---:|---|---|
| 1 | Inspected working state, HEAD, recent history, and repository-native `AGENTS.md`, decision, evidence, and `v2` paths | Established the dirty candidate and found the decision index without a hint |
| 2 | Read `docs/decisions/README.md`, then the Gate 1 freeze and every new Gate 1 ADR | Identified the current decision set and authority owners |
| 3 | Read the Gate 1 trajectory in source order, then the origins trajectory and their source-gap blocks | Reconstructed calls, reversals, deferrals, attribution limits, and provenance gaps |
| 4 | Inspected every older ADR's status, `superseded-by`, and visible `Supersession` section | Distinguished retained scope from historical bodies |
| 5 | Read `v2/VISION.md`, the spec index, and the identity, data-plane, control-plane, layer, enforcement, CLI, daemon, task, and screening contracts | Built the implementation and guarantee model |
| 6 | Read `v2/AGENTS.md`, architecture pages, the simulator handoff, drafts index, and decision-evidence process files | Found sequencing, non-normative boundaries, and deliberate prerequisites |
| 7 | Searched current authorities for stale WebSocket, JSON-RPC, stdio, generic-send, attached-L7, threshold, norm-bundle, and channel language | Resolved matches through status, supersession, or historical/draft authority |
| 8 | Searched current authorities for TODO, pending, unresolved, open-question, and deferral language | Classified explicit prerequisites and `G1-DEC-800` through `824` |
| 9 | Searched specifically for Registry plus correct, trusted, Byzantine, malicious, compromised, fault, and equivocation terms | Found no current Registry fault classification and identified the blocker |
| 10 | Ran diff, Mermaid, and broken-link checks; counted manifest/status/provenance invariants; computed the candidate digest twice | Confirmed mechanical integrity and candidate stability |

No failed search was repaired with an author hint. The stale-language search
led to historical material that the reviewer resolved using the checked-in
authority order. The Registry-fault search remained unresolved.

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| none | none | none |

## Per-question disposition

| Question | Reviewer verdict | Maintainer-side check |
|---:|---|---|
| 1 | PASS | Accurate and independently discoverable |
| 2 | PASS | Accurate lineage and normative owners |
| 3 | FAIL | Registry fault/trust assumption is absent |
| 4 | PASS | Accurate attribution, reversals, deferrals, and source gaps |
| 5 | FAIL | Historical contradictions resolve, but the current Registry gap does not |
| 6 | FAIL | Deliberate prerequisites are classified; Registry behavior remains an accidental gap |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| `BR-001` | Gate 1 never states whether Registry is correct/non-equivocating, potentially Byzantine, or subject only to availability faults | `v2/VISION.md` → Gate 1 profile / Trust and failure envelope; `docs/decisions/20260728-layer-boundaries-and-fault-model.md` → Decision Outcome; `docs/spec/layer-interfaces.md` → Trust, safety, and progress; `docs/spec/identity.md` → AgentCard / Registration | Record the chosen Registry fault assumption and resulting safety/liveness behavior in the governing ADR, trace manifest, VISION, and normative specs; freeze a new candidate and use a different fresh reviewer |

## Overall result

Result: **FAIL**

The design, lineage, implementation surface, and source-event provenance are
largely discoverable. The missing Registry fault classification is a current
semantic gap rather than a recorded future deferral or an unassigned byte-level
wire detail. Under the root gate, one unresolved current contradiction or
binding choice blocks landing.

## Maintainer acceptance

| Field | Value |
|---|---|
| Maintainer | Pending human maintainer: Tapan Chugh |
| Reviewed result | `gate-1-a886e5c8-20260728` |
| Candidate identity matches | yes |
| Gate decision | `REJECTED` by the mandatory PASS/FAIL rule; human disposition pending |
| Decision time | `2026-07-28T23:41:35.271Z` |
| Rationale | Questions 3, 5, and 6 failed on one independently reproduced Registry fault-model gap |

This row records the mechanical gate outcome and does not claim that the named
human accepted it.

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `gate-1-8a58b135-20260728` |
| Superseded candidate commit | `40b236d771b216b9e6e117e536e74947e2efce8d` |
| Superseded candidate content digest | `git-tree-sha1:8a58b1353ad51e88c5c7f4af37ea8c640c452b15` |
| Reason a rerun is required | `BR-001` was reconciled, and a different fresh reviewer passed the corrected candidate |
