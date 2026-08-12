# Blind decision review record

Overall result: **FAIL**

The decision, lineage, normative contracts, assumptions, and source trajectory
are discoverable and internally coherent. The candidate is blocked by
unreconciled package-scoped agent instructions that remain active authority
while directing implementers toward the retired v1/profile/protocol/server
architecture.

## Review identity

| Field | Value |
|---|---|
| Review run ID | `20260812-021519Z-5e0376d-four-layer-blind` |
| Candidate branch | `cutover/four-layer-v2` |
| Candidate commit | `5e0376db6dc319e0aab5ec5aa6da008bd8a5513f` |
| Candidate tree | `ef1a36e26751442bce49a01747a5ef3570a6dd03` |
| Candidate content digest | `sha256:0ee3acb7fba811563089159362a67df6f5b8c1dc6e19df838f88b681db614152` |
| Digest scope and command | Complete candidate tree listing produced by `git ls-tree -r --full-tree HEAD \| sha256sum` |
| Parent commit | `637bc8e51559d22486a4a1496e5fe9a812282378` |
| Commit subject | `docs(v2): adopt four-layer endpoint history` |
| Reviewer | Codex teammate agent `/root/blind_candidate_review` |
| Reviewer session | `/root/blind_candidate_review` |
| Review started | `2026-08-12T02:15:19Z` |
| Review finished | `2026-08-12T02:22:27Z` |
| Review duration | 7 minutes 8 seconds |
| Review budget | One uninterrupted fresh context, below the 45-minute gate |
| Working tree | Clean; HEAD and tree remained unchanged |
| Rerun of | `_none_` |
| Rerun reason | `_none_` |

## Fresh-context attestation

The reviewer attests:

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited conversation, summary, memory, private state,
      or earlier blind-review output about the candidate.
- [x] I received only the clean candidate checkout and the fixed questions.
- [x] I received no out-of-band tour, decision or file pointer, search term,
      expected answer, or answer key.
- [x] I navigated the repository independently using checked-in entry points,
      repository-native indexes, ordinary search, and repository history.
- [x] I did not open, read, or search the contents of an earlier cold-review
      or invalid-review record. No answer or verdict from a quarantined record
      was returned. Engineering-review evidence inside candidate ADRs and
      trajectories was treated as ordinary evidence.
- [x] I did not ask the author for help or modify the candidate before
      submitting these answers.
- [x] The author interventions recorded below are complete.

The blind run finished before the instruction to record this artifact. That
later mechanical instruction did not alter the answers, verdicts, or
intervention record.

## Fixed questions and verbatim answers

The fixed questions live in
`.claude/skills/cold-read/references/questions.md`. The answers below are the
reviewer's unedited answers returned at the end of the run.

### 1

The candidate makes `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` current with status `accepted`. Its binding outcome is that MoltZap has four layers—Identity, Communication, Tasks and norms, and Personal trust—and that every fixed conversation member owns an independently stored replica of quorum-certified, hash-linked conversation history.

Registry remains the correct, non-equivocating identity control-plane service. Router remains the correct, non-equivocating, content-blind, volatile data-plane service. Endpoint daemons in `@moltzap/client` own conversations, action-certified records, durability voting, persistence, catch-up, Router-instance re-anchoring, tasks, norms, and personal trust. There is no product Ledger, Transcript service, global `LedgerOffset`, central conversation index, privileged institution/monitor/governance layer, profile system, or standalone testbed.

OpenFloorV1 action validity remains unanimous and separate from storage durability. Honest members durably stage the exact action-certified record before voting. For `n < 4`, all members vote; for `n >= 4`, `f = floor((n - 1) / 3)` and `n - f` votes complete durability evidence. Any member can assemble and disseminate the evidence. Under the stated fault bound, completion proves at least `n - 2f` honest staged replicas, not that every Byzantine signer retained bytes. Fixed members catch up verified history automatically, and a Router restart is recovered through threshold re-anchoring rather than central replay or permanent fencing.

The problem resolved is the eight-layer design’s unnecessary central Ledger and privileged monitoring, institutional, credential, and governance layers, together with duplicate implementation trees, profile-selected daemon machinery, and a separate testbed. The replacement preserves Identity, Router, OpenFloor validity, and independent verification while defining exactly what endpoint success proves in the presence of Byzantine peers.

