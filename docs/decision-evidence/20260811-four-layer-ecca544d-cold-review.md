# Blind teammate review report

## Candidate identity

- Repository: `/home/tapanc/moltzap-v2-cutover`
- Branch: `cutover/four-layer-v2`
- HEAD: `ecca544d33ec8cbe60dd096d58a73f402f783268`
- Commit: `docs(v2): repair cutover trace owner`
- Worktree: clean and aligned with `origin/cutover/four-layer-v2`
- Current decision discovered through the repository index: `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md`, status `accepted`

## Reviewer and isolation

Reviewer: fresh Codex teammate agent `/root/blind_candidate_review_four`.

I received only the candidate repository root, current-HEAD instruction, fixed six questions, quarantine rules, and time box. I received no author conversation, design summary, diff tour, file pointer, expected answer, prior review result, or private state. I did not ask for or receive an author hint.

I loaded the repository-required `decisions` and `cold-read` procedures from `.claude/skills/`. I did not open, read, or search any `*-cold-review.md` or `*-invalid-review.md`. A `git show --stat` displayed two quarantined artifact pathnames without their contents; this is permitted by the quarantine rule. No command returned an answer or verdict from a quarantined record.

- Start: `2026-08-12T03:03:17Z`
- End: `2026-08-12T03:09:48Z`
- Duration: 6 minutes 31 seconds
- Author interventions: none

## Six numbered answers

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate makes current a four-layer product architecture:

1. Identity
2. Communication, combining opaque Router delivery with endpoint-owned conversations and certified replicated history
3. Tasks and norms
4. Personal trust

Each fixed conversation member owns an independently stored, hash-linked copy of quorum-certified history. There is no central product Ledger, Transcript service, global `LedgerOffset`, central conversation index, privileged monitor/institution/governance layer, profile system, or standalone testbed product.

It resolves the oversized eight-layer Gate 1 design and its reliance on a trusted central Ledger while preserving immutable identity, a correct non-equivocating Router, unanimous `OpenFloorV1` action validity, independent verification, durable conversation history, Byzantine-endpoint assumptions, catch-up, and Router-restart recovery.

Binding material is discoverable in this order:

- `AGENTS.md` and `v2/VISION.md`, especially `Authority`, `The constitution`, and `Deliberate deferrals`;
- the accepted ADR’s `Decision Outcome`, `Guarantees and progress assumptions`, `Explicit deferrals and implementation boundary`, and `Gate 1 traceability disposition`;
- explicitly retained portions of partially superseded ADRs; and
- the normative `docs/spec/` chapters.

The ADR index states that ADR context, considered options, consequences, and implementation examples are historical explanation rather than independent authority. The trajectory is explicitly non-normative source evidence. `docs/architecture/` is orientation and execution material. The ADR’s record changelog records a point correction and does not change the outcome.

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

The index and predecessor frontmatter expose 27 direct predecessor records: one fully superseded record, `20260721-v2-lives-top-level.md`, and 26 partially superseded records.

The affected lineage comprises:

- Stack, network, history, and trust: `20260720-the-network-is-a-router.md`, `20260721-physical-plane-split.md`, `20260722-data-plane-layering.md`, `20260723-eight-layer-stack.md`, `20260723-lifecycle-rides-l3.md`, `20260724-collectives-are-ledger-transactions.md`, `20260724-firewall-two-directions.md`, `20260724-monitors-are-deterministic-contracts.md`, `20260728-layer-boundaries-and-fault-model.md`, `20260728-network-wire-is-http-post-polling.md`, `20260728-open-floor-v1.md`, `20260728-transcript-is-mechanical-atomic-commit.md`, and `20260729-router-order-is-opaque.md`.
- Daemon and runtime interface: `20260728-endpoint-daemon-speaks-modern-mcp.md`, `20260728-model-surface-is-start-reply-listen.md`, `20260801-harness-client-owns-runtime-context.md`, `20260801-harness-is-one-profile-slot-daemon.md`, `20260801-inbound-notifications-separate-content-from-grants.md`, and `20260801-model-output-is-start-or-bound-reply.md`.
- Packages, branch authority, and simulation: `20260721-v2-lives-top-level.md`, `20260723-eval-plane-is-testbed.md`, `20260727-code-first-simulator-kernel.md`, `20260728-gate-1-architecture-freeze.md`, `20260728-simulator-is-the-system-driver.md`, `20260728-six-deep-packages-one-version.md`, `20260729-v2-authority-lives-with-v2.md`, and `20260801-main-simulator-runs-container-societies-on-kubernetes.md`.

The replacement changes:

