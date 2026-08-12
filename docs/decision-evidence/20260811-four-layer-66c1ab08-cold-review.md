# Blind decision review

**Overall result: FAIL**

## Candidate and isolation

- Repository: `/home/tapanc/moltzap-v2-cutover`
- Branch: `cutover/four-layer-v2`
- Commit: `66c1ab085634a5d7d3dc0fd3321e2a77af71d9e5`
- Tree: `9c0bc83430c34b18e115f6e86977f545b7fe256a`
- Worktree: clean
- Reviewer: fresh Codex sub-agent `/root/blind_candidate_review_three`
- Duration: 6m47s, `2026-08-12T02:47:48Z`–`02:54:35Z`
- Author interventions: none
- Isolation: no author conversation, summary, design explanation, diff tour, answer key, hints, or inherited blind-review output.
- Quarantine: I did not open, read, or search the contents of any `*-cold-review.md` or `*-invalid-review.md`. `git show --stat HEAD` exposed one quarantined filename, which the rules explicitly allow; it returned no answer or verdict. The run is valid.
- Candidate modifications: none.
- Mechanical check: `pnpm exec tsx scripts/docs/adr/check-shape.ts` passed all 55 ADRs.

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate makes the four-layer architecture current:

1. Identity
2. Communication
3. Tasks and norms
4. Personal trust

It removes the central product Ledger and assigns each fixed conversation member an independently stored, hash-linked copy of quorum-certified history. Registry and Router remain independent network services; each agent daemon owns local credentials, protocol state, certified history, catch-up, and Router re-anchoring.

Action validity and durability are separate:

- OpenFloorV1 START and MULTICAST validity remains unanimous.
- Durability requires every member for `n < 4`; for `n >= 4`, with `f = floor((n - 1) / 3)`, it requires `n - f` votes.
- Honest members stage before signing.
- Any member may assemble completed evidence.
- Router restart recovery uses a threshold-certified re-anchor over the selected certified head.

It also fixes the final seven-package graph, removes profiles, split MCP paths, central Ledger/Transcript machinery, the standalone testbed, old protocol/server packages, and compatibility shims.

The problem resolved is the oversized eight-layer, central-storage architecture in which monitoring, institutions, credentials, governance, Ledger storage, profiles, and duplicate implementation trees had become privileged product machinery instead of recursively composed endpoint behavior.

Binding material is:

- the accepted ADR’s `Decision Outcome`;
- its guarantees and fault/progress assumptions;
- its explicit deferrals and negative implementation boundaries;
- its current trace dispositions and normative-owner assignments;
- `v2/VISION.md → The constitution`;
- the normative `docs/spec/` chapters.

The ADR’s context and consequences explain history and impact. `docs/decision-evidence/20260811-four-layer-v2-cutover-trajectory.md` is explicitly non-normative evidence. `docs/architecture/` is orientation and execution material, not authority.

**Verdict: PASS**

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

The supersession chain is broadly explicit. Twenty-seven earlier ADRs point visibly to the replacement, covering:

- Router/network boundaries: the network-is-a-router, physical-plane split, data-plane layering, network HTTP/polling, and opaque Router order.
- Stack/storage: eight-layer stack, fault model, Ledger atomic Transcript commit, collectives, conversation lifecycle, and OpenFloorV1.
- Daemon/runtime: endpoint MCP, model start/reply/listen, profile-slot daemon, HarnessClient context, inbound content/grants, and start-or-bound-reply.
- Packages/simulator/cutover: top-level v2 layout, six packages/versioning, simulator driver/kernel, Kubernetes simulator, eval/testbed, v2 authority, and the Gate 1 freeze.
- Trust: two-direction firewall and monitor architecture.

Retained outcomes include:

- immutable AgentCards, Ed25519 identity, Registry admission and authentication;
- exact Identity and Router representations, routes, bounds, and typed failures;
- one correct non-equivocating Registry and Router;
- content-blind, volatile Router delivery;
- endpoint-owned interpretation;
- fixed membership, START with initial content, OpenFloor contention and unanimous action certification;
- start, bound reply, listen, and no generic send;
- one daemon per AgentId and modern loopback MCP framing;
- deep package ownership and compatible simulator `RunSpec`, `Run.execute`, Kubernetes, event-catalog, and `RunLedger` behavior;
- repository-native authority, stable trace IDs, and blind review.