Binding sources are, in authority order:

- `AGENTS.md` and `v2/VISION.md`, especially `The constitution`, `First executable profile`, and `Deliberate deferrals`;
- the accepted replacement ADR’s `Decision Outcome`, guarantees, negative implementation boundaries, and traceability dispositions;
- explicitly retained portions of partially superseded ADRs; and
- normative `docs/spec/` chapters, particularly `conversation-history.md`, `layer-interfaces.md`, `router.md`, `harness/tasks.md`, `harness/output.md`, `harness/client.md`, `harness/daemon.md`, `management.md`, `harness/ingress.md`, and `enforcement.md`.

The ADR’s `Context and Problem Statement` and `Consequences` explain the choice but are not independent normative owners. Architecture plans and handoffs are orientation. The cited trajectory is non-normative evidence. Historical ADR bodies bind only to the extent their visible `Supersession` sections retain them.

Independently discovered paths and headings:

- `AGENTS.md` → `Project`, `Decisions`, `Docs`
- `v2/VISION.md` → `The constitution`, `First executable profile`, `Deliberate deferrals`
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → `Context and Problem Statement`, `Decision Outcome`, `Guarantees and progress assumptions`
- `docs/spec/README.md` → `Authority and reading order`, `Implementation readiness`
- `docs/spec/conversation-history.md` → `Purpose and owner`, `Threshold and guarantee`

### 2

It fully supersedes `20260721-v2-lives-top-level.md`: no current scope remains for a permanent top-level `v2/*` implementation workspace, six clean-slate roots, or permanent zero-import branch isolation.

It partially supersedes 26 other ADRs. The principal replacements are:

- eight layers and two trust regions become four layers;
- the correct central Ledger, Transcript service, global offsets, one canonical store, author-only append, and immediate all-member readability are replaced by endpoint staging, separate durability votes, local certified success, any-member completion, and verified catch-up;
- privileged monitor, institution, revocable-credential, and governance layers become ordinary agents, signed content, tasks, norms, and local trust decisions;
- six `@moltzap/v2-*` packages and shared CalVer become exactly seven final `packages/*` products, while publication/version policy remains deferred;
- profile slots, profile files, split registration/active MCP paths, dual backings, CLI/socket machinery, and `v2/harness` become one explicitly configured state directory and one state-dependent `/mcp`;
- the standalone testbed is removed and compatible system-driver responsibilities remain in Simulator;
- Ledger recovery and permanent Router-restart fencing become endpoint catch-up and quorum re-anchoring;
- routine main-to-v2 forward merges stop after one pinned final integration.

The retained outcomes include:

- endpoint interpretation and a content-blind Router;
- independent Registry and Router network services and a local MCP boundary;
- immutable cryptographic identity, Registry bootstrap admission, authenticated HTTP, exact Identity/Router representations, limits, routes, and typed failures;
- OpenFloorV1 fixed membership, START/MULTICAST, unanimous action certification, Router-order contention, and the 90-second volatile TTL;
- START with initial content, bound reply, listen, no generic send, and separation of durable content from live reply authority;
- one daemon representing at most one AgentId and the retained modern MCP framing;
- local personal-trust decisions and the deterministic-finding versus attributed-testimony distinction;
- deep package boundaries and production packages not depending on simulator/evals;
- the non-conflicting Simulator `RunSpec`, `Run.execute`, Kubernetes execution, EventCatalog, and simulation `RunLedger`;
- repository-native authority, stable `G1-DEC-NNN` lineage, and the blind-review gate.

Unmodified accepted Identity/Router representation, registration, capability-depth, and fixed-limit decisions remain untouched unless a visible supersession says otherwise. The old Gate 1 manifest is now a historical snapshot for affected rows; the replacement ADR’s trace table owns their current dispositions and normative owners. Unlisted rows continue through their existing ADR lineage.

The current contract lives in `AGENTS.md`, `v2/VISION.md`, the replacement ADR, its trace table, and the named normative specification chapters. Architecture pages only orient execution, and evidence/historical inputs do not govern implementation.