- eight layers and two regions to four layers;
- central Ledger atomic commit to endpoint staging, separate durability votes, threshold evidence, local success, and verified catch-up;
- permanent Router-restart fencing to quorum re-anchoring;
- profiles, dual backings, split registration/active MCP paths, bespoke CLI/socket machinery, and testbed ownership to one explicitly configured daemon and one `/mcp`;
- six `v2/*` packages to seven final `packages/*` products;
- routine main-to-v2 merges to one pinned integration followed by deliberate ports.

It retains:

- endpoint interpretation and content-blind Router boundaries;
- correct, non-equivocating Registry and Router assumptions;
- immutable AgentCards, Ed25519 identity, bootstrap admission, authenticated HTTP, and current Identity/Router wire contracts;
- fixed membership, atomic START with initial content, unanimous `OpenFloorV1` action certification, contention, TTL, and bound reply;
- one daemon per AgentId, trusted loopback MCP framing, and `HarnessClient` as the adapter-facing capability;
- deep package ownership and separation of simulator `RunLedger` from product history;
- non-conflicting current simulator behavior.

Current normative ownership is explicit: `v2/VISION.md` for the constitution; `docs/spec/conversation-history.md` for records, durability, catch-up, and re-anchor; `docs/spec/layer-interfaces.md` for packages and cross-layer laws; `docs/spec/router.md` and the Identity/Router representation chapters for retained network contracts; `docs/spec/harness/*` for tasks, daemon, ingress, output, Client, and trust boundaries; and `docs/spec/enforcement.md` for ordinary-agent monitoring and institutions.

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- establish exactly seven packages with the dependency graph recorded in the ADR and `docs/spec/layer-interfaces.md`;
- move accepted Identity and Router implementations into `packages/identity` and `packages/router` without changing their admitted bytes, authentication, limits, errors, migrations, or process behavior;
- place conversation records, endpoint storage, task/norm folds, durability evidence, catch-up, re-anchor, daemon composition, and `HarnessClient` in `@moltzap/client`;
- keep action certification separate from durability certification;
- stage an exact verified action-certified record durably before voting;
- require every member’s storage vote for `n < 4`, or `n-f` votes for `n >= 4`, with `f=floor((n-1)/3)`;
- allow any member to assemble and disseminate completed evidence;
- verify membership, ancestry, signatures, certificates, hashes, and Router anchors before mutation;
- preserve all compatible simulator behavior and its separate `RunLedger`;
- delete displaced protocol, server, Ledger, Transcript, profile, CLI/socket, testbed, and obsolete `v2/*` implementation surfaces as their final owners become usable.

An implementer must avoid:

- adding conversation, task, history, durability, trust, or policy semantics to Router or Registry;
- weakening unanimous action validity with the storage quorum;
- treating signatures as proof that a Byzantine signer retained bytes;
- guessing ancestry, selecting incomparable heads, lowering thresholds, or reconstructing lost reply authority from history;
- exposing signing keys, Registry admission material, raw Router authority, endpoint stores, or private protocol machinery to runtimes;
- generic established-conversation send;
- privileged institution, monitor, governance, or private-history paths;
- compatibility aliases, inert fields, lazy semantic translations, or reused persisted tags that hide an authority break;
- pruning certified ancestry or claiming local-disk-loss recovery before those policies are admitted;
- crossing any explicit Client, simulator, release, or storage deferral.

Affected consumers are OpenClaw, NanoClaw, simulator runtime subjects, and evals. Adapters consume Client only. Simulator composes public Identity, Router, and Client capabilities. Production packages never depend on simulator or evals.

Fault and trust assumptions are explicit:

- Registry and Router are correct and non-equivocating; malicious or equivocating versions are outside Gate 1.
- Endpoints may be Byzantine.
- For `n >= 4`, at most `f` Byzantine fixed members plus honest stage-before-sign guarantees at least `n-2f` honest staged replicas after completion.
- For `n < 4`, the replicated-storage guarantee assumes zero Byzantine members.
- Safety is timing-independent.
- Byzantine withholding, unavailable action signers, unavailable storage quorum, missing ancestry, Registry outage, or Router outage may halt progress.
- Existing complete local records remain independently verifiable during service outages.
- Catch-up requires a reachable honest authorized member retaining the necessary ancestry.
- Identity/Router representations remain compatible through relocation; the cutover intentionally breaks obsolete profile/Ledger/testbed/v1 surfaces.
- npm remains owned by `main` until publication and release policy is separately admitted.

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

The ADR names one human decision-maker: **Tapan Chugh**.