Replaced outcomes include:

- eight layers and the privileged L5–L8 region;
- the product Ledger, Transcript service, global `LedgerOffset`, central conversation index, author-only append, and immediate all-member-readability claim;
- permanent post-Router-restart fencing;
- named profiles and split registration/active MCP paths;
- the six-package `v2/*` implementation graph;
- standalone testbed and privileged monitor/institution/governance paths;
- routine main-to-cutover merging and v1 compatibility shims.

Unlisted current Identity/Router decisions remain untouched except for explicitly retired Ledger/profile qualifiers.

The authority chain is discoverable through `AGENTS.md`, `v2/VISION.md`, the replacement ADR and prior `Supersession` sections, then `docs/spec/README.md` and its focused chapters—especially `layer-interfaces.md`, `conversation-history.md`, `router.md`, `identity.md`, `enforcement.md`, `management.md`, and `harness/*`.

However, trace row `G1-DEC-811` has a broken normative-owner locator, described in answer 5.

**Verdict: FAIL**

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what assumptions?

An implementer must:

- move Identity and Router into `packages/identity` and `packages/router` without changing their admitted wire behavior;
- establish exactly the seven named packages and dependency edges;
- put endpoint history, certification, catch-up, re-anchor, daemon composition, tasks, trust, and `HarnessClient` under `@moltzap/client`;
- use one explicit state directory and one state-dependent loopback `/mcp`;
- implement stage-before-sign, distinct action/durability certificates, hash-linked ancestry, automatic verified member catch-up, any-member evidence completion, and threshold re-anchoring;
- keep OpenClaw and NanoClaw dependent only on Client;
- preserve compatible simulator/eval behavior and stop at the five named conflicts;
- delete displaced protocol, server, Ledger, Transcript, profile, testbed, CLI/socket, and obsolete `v2/*` implementations without aliases;
- enforce the pinned ACG readability rules.

An implementer must avoid:

- introducing a central conversation store or product Ledger;
- giving Router conversation, persistence, task, trust, or recovery semantics;
- weakening unanimous action validity with the durability quorum;
- treating signatures as proof that Byzantine signers retained bytes;
- creating generic send, raw Router authority, privileged institutional paths, or private-history bypasses;
- pruning certified ancestry or claiming disk-loss recovery;
- selecting any deferred Client, simulator, release, or recovery contract through a shim or implementation accident.

Affected consumers are Client, daemon/MCP, OpenClaw, NanoClaw, Simulator, Evals, workspace/package tooling, and release configuration. Identity and Router are relocated but retain their substantive contracts.

Assumptions and guarantees:

- Registry and Router are correct and non-equivocating; malicious Registry and Byzantine sequencing are outside the profile.
- Endpoints may be Byzantine.
- For `n >= 4`, at most `f = floor((n - 1) / 3)` members are Byzantine; `n - f` storage votes plus honest stage-before-sign guarantee at least `n - 2f` honest staged replicas.
- For `n < 4`, all members vote and the replicated-storage guarantee assumes zero Byzantine members.
- Safety is timing-independent.
- Progress requires applicable identity material, Router availability, every unanimous action signer, the durability threshold, and an honest source for missing history.
- Byzantine withholding, outages, unavailable quorum, missing ancestry, or incomparable heads may halt progress without weakening verification.
- Existing certified local history remains readable during service outage.
- Compatibility is intentionally breaking for retired surfaces. Exact Identity/Router bytes and compatible simulator facades survive; the four Client choices and five simulator conflicts do not.

**Verdict: PASS**

## 4. Which humans and source events are cited, and what source gaps are recorded?

The ADR names **Tapan Chugh** as the sole decision-maker.

The trajectory does not identify the human behind its session account, so I do not infer that its stored `user` events are independently attributable to Tapan. It records one Codex CLI session, `019fd899-779c-7e70-a8e4-338727b13e6c`.