Independently discovered paths and headings:

- `docs/decisions/README.md` → `Canonical reading guidance`, `Records`
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → `Gate 1 traceability disposition`
- The 27 earlier records’ visible `Supersession` sections
- `docs/spec/layer-interfaces.md` → `Exact package graph`, `Relocation and deletion law`

### 3

An implementer must:

- establish exactly seven products and the stated DAG: Identity; Router→Identity; Client→Identity+Router; OpenClaw/NanoClaw→Client; Simulator→Identity+Router+Client; Evals→Client+Simulator;
- relocate the accepted Identity and Router implementations intact to `packages/identity` and `packages/router`, preserving bytes, authentication, routes, bounds, errors, migrations, tests, and process behavior;
- implement endpoint-owned certified history in Client: canonical hash-linked records, atomic staging/promotion, separate action and durability certificates, mergeable votes, any-member completion, verified fixed-member catch-up, and threshold Router re-anchoring;
- make `moltzapd` one explicitly configured per-state-directory daemon with one state-dependent loopback `/mcp`;
- preserve START with initial content, bound reply, transient listen, and the separation between certified content and live reply authority;
- keep monitoring, institutions, claims, audits, and governance on ordinary agent/task/norm/trust paths;
- preserve compatible simulator/eval behavior and keep simulation `RunLedger` distinct from product history;
- pin `eslint-plugin-agent-code-guard` `0.0.21` and enable the three named readability rules;
- delete displaced protocol/server/Ledger/Transcript/profile/CLI/socket/testbed/v2 implementation and compatibility machinery as final owners become usable.

An implementer must avoid:

- putting conversations, persistence, task meaning, trust, institutions, or recovery in Router or Registry;
- treating durability votes as action approval;
- voting before durable staging, lowering a threshold, guessing ancestry, or accepting incomplete/invalid evidence for liveness;
- making completion author-owned;
- creating reply authority from history, catch-up, certificate enrichment, or re-anchor;
- exposing generic send, raw Router credentials, signing keys, stores, profile selection, compatibility aliases, or privileged history readers;
- implementing a deferred Client or simulator choice through an inert field, lazy translation, hidden fallback, or reinterpretation of an existing persisted tag.

Affected layers and consumers are all four conceptual layers, Registry and Router process composition, Client and daemon storage/protocols, OpenClaw, NanoClaw, Simulator, Evals, workspace tooling, documentation, packaging, and release automation.

The assumptions are:

- one correct, non-equivocating Registry; malicious/equivocating Registry behavior is outside the identity guarantee;
- one correct, non-equivocating but availability-fallible and restartable Router; Byzantine ordering, replication, and transparent failover are not claimed;
- endpoints may be Byzantine;
- for `n >= 4`, at most `f = floor((n - 1) / 3)` Byzantine fixed members and honest stage-before-sign/non-double-vote behavior;
- for `n < 4`, all-member completion and zero Byzantine members for the replicated-storage guarantee;
- unanimous OpenFloor action validity, so one honest required signer can prevent invalid certification, while all-malicious membership is outside that guarantee;
- timing-independent safety;
- progress requires applicable identity material, Router availability, every required action signer, the durability or re-anchor threshold, and an honest reachable holder of missing ancestry;
- Registry outage blocks registration and uncached resolution; Router outage blocks new delivery/evidence exchange; quorum or ancestry unavailability blocks completion; certified local history remains readable and verifiable;
- signatures attest but do not prove continuing byte retention or disk-loss recovery.

Compatibility preserves exact Identity/Router behavior and every non-conflicting latest-main Simulator contract. The five simulator conflicts and final Client interface are blocked. No compatibility package names or forwarding facades are allowed. npm remains main-owned until publication/release cutover is separately admitted.

Independently discovered paths and headings:

- `docs/spec/conversation-history.md` → staging, durability, catch-up, re-anchoring, retry, and fault matrix
- `docs/spec/layer-interfaces.md` → package graph, cross-layer laws, simulator conflicts
- `docs/spec/harness/tasks.md` → action certification, durability completion, conditional liveness
- `docs/spec/harness/daemon.md` → process configuration, fault and trust assumptions
- `docs/architecture/first-implementation.md` → lanes 0–7 and final gate