The trajectory does not identify the human operating the source session. It records direct messages with stored role `user`, while the planning-UI request/result events have no stored actor role. Therefore the event ledger itself does not prove that its `user` actor is Tapan Chugh.

The cited source session is `019fd899-779c-7e70-a8e4-338727b13e6c`.

Material events include:

- Initial four-layer/reduction request: `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d`.
- Planning request/result pairs:
  - simplify without replacing semantics: `fc_0fe7c1dd2e31cd97016a7b62f6d1fc8193bdf9d9e0b4554507` / `fco_019ff1fd-87dc-7d03-b333-6f3bedf1e0d0`;
  - initial five-layer selection and BFT-like shared quorum: `fc_0fe7c1dd2e31cd97016a7b63d625988193baa357dc6a96d425` / `fco_019ff200-fdb0-74b0-8757-b52ea4edd1f3`;
  - trusted Router, fixed one-third threshold, and any-member finalization: `fc_0fe7c1dd2e31cd97016a7b64c1c3e48193b79637c3edf767ee` / `fco_019ff202-7769-7af0-9a5e-d60e38fd8567`;
  - local record proof, automatic catch-up, and the suggestion to merge L2/L3: `fc_0fe7c1dd2e31cd97016a7b653f727c81938c108ca73627c1d2` / `fco_019ff204-876c-71f0-aac3-361b40a1bd51`;
  - later four-layer selection, which replaces the five-layer selection, plus API cleanup and authority/spec first: `fc_0fe7c1dd2e31cd97016a7b65c1e660819395c7eecd5b191af4` / `fco_019ff206-4451-78f3-8be3-30888ac565c7`;
  - separate action and durability certificates, with questions about profiles and old Client: `fc_0fe7c1dd2e31cd97016a7b6627e62c81938dab3c1f7cfcff89` / `fco_019ff209-a6a4-7d93-b543-45caf6a9445a`;
  - explicit daemon configuration, `@moltzap/client`, and all-v1 cutover: `fc_0fe7c1dd2e31cd97016a7b6746dd74819386b22a7bcd6b2bde` / `fco_019ff20c-30c7-75d3-894f-9c03246acaee`;
  - final package homes/names and `HarnessClient`: `fc_0fe7c1dd2e31cd97016a7b67c36258819396b8f765476e50a3` / `fco_019ff20f-00b2-77c1-952d-01680dbfbf52`;
  - aborted cutover-policy prompt, from which no selection is inferred: `fc_0fe7c1dd2e31cd97016a7b68723cb08193866b8a1589f44928` / `fco_019ff210-2654-71b3-b959-34c93e655183`;
  - freeze forward merges, land PR #974 first, and preserve compatible simulator APIs: `fc_0fe7c1dd2e31cd97016a7b6890ab4481938e5fa766cb103d98` / `fco_019ff211-9d26-7051-986b-267c722b6286`;
  - Router quorum re-anchor, long-lived branch, and blockers-only PR cleanup: `fc_0fe7c1dd2e31cd97016a7b692b46b8819390fad670bd984ca3` / `fco_019ff213-9fe0-7ea0-8e57-458b9727fc70`.
- Direct v1-retirement instruction: `msg_019ff209-a6b4-7660-bb73-0d7fc7fa1938`.
- Assistant-authored plan: `msg_0fe7c1dd2e31cd97016a7b698cc8448193a837b65a5efb21f9`.
- Human instruction to set that directly preceding plan as the goal and persist it before shipping: `msg_019ff231-e57a-7323-a0a3-c98c9b10ff22`.
- Readability events: `msg_019ff20f-0112-7c11-820b-8b4933270d85`, assistant recommendation `msg_0fe7c1dd2e31cd97016a7b6852085c81938648c56d41d8b0c3`, and the `enable`/testbed response `msg_019ff210-429e-7912-8d33-b80c7b409d53`.
- Registry-recovery sequence:
  - initial assistant proposal: `msg_0fe7c1dd2e31cd97016a7b7b2459ec8193b5a323d95381cef6`;
  - `I accept that`: `msg_019ff259-becc-7400-9b3f-243c73c30dd4`;
  - later two-part clarification: `msg_0fe7c1dd2e31cd97016a7b8d1ac4b88193bbf270f9c112120a`;
  - rejection of silently accepting changed recovery arguments: `msg_019ff2a0-6576-7172-8c6b-e32415d4ede2`;
  - assistant’s narrowed interpretation: `msg_0fe7c1dd2e31cd97016a7b8d851e248193b99dcf4c05f1dccd`;
  - instruction to defer the remaining Registry issue and proceed: `msg_019ff2a1-23e6-7f90-b627-7df2faa176b6`;
  - assistant response recording deferral: `msg_0fe7c1dd2e31cd97016a7b8dea65c48193bf40bb1ce6b39370`.