Material event groups are:

- `Four layers and recursive trust features`: user message `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d`, requesting simplification, removal of Ledger/monitoring/revocable-credential layers, participant-owned history, and recursive institutions/governance.
- `Planning UI questions and selections`: paired request/result events for simplification, five layers, trusted Router/fixed one-third/any-member completion, local proof/catch-up, final four layers, separate action/durability certificates, profile removal, explicit daemon configuration, `@moltzap/client`, all-v1 cutover, final package homes, freeze/PR/simulator policy, and Router re-anchor/long-lived branch.
- The five-layer result (`fco_019ff200-fdb0-74b0-8757-b52ea4edd1f3`) is explicitly replaced by the later four-layer result (`fco_019ff206-4451-78f3-8be3-30888ac565c7`).
- The first cutover-policy prompt/result (`fc_0fe7…68723cb…` / `fco_019ff210-2654-71b3-b959-34c93e655183`) records “aborted by user”; no selection is inferred.
- The simulator result `fco_019ff211-9d26-7051-986b-267c722b6286` records preservation of stable simulator APIs, later constrained by the five explicitly discovered conflicts.
- `v1 retirement and the adopted cutover goal`: user message `msg_019ff209-a6b4-7660-bb73-0d7fc7fa1938`, assistant plan `msg_0fe7…698cc844…`, and user adoption `msg_019ff231-e57a-7323-a0a3-c98c9b10ff22`.
- `Readability ratchet and testbed removal`: user messages `msg_019ff20f-0112-7c11-820b-8b4933270d85` and `msg_019ff210-429e-7912-8d33-b80c7b409d53`, surrounding the agent’s ACG recommendation. The testbed statement retains its hedge; the adopted plan supplies the stronger removal direction.
- `Registry recovery correction and deferral`: an initial narrow acceptance (`msg_019ff259-becc-7400-9b3f-243c73c30dd4`), later rejection of changed recovery arguments (`msg_019ff2a0-6576-7172-8c6b-e32415d4ede2`), and explicit instruction to defer the remaining Registry work to an issue (`msg_019ff2a1-23e6-7f90-b627-7df2faa176b6`).

Explicit source gaps and limits include:

- session metadata does not identify the human;
- the metadata event lacks native message ID, enclosing turn, parent locator, and stored actor role;
- planning function events lack actor role and parent locators;
- retained messages generally record parent locator as absent;
- omissions and Markdown wrapping are explicitly marked;
- the initial “ledger” wording is ambiguous and does not name record type, threshold, API, or disclosure protocol;
- the aborted prompt supplies no choice;
- the L2/L3 merge note ends unfinished;
- the adopted plan is an agent proposal selected as an execution goal, not a claim that every interface detail was already admitted;
- the first Registry recovery acceptance is limited to its immediately preceding proposal; the later two-item prompt leaves item 1 unanswered and the remaining recovery design is explicitly deferred.

These are recorded gaps rather than inferred rationale.

**Verdict: PASS**

## 5. Strongest contradiction, stale instruction, or broken lineage

The material blocker is in `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md → Gate 1 traceability disposition`:

> `G1-DEC-811 … | v2/VISION.md — Open questions; docs/spec/harness/client.md — Explicitly deferred`

Current `v2/VISION.md` has no `Open questions` heading; its relevant heading is `Deliberate deferrals`. More importantly, that section does not state the row’s “later resource profiles remain absent” deferral. The old freeze row pointed to the former `Open-question register`.

The intended split can be inferred:

- `docs/spec/router.md → Explicitly deferred` names negotiated resource limits.
- `docs/spec/harness/client.md → Deliberate interface gates/deferrals` owns cross-conversation bounds.

But the current trace row does not name the Router owner and points to a nonexistent Vision location. Because the ADR says its trace table owns the current disposition and normative owner, silently substituting those sources would repair the candidate through reviewer inference. This is a stale/broken lineage locator and requires a candidate edit plus a fresh review.

Other strong apparent contradictions are resolvable:

- `docs/architecture/l1-l2-implementation-ask.md` still contains “active implementation goal” and six-package/v2-path instructions internally, but its top status explicitly marks the whole page historical and superseded and redirects to `first-implementation.md`.
- `docs/architecture/harness-implementation-slate.md` similarly retains profile/Ledger instructions under an explicit historical/superseded header.
- Root `README.md` describes the retiring v1 production implementation; `AGENTS.md` explicitly distinguishes that transitional baseline from the final cutover authority.

Those do not override the current law.

**Verdict: FAIL**

## 6. Could a teammate implement without chat or guessing?

The ready lanes—authority, package graph, Identity/Router relocation, obsolete Transcript/testbed deletion, and private endpoint-history semantics—are implementable without chat.

The following are deliberate deferrals and must remain blocked:

- Four Client choices: operation identity/recovery; current-only versus cross-conversation context/checkpoints; complete record versus receipt plus retrieval; MCP-only versus TypeScript search/history.
- Exact Client method names, turn fields, errors, acquisition ergonomics, and cross-process reply resumption.
- Daemon/management representations: configuration/environment spelling, state layout, registration/status recovery, status fields, search/ranking/pagination/projections, history wire/pages, queue limits, and remote administration.
- Five simulator conflicts: empty open, generic send, message-only receive/results, runtime Router credentials/authority, and persisted Router-commit/order evidence.
- Publication membership, package version coordination, deployment, and release ordering.
- Pruning, garbage collection, post-certificate retention, disk-loss recovery, alternate catch-up transport, and transactional outbox mechanism.
- Dynamic membership, non-unanimous action certificates, observers, non-member disclosure/audit, encryption/key distribution, richer norms, addressed turns, fairness, action recovery, pass/abort/renewal/disputes, plural-action mapping, media, signature compression, and portable trust-policy conformance.
- Router replication/failover/Byzantine sequencing, malicious Registry tolerance, identity rotation/recovery, delegation/peer-card custody, hostile-host/local-auth profiles, and universal supervision.

The accidental gap is `G1-DEC-811`’s stale normative-owner location. Consequently, work touching interoperable resource profiles/limits cannot follow the current trace lineage exactly without guessing which source owns it.

**Verdict: FAIL**

## Independently discovered paths and headings

- `AGENTS.md → Decisions`, `Docs`
- `.claude/skills/decisions/SKILL.md → Blind review gate`
- `docs/decisions/README.md → Canonical reading guidance`, `Records`
- `v2/VISION.md → Authority`, `The constitution`, `First executable profile`, `Deliberate deferrals`
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md → Decision Outcome`, `Guarantees and progress assumptions`, `Explicit deferrals`, `Gate 1 traceability disposition`
- `docs/decision-evidence/20260811-four-layer-v2-cutover-trajectory.md` and its four cited headings
- All 27 prior ADR `Supersession` sections found through the decision index
- `docs/spec/README.md → Implementation readiness`
- `docs/spec/conversation-history.md`
- `docs/spec/layer-interfaces.md`
- `docs/spec/router.md → Explicitly deferred`
- `docs/spec/harness/client.md → Deliberate interface gates`
- package-scoped `AGENTS.md` files
- historical headers in `docs/architecture/l1-l2-implementation-ask.md` and `harness-implementation-slate.md`

## Concise discovery trail

1. Resolved HEAD/tree/status and listed repository files with quarantine exclusions.
2. Followed `README.md` to the decision index and `v2/VISION.md`.
3. Independently discovered the current four-layer ADR from the first index row.
4. Read the replacement ADR and its cited trajectory.
5. Located every prior ADR referencing the replacement and read each `Supersession` section.
6. Read root/v2/package agent law and the normative spec index and focused chapters.
7. Loaded the repository-required `decisions` skill and fixed question set.
8. Ran the ADR shape checker successfully.
9. Searched current authority/orientation sources for stale Ledger, profile, package, and eight-layer instructions.
10. Audited the replacement trace table against current headings and found the `G1-DEC-811` owner defect.

## Blocker

- Correct `G1-DEC-811` so its current normative owners are accurate and discoverable—particularly the resource-limit/profile portion—and freeze a new candidate for a different fresh reviewer.

**Overall: FAIL**