### 4

The ADR names one human decision-maker: `Tapan Chugh`.

The trajectory identifies source system `Codex CLI rollout JSONL`, source session `019fd899-779c-7e70-a8e4-338727b13e6c`, and source file `rollout-2026-08-06T12-42-44-019fd899-779c-7e70-a8e4-338727b13e6c.jsonl`.

The retained decision sequence is:

- `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d`, `2026-08-11T17:56:38.308Z`, stored role `user`: requests simplifying eight layers; removing the Ledger, monitoring, and revocable credentials as large layers; giving participants their own conversation-history copies; and making institutions, governance, private-history queries, and reconciliation recursive agent/task behavior.
- Planning pair `fc_0fe7c1dd2e31cd97016a7b62f6d1fc8193bdf9d9e0b4554507` / `fco_019ff1fd-87dc-7d03-b333-6f3bedf1e0d0`: rejects the presented three-capability/runtime/history alternatives and states “keep the layering,” “simplify but don't change too much,” and “the semantics should not change.”
- Pair `fc_0fe7c1dd2e31cd97016a7b63d625988193baa357dc6a96d425` / `fco_019ff200-fdb0-74b0-8757-b52ea4edd1f3`: selects five layers, asks for a shared BFT-like quorum with catch-up/reconciliation, and preserves the split runtime/management surface.
- Pair `fc_0fe7c1dd2e31cd97016a7b64c1c3e48193b79637c3edf767ee` / `fco_019ff202-7769-7af0-9a5e-d60e38fd8567`: selects a trusted Router, fixed one-third conversation threshold with all members for `n < 4`, and any-member finalization.
- Pair `fc_0fe7c1dd2e31cd97016a7b653f727c81938c108ca73627c1d2` / `fco_019ff204-876c-71f0-aac3-361b40a1bd51`: selects a local record proof, automatic member catch-up, and merging main first; its note suggests merging L2 and L3.
- Pair `fc_0fe7c1dd2e31cd97016a7b65c1e660819395c7eecd5b191af4` / `fco_019ff206-4451-78f3-8be3-30888ac565c7`: selects four layers, replacing the earlier five-layer answer; also selects API cleanup and authority/spec before implementation.
- Pair `fc_0fe7c1dd2e31cd97016a7b6627e62c81938dab3c1f7cfcff89` / `fco_019ff209-a6a4-7d93-b543-45caf6a9445a`: selects separate action and durability certificates and questions retaining profiles and old Client code.
- `msg_019ff209-a6b4-7660-bb73-0d7fc7fa1938`, `2026-08-11T18:15:46.612Z`, stored role `user`: directs starting v1 removal on the v2 branch.
- Pair `fc_0fe7c1dd2e31cd97016a7b6746dd74819386b22a7bcd6b2bde` / `fco_019ff20c-30c7-75d3-894f-9c03246acaee`: selects explicit daemon process configuration, `@moltzap/client`, and an all-v1-package cutover.
- Pair `fc_0fe7c1dd2e31cd97016a7b67c36258819396b8f765476e50a3` / `fco_019ff20f-00b2-77c1-952d-01680dbfbf52`: directs everything into `packages/*`, selects final non-v2 names and `HarnessClient`.
- Pair `fc_0fe7c1dd2e31cd97016a7b68723cb08193866b8a1589f44928` / `fco_019ff210-2654-71b3-b959-34c93e655183`: aborted; the ledger explicitly infers no selection.
- Pair `fc_0fe7c1dd2e31cd97016a7b6890ab4481938e5fa766cb103d98` / `fco_019ff211-9d26-7051-986b-267c722b6286`: selects freezing forward merges and landing PR #974 first; the simulator note asks for minimal v2 changes and says its API should not change.
- Pair `fc_0fe7c1dd2e31cd97016a7b692b46b8819390fad670bd984ca3` / `fco_019ff213-9fe0-7ea0-8e57-458b9727fc70`: selects quorum re-anchoring, a long-lived cutover branch, and blockers-only PR #974 cleanup.
- `msg_019ff20f-0112-7c11-820b-8b4933270d85` requests the latest ACG; assistant event `msg_0fe7c1dd2e31cd97016a7b6852085c81938648c56d41d8b0c3` recommends enabling three rules; user event `msg_019ff210-429e-7912-8d33-b80c7b409d53` answers “enable” and says “I don't think we have testbed anymore.” The ledger does not strengthen that hedge by itself; the later adopted plan expressly removes testbed.
- Assistant event `msg_0fe7c1dd2e31cd97016a7b698cc8448193a837b65a5efb21f9` records the proposed cutover plan. User event `msg_019ff231-e57a-7323-a0a3-c98c9b10ff22`, `2026-08-11T18:59:44.122Z`, says to set that plan as the goal, store it durably, and start shipping. The ledger says this adopts the execution goal, not an ADR, blind-review result, or final public interface.
- Registry-recovery events record a later correction and deferral: `msg_019ff259-becc-7400-9b3f-243c73c30dd4` accepts the immediately preceding narrow activation-retry proposal; `msg_019ff2a0-6576-7172-8c6b-e32415d4ede2` answers that changed `inviteCode` or `description` should be a failure; `msg_019ff2a1-23e6-7f90-b627-7df2faa176b6` directs skipping the remaining Registry fight, opening an issue, and continuing the cutover. The ledger states that this does not answer the separate first recovery item. Mechanical effects record issue #984.