Explicit source gaps and limits are:

- session metadata has no native message ID, enclosing turn, parent locator, stored actor role, or human identity;
- retained response items lack parent-message fields;
- planning function events lack stored actor roles;
- the initial request does not select record type, threshold, public API, or disclosure protocol;
- the aborted prompt supplies no selection;
- the adopted plan does not itself admit an ADR, accept a blind-review result, or freeze the final public interface;
- Registry recovery item 1 remains unanswered and is deferred, while changed-argument failure is retained;
- omitted system/developer instructions, hidden reasoning, private research, unrelated workflow details, and machine-local source paths are explicitly disclosed as omissions.

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest stale instruction is `docs/architecture/l1-l2-implementation-ask.md → Package graph and release identity`, whose historical body says v2 has six deep `v2/*` packages, a Transcript/Ledger, and a testbed.

It is resolved without an author hint:

- the document begins with `HISTORICAL IMPLEMENTATION HANDOFF — SUPERSEDED BY THE FOUR-LAYER CUTOVER`;
- it directs implementers to `docs/architecture/first-implementation.md`;
- architecture is below current ADR outcomes and normative specifications;
- `AGENTS.md`, `v2/VISION.md`, the accepted replacement ADR, and `docs/spec/layer-interfaces.md` all require seven final `packages/*` products and no Ledger/testbed package;
- each affected earlier ADR has an explicit `Supersession` section.

The root `README.md` also describes the retiring v1 server/protocol surface. The root agent law identifies `main` as the published v1 baseline, while the branch’s replacement authority and `docs/spec/README.md → Implementation readiness` explain that the old tree is being retired in ordered lanes. It is not authority for cutover implementation.

No unresolved contradiction or broken lineage remains.

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

A teammate can implement the explicitly ready slices without chat: the seven-package graph/tooling work, Identity relocation, Router relocation, removal of obsolete Transcript/testbed scaffolds when dependencies permit, and the private semantic foundation for endpoint history.

A teammate cannot complete Client, adapters, simulator, or release cutover yet. The repository deliberately blocks those lanes rather than inviting guesses.

Deliberate deferrals are:

- four Client choices: public start-operation identity/recovery; current-only versus universal cross-conversation turn context and checkpoints; complete certified record versus compact receipt plus proof retrieval; MCP-only versus public TypeScript search/history;
- exact Client method names, turn fields, request/result/error types, stream projection, cross-process reply resumption, context bounds/crash policy, and acquisition ergonomics;
- five simulator conflicts: content-free open, generic send, message-only receive/results, runtime/raw-Router authority, and persisted Router-commit/order evidence;
- publication membership, coordinated versus independent package versions, release ordering, deployment policy, and external-consumer compatibility treatment;
- pruning, garbage collection, retention, physical compaction constraints, and recovery after local disk loss;
- Registry registration recovery and idempotency beyond the recorded changed-argument failure;
- dynamic membership and changing-history authorization;
- non-unanimous action certificates, executable/custom norms, later action vocabularies, addressed turns, pass/abort/renewal/takeover/dispute flows, and fairness/starvation guarantees;
- alternate catch-up transport and transactional-outbox mechanism;
- Router replication, Byzantine sequencing, Router fork detection/failover, and transparent restart;
- malicious/replicated Registry tolerance, identity rotation/recovery, delegation evidence, and peer-card custody;
- end-to-end encryption/key distribution and binary/media action content;
- public observers, non-member audit/disclosure protocols, and cross-history conventions;
- portable personal-trust conformance and later screening/testimony/institution/contact protocols;
- hostile-host/local daemon authentication, dynamic ports, attachments, universal supervision, and remote administration;
- MCP replay/cursors, alternate push, asynchronous handles, and dynamic tools;
- negotiated resource profiles and FROST compression.

Accidental gaps found: none. The corrected `G1-DEC-811` owner now resolves to `docs/spec/router.md → Explicitly deferred` for resource profiles and `docs/spec/harness/client.md → Deliberate interface gates` for cross-conversation bounds.

## Independently discovered paths and headings

- `AGENTS.md` — `Project`, `Decisions`, `Docs`
- `v2/AGENTS.md` — `Authority and reading order`, `Final product graph`, `Deliberate implementation gates`
- `v2/VISION.md` — `Authority`, `The constitution`, `First executable profile`, `Deliberate deferrals`, `Evidence and path`
- `docs/decisions/README.md` — `Canonical reading guidance`, `Records`
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` — `Decision Outcome`, `Guarantees and progress assumptions`, `Explicit deferrals and implementation boundary`, `Gate 1 traceability disposition`, `Consequences`, `Record changelog`
- `docs/decision-evidence/20260811-four-layer-v2-cutover-trajectory.md` — `Source record and compaction method`, `Four layers and recursive trust features`, `Planning UI questions and selections`, `v1 retirement and the adopted cutover goal`, `Readability ratchet and testbed removal`, `Registry recovery correction and deferral`, `Mechanical repository and issue effects`
- `docs/spec/README.md` — `Authority and reading order`, `Implementation readiness`, `Deliberate interface deferrals`
- `docs/spec/conversation-history.md`
- `docs/spec/layer-interfaces.md`
- `docs/spec/router.md`
- `docs/spec/enforcement.md`
- `docs/spec/harness/client.md`
- `docs/spec/harness/daemon.md`
- `docs/spec/harness/ingress.md`
- `docs/spec/harness/output.md`
- `docs/spec/harness/tasks.md`
- `docs/architecture/first-implementation.md`
- `docs/architecture/layers.md`
- `docs/architecture/l1-l2-implementation-ask.md`

## Discovery trail

1. Established current HEAD, branch, cleanliness, and latest commit from Git.
2. Read repository and v2 agent law, then loaded the required checked-in decision-review procedure.
3. Followed `docs/decisions/README.md` to the current accepted ADR.
4. Read the constitution, complete ADR, and its directly linked trajectory.
5. Followed the replacement link through all 27 predecessor records and inspected their status and `Supersession` sections.
6. Followed trace owners into normative specs and implementation-readiness gates.
7. Searched current authority, specs, and architecture—excluding all decision-evidence review artifacts—for stale eight-layer, Ledger, package, and profile instructions.
8. Resolved the strongest stale document using its own superseded banner and the declared authority order.
9. Reconfirmed unchanged HEAD and clean worktree.

## Per-question verdicts

| Question | Verdict | Reason |
|---|---|---|
| 1 | PASS | The current outcome, resolved problem, authority order, and normative/non-normative boundary are explicit. |
| 2 | PASS | All 27 direct predecessors, their retained scope, and current normative owners are discoverable. |
| 3 | PASS | Implementation duties, prohibited behavior, consumers, fault bounds, safety/liveness split, and compatibility rules are explicit. |
| 4 | PASS | The named human, exact source-event ledger, reversals, aborted selection, Registry deferral, and attribution gaps are explicitly reportable without inference. |
| 5 | PASS | The strongest stale six-package instruction is visibly quarantined as historical and resolves cleanly through the authority order. |
| 6 | PASS | Ready lanes and blocked lanes are explicit; every unresolved choice found is classified as a deliberate deferral, with no accidental missing authority link found. |

## Blockers

No blind-review blocker for the authority candidate.

The declared Client, simulator, release, retention/disk-loss, and Registry-recovery gates remain implementation blockers for their respective lanes and must not be crossed without separately admitted decisions.

# Overall result: PASS

## Candidate freeze and maintainer acceptance

The reviewer report above is unedited. The following audit fields were added
after the blind run and do not alter its answers or verdict.

| Field | Value |
|---|---|
| Review run ID | `20260812-030317Z-ecca544d-four-layer-blind` |
| Candidate commit | `ecca544d33ec8cbe60dd096d58a73f402f783268` |
| Candidate tree | `3dca909a5a5769a4c14e64ae6abc9b83f9bb2d90` |
| Candidate content digest | `sha256:8cb3e1063c5263215bc4e614e65490f08779153f14532681c3312add79ec0105` |
| Digest scope and command | Complete candidate tree listing produced by `git ls-tree -r --full-tree ecca544d33ec8cbe60dd096d58a73f402f783268 \| sha256sum` |
| Review budget | One uninterrupted fresh context, hard time-boxed to 12 minutes |
| Rerun of | Candidate `66c1ab085634a5d7d3dc0fd3321e2a77af71d9e5` blind review |
| Rerun reason | The prior reviewer found the stale `G1-DEC-811` normative-owner locator |
| Maintainer | Tapan Chugh |
| Candidate identity matches | Yes |
| Gate decision | **ACCEPTED** |
| Acceptance recorded | `2026-08-12T03:15:21Z` (recording time; source-event timestamp unavailable) |
| Rationale | The maintainer explicitly replied `accept` after receiving the exact candidate commit, the six-question PASS, and the statement that acceptance was the sole remaining gate before code edits. |