Explicit source limitations are:

- session metadata does not identify the human using the session;
- planning function calls/results have no stored actor role or parent-message field;
- retained response events supply enclosing turns but no parent locator;
- the initial “ledger” wording is ambiguous and does not name record type, threshold, API, or disclosure protocol;
- the five-layer answer is preserved and explicitly replaced by the later four-layer selection;
- the aborted prompt supplies no decision;
- the plan is assistant-authored, and the human adoption does not itself admit an ADR;
- some plan details are marked as omitted in the compaction;
- item 1 of the later Registry recovery prompt remains unanswered;
- hidden reasoning, private research, unrelated workflow, secrets, private paths, and authentication-bound URLs were omitted as stated.

The trajectory does not claim that the source session account is Tapan Chugh. The ADR separately names Tapan Chugh as the accountable decision-maker, consistent with the repository rule that `decision-makers` does not itself prove source-account authorship.

Independently discovered paths and headings:

- `docs/decision-evidence/20260811-four-layer-v2-cutover-trajectory.md` → `Source record and compaction method`
- The same trajectory → `Four layers and recursive trust features`, `Planning UI questions and selections`, `v1 retirement and the adopted cutover goal`, `Readability ratchet and testbed removal`, `Registry recovery correction and deferral`
- Replacement ADR frontmatter and `Decision provenance`

### 5

The strongest contradiction is in the live package-scoped agent instructions.

Root `AGENTS.md` says that `packages/*/AGENTS.md` adds package-specific agent law. These files are therefore active instructions, not ordinary source-code archaeology. Their adjacent `CLAUDE.md` files are live symlinks to them.

However:

- `packages/client/AGENTS.md` directs use of `MoltZapAgentClient`, `MoltZapService`, `MoltZapChannelCore`, `@moltzap/protocol/socket`, `channel-base`, a CLI, and multiple public subpaths. The current ADR/spec requires one final Client root around `HarnessClient`, no protocol proxy, no compatibility roots, no CLI/socket/profile machinery, and deletion of the replaced Client implementation.
- `packages/openclaw-channel/AGENTS.md` makes an account ID a profile name, directs `@moltzap/protocol` notifications, `core.sendReply`, service Unix sockets, and server-core integration. Current authority requires no profiles, no generic send, no Unix socket, and an adapter that consumes Client only.
- `packages/nanoclaw-channel/AGENTS.md` treats protocol wire compatibility and `MoltZapChannelCore` as its boundary rather than Client-only consumption.
- `packages/protocol/AGENTS.md` and `packages/server/AGENTS.md` instruct agents how to add RPCs, handlers, middleware, and server behavior to packages the accepted decision orders deleted.
- `packages/simulator/AGENTS.md` retains legacy network endpoint/socket directions without marking the five authority-bearing conflicts as blocked.

Unlike the historical architecture slates, these files carry no historical/superseded banner or instruction to stop and follow the cutover authority. The contradiction cannot be safely resolved merely by silently preferring root text: both sides are agent law, and root explicitly characterizes package files as additive specifics. `docs/spec/README.md → Authority and reading order` also says an authority/spec conflict is a documentation defect and implementation stops until reconciliation.

This is a blocker.

The historical `docs/architecture/harness-implementation-slate.md` and `l1-l2-implementation-ask.md` contain similarly obsolete profile/Ledger/six-package instructions, but their top banners explicitly mark them historical, non-normative, and superseded. Those are correctly resolved by the authority order and are not blockers.

Independently discovered paths and headings:

- Root `AGENTS.md` opening scope statement and `Implementation rules`
- `packages/client/AGENTS.md` → `Structure`, `Concepts`
- `packages/openclaw-channel/AGENTS.md` → `Concepts`, `Code`
- `packages/nanoclaw-channel/AGENTS.md` → package boundary and `Code`
- `packages/protocol/AGENTS.md` and `packages/server/AGENTS.md` → active package instructions
- `packages/simulator/AGENTS.md` → `Boundary`, `Laws`, `Structure`
- `docs/architecture/harness-implementation-slate.md` and `l1-l2-implementation-ask.md` → historical/superseded status banners

### 6

A teammate can implement the explicitly ready Identity relocation, Router relocation, structural seven-package graph work, and removal of obsolete Transcript/testbed scaffolds from repository authority alone. They cannot safely execute the complete cutover yet.

All technical unresolved choices below are explicitly classified as deliberate deferrals:

- start-operation identity, interruption, restart, changed-input conflict, ambiguous completion, and the named recovery operation;
- current-conversation-only versus universal cross-conversation turn context, including selection, trust filtering, bounds, checkpoints, crash windows, and recovery;
- complete `CertifiedRecord` versus compact receipt plus a named proof-retrieval operation;
- MCP-only versus TypeScript `HarnessClient` search/history methods;
- exact Client method names, turn fields, request/result/error types, acquisition ergonomics, and raw MCP representations dependent on those four choices;
- exact registration-recovery status/errors, daemon configuration DTO/environment spelling, and state-file layout;
- search ordering, ranking, empty-query behavior, pagination, projections, page sizes, totals, and full-text behavior;
- the five simulator conflicts: content-free open, generic send, message-only receive/results, runtime Router credentials/attachment, and persisted Router-commit/order evidence;
- final publication membership, coordinated versus independent package versions, release ordering, deployment cutover, and external-consumer compatibility treatment;
- pruning, garbage collection, retention, compaction, alternate catch-up transports, and recovery after local disk loss;
- malicious/replicated Registry or Router profiles, Router consensus/failover, identity rotation/recovery/delegation/peer-card custody, and mandatory encryption/key distribution;
- dynamic membership, non-unanimous action certificates, addressed turns, fairness, pass/abort/renewal/takeover/disputes, richer norm vocabularies, plural-action payload mapping, and binary/media content;
- public observers, non-member audit/disclosure protocols, institutional claim/revocation/governance protocols, monitor publication, appeals, and portable trust policy;
- hostile-host/local daemon authentication, dynamic ports/attachment, remote administration, universal supervision, daemon-wide resource/queue limits, resumable subscriptions, replay, alternate push, and asynchronous task handles.

These deferrals are well marked and tell an implementer where to stop; they are not accidental omissions.

The accidental gap is the unreconciled active `packages/*/AGENTS.md` instruction set described in answer 5. Because those scoped instructions conflict with the accepted target and do not identify themselves as retiring-source guidance, a teammate must guess whether local agent law or the cutover law controls. That prevents implementation without chat or reconciliation.

Independently discovered paths and headings:

- `v2/VISION.md` → `Deliberate deferrals`
- Replacement ADR → `Explicit deferrals and implementation boundary`
- `docs/spec/README.md` → `Implementation readiness`, `Deliberate interface deferrals`
- `docs/spec/harness/client.md` → `Deliberate interface gates`
- `docs/spec/layer-interfaces.md` → `Simulator preservation and blocked conflicts`, `Deliberate deferrals`
- Active `packages/*/AGENTS.md` instruction set from answer 5

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Inspected repository identity, clean status, HEAD history, and HEAD changed-file map | Candidate commit and changed-file inventory | Found the accepted candidate commit and new ADR without an out-of-band pointer. |
| 2 | Read root agent law and the required checked-in decisions skill | `AGENTS.md`; `.claude/skills/decisions/SKILL.md` → `Blind review gate` | Established authority order, provenance rules, and quarantine. |
| 3 | Followed the repository-native entry points | `v2/VISION.md`; `docs/decisions/README.md` | Found the current replacement ADR. |
| 4 | Read the ADR and followed its four provenance links | `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md`; four headings in the trajectory | Reconstructed the human selections, reversal, adoption, and deferrals. |
| 5 | Followed trace-table normative owners | `docs/spec/` semantic chapters | Verified history, package, daemon, task, trust, fault, liveness, and compatibility contracts. |
| 6 | Extracted all modified ADR statuses and `Supersession` sections | 27 earlier ADRs | Verified one full and 26 partial supersessions. |
| 7 | Searched current specs and architecture for stale Ledger/profile/eight-layer/six-package language | Historical architecture slates | Their top banners correctly quarantined the preserved stale body text. |
| 8 | Inspected active nested package instructions | `packages/*/AGENTS.md` and adjacent `CLAUDE.md` symlinks | Found the unresolved authority contradiction. |
| 9 | Ran the pre-screened ADR shape checker and rechecked candidate identity/status | `scripts/docs/adr/check-shape.ts` | 55 ADRs mechanically passed; candidate remained clean and unchanged. |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| `_none_` | `_none_` | `_none_` |

## Per-question verdicts

| Question | Verdict | Reason |
|---:|---|---|
| 1 | PASS | Current outcome, problem, authority order, and binding/non-binding distinction are accurate and discoverable. |
| 2 | PASS | Status, full/partial supersession, retained scope, trace ownership, and normative destinations are explicit. |
| 3 | PASS | Implementation obligations, prohibitions, consumers, fault bounds, safety/liveness, and compatibility gates are explicit. |
| 4 | PASS | Human name, native source locators, selections, reversal, aborted prompt, adoption, correction, deferral, and source limitations are discoverable without inferred motives. |
| 5 | FAIL | Active package-scoped agent law contradicts the accepted architecture and is not marked historical or superseded. |
| 6 | FAIL | Deliberate technical deferrals are well classified, but the active package-instruction conflict is an accidental gap requiring guessing. |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| B-1 | Active package-scoped agent law directs work toward retired profiles, protocol/server packages, generic/raw send surfaces, Unix sockets, and legacy Client boundaries. | Root `AGENTS.md` says package AGENTS add active specifics; `packages/client/AGENTS.md`, adapter AGENTS, protocol/server AGENTS, and their live `CLAUDE.md` symlinks conflict with the replacement ADR and normative specs. | Update surviving package instructions to the current cutover boundary and mark retiring protocol/server instructions as deletion-only historical guidance, or remove them with an explicitly reproducible candidate change. Clarify local/root precedence so no agent must guess. Freeze a new candidate and use a different fresh reviewer. |

## Overall result

Result: **FAIL**

The architecture decision itself is unusually well traced: the current
outcome, supersession map, assumptions, normative ownership, implementation
gates, and event attribution are discoverable. The candidate cannot pass while
active package-scoped agent instructions contradict that authority.

## Maintainer acceptance

The reviewer result is evidence, not self-certifying acceptance. The
maintainer verifies that it applies to the exact candidate identity above and
records the gate decision.

| Field | Value |
|---|---|
| Maintainer | `_pending_` |
| Reviewed result | `20260812-021519Z-5e0376d-four-layer-blind` |
| Candidate identity matches | `_pending_` |
| Gate decision | `_pending_` |
| Decision time | `_pending_` |
| Rationale | `_pending_` |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `_none_` |
| Superseded candidate commit | `_none_` |
| Superseded candidate content digest | `_none_` |
| Reason a rerun was required | `_none yet; blocker B-1 requires reconciliation before a fresh candidate review_` |
