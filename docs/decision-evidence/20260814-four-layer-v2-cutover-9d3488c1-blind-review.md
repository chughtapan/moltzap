# Blind decision review — `9d3488c1`

## Review identity

| Field | Value |
|---|---|
| Review run ID | `blind_candidate_review_9d3488c1` |
| Candidate commit | `9d3488c1db028f362008384a865c07a7d9dc317d` |
| Candidate tree | `241f18a0f594231fd1d8acf4f8c2ae98ff6f1bdf` |
| Candidate content digest | SHA-256 `44160fba56469e64c171402089d64c242a050d7a6b424643a99ac87fb46b35c0` |
| Digest scope and command | Entire committed tree via `git archive --format=tar 9d3488c1db028f362008384a865c07a7d9dc317d \| sha256sum` |
| Reviewer | Codex fresh subagent `/root/blind_candidate_review_9d3488c1` |
| Reviewer session | One uninterrupted fresh-agent context |
| Review started | `2026-08-14T08:17:58Z` |
| Review finished | `2026-08-14T08:25:05Z` |
| Review duration | `00:07:07` |
| Review budget | One uninterrupted fresh-agent context |
| Rerun of | None supplied |
| Rerun reason | None supplied |

## Fresh-context attestation

- [x] I did not author or reconcile the candidate decision.
- [x] I received no inherited conversation, summary, memory, private state, or earlier blind-review output about the candidate.
- [x] I received only the candidate repository root, exact candidate commit, fixed questions, and isolation instructions.
- [x] I received no design summary, diff tour, ADR/file pointer, search term, expected answer, or answer key.
- [x] I navigated independently from `AGENTS.md`, `v2/AGENTS.md`, `v2/VISION.md`, and repository-native indexes.
- [x] I did not open, read, or search any earlier `*-cold-review.md`, `*-blind-review.md`, or `*-invalid-review.md`. A history listing exposed some quarantined paths, but no contents, answer, or verdict.
- [x] I did not consult the machine-local source session referenced by the trajectories.
- [x] I did not ask the author for help.
- [x] I did not modify the candidate. Final `git status --short` was empty.
- [x] The author interventions recorded below are complete.

## Exact review prompt received

> Repository root: /home/tapanc/moltzap-v2-cutover  
> Candidate commit: 9d3488c1db028f362008384a865c07a7d9dc317d
>
> You are the fresh blind teammate reviewer required by the repository's AGENTS.md. You did not author or reconcile this candidate. Receive no inherited conversation, summary, design pointer, diff tour, search term, expected answer, prior review output, or private state. Independently navigate the candidate repository and answer the six questions below verbatim. Do not open, read, or search the contents of any earlier *-cold-review.md, *-blind-review.md, or *-invalid-review.md record; merely seeing such a path is allowed. Do not modify the repository. Bound the review to this one uninterrupted context. Record your identity/isolation attestation, start/finish/duration, discovery trail, author interventions, exact candidate identity/tree digest, per-question verdicts, blockers, overall PASS/FAIL, and your unedited answers in your final response.
>
> 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
> 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
> 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
> 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
> 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
> 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

## Fixed questions and unedited answers

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate makes one integrated four-layer cutover current:

- Identity, Communication, Tasks and norms, and Personal trust replace the eight-layer model.
- Registry and Router remain the two network services. Each per-agent `moltzapd` endpoint owns conversation state and independently stored certified history; there is no product Ledger or Transcript service.
- The workspace has exactly seven final packages with the dependency graph stated in `v2/AGENTS.md`, the four-layer ADR, and `docs/spec/layer-interfaces.md`.
- The runtime boundary is the reduced `HarnessClient`: caller-minted `ConversationId`, `start`, one current-conversation action per turn, and a content-only bound reply. Start and reply return `void` after local certified durability; management and proof inspection remain MCP-only.
- Client owns the exact closed canonical evidence protocol, daemon persistence and management representation, subscription-gated non-author attention, and durable consumed-head marker.
- Simulator preserves Router bytes/order without an active fault; an explicitly activated private post-Router directed fault may drop, delay, hold, or reorder delivery for endpoint-tolerance testing.

This resolves the oversized eight-layer/central-Ledger design, duplicated v1 and `v2/*` implementation trees, profile-selected daemon and split MCP machinery, internal proof identifiers leaking into runtime interfaces, and incompatible Simulator contracts.

Binding authority is:

1. `AGENTS.md` and `v2/VISION.md`, especially `The constitution` and `First executable profile`;
2. current ADR outcomes, including `Supersession`, `Decision Outcome`, guarantees, and explicitly retained portions of partially superseded records;
3. normative `docs/spec/` chapters.

The ADRs’ Context sections explain the problem. Consequences describe effects but do not override the outcomes or specifications. `docs/architecture/` is orientation/execution material. The compacted trajectories explicitly say they are non-normative source-event ledgers. Historical ADR bodies, historical slates, implementation proposals, mechanical repository effects, and checked-in code do not independently create architecture authority.

Per-question verdict: **PASS**.

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

It replaces:

- the eight-layer/two-region stack with four layers;
- the separate conversation/Ledger storage layer and central atomic Transcript commit with Client-owned endpoint replicas, hash-linked records, durability votes, catch-up, and re-anchor;
- privileged monitor, institution, credential, and governance layers with ordinary agents, tasks, norms, signed statements, and local trust decisions;
- global `LedgerOffset`, public `TxnId`, proof-shaped runtime success, and central conversation indexing;
- the six-package `v2/*` graph, profile slot, profile selector, dual backing, split `/register/mcp` and `/mcp`, bespoke CLI/socket, standalone testbed, old protocol/server packages, and compatibility aliases;
- universal cross-conversation Client presentation and management methods on `HarnessClient`;
- five incompatible Simulator contracts: content-free open, generic send, message-only receive/results, runtime Router/credential authority, and persisted authoritative Router-order evidence.

It retains, with current qualifications:

- immutable AgentCards, Ed25519 identity, Registry bootstrap admission, AuthenticatedHttp, and exact Identity representations;
- a correct, non-equivocating, content-blind Router, exact SignedMessage byte preservation, volatile global ordering/polling, and layer-owned Router representations;
- fixed-membership `OpenFloorV1`, unanimous action certification, and the separation between semantic action validity and storage durability;
- one independently supervised daemon representing at most one AgentId, the official MCP SDK/core transport, sole-listener behavior, transient turn delivery, and bound reply authority;
- Simulator’s compatible public facades, system-driver role, lifecycle evidence `RunLedger`, and all sixteen eval definitions.

The `20260811-four-layer-endpoint-replicated-harness.md` record is partially superseded only for its four Client-interface deferrals and proof-shaped success statement by `20260812-harness-client-uses-conversation-id.md`. Its four-layer model, durability, recovery, package graph, and cutover remain current. `20260813-client-protocol-and-attention.md` closes the private Client, daemon, attention, registration-recovery, management, and five Simulator-cut choices. `20260813-simulator-link-faults-perturb-delivery.md` selects the narrow post-Router fault boundary without restoring those five removed surfaces.

The 2026-07-28 architecture freeze retains repository-native authority, stable trace IDs, explicit lineage, and the blind gate. Its eight-layer inventory is expressly an historical snapshot where the replacement table re-owns or replaces rows.

The current normative contract lives in:

- `v2/VISION.md`;
- the four current ADRs named at its top;
- `docs/spec/layer-interfaces.md`;
- `docs/spec/conversation-history.md`;
- `docs/spec/harness/{client,daemon,ingress,output,tasks,screening}.md`;
- `docs/spec/management.md` and `docs/spec/enforcement.md`;
- retained `docs/spec/identity*.md` and `docs/spec/router*.md` contracts.

Publication membership, package version coordination, release/deployment policy, and the other named deferrals remain untouched.

Per-question verdict: **PASS**.

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- Keep exactly the seven packages and exact internal MoltZap dependency edges in `docs/spec/layer-interfaces.md`.
- Preserve Identity and Router wire bytes, authentication, errors, limits, deep capabilities, Registry persistence, Router volatility, and binaries while moving them to `packages/identity` and `packages/router`.
- Put endpoint history, task/norm behavior, local trust, `moltzapd`, MCP, and `HarnessClient` in `packages/client`.
- Run Registry, Router, and one `moltzapd` per local agent as independent processes. The daemon binds only `127.0.0.1`, uses one SQLite/WAL store at `<state-directory>/moltzapd.sqlite3`, and accepts exactly the seven named `MOLTZAPD_*` inputs.
- Implement fixed 2–32-member histories, at most 32,768 canonical content bytes, RFC 8785 canonical Client values, the exact domain-separated hashes, stable self-addressed inner SignedMessages, replaceable all-member outer messages, genesis Router anchor, verified catch-up, and threshold re-anchor.
- Keep unanimous `OpenFloorV1` action certification separate from storage voting. Honest members stage before voting. For `n < 4`, every member votes; for `n >= 4`, `f=floor((n-1)/3)` and `n-f` votes complete durability.
- Return success only after the returning endpoint durably stores the complete certified record.
- Expose exactly the reduced Client and state-dependent MCP catalogs. Management remains MCP-only.
- Automatically contend only at a subscribed, non-author endpoint for an unconsumed remote-authored certified head. Persist `(ConversationId, RecordHash)` immediately before the one transient SSE write.
- Keep adapters consumer-only. OpenClaw and NanoClaw consume Client. Simulator/evals compose public capabilities without leaking Router, credentials, keys, store handles, or protocol internals.
- Preserve unfaulted Simulator delivery bytes/order. Keep activated link faults private, run-scoped, and post-Router.

An implementer must avoid:

- product Ledger/Transcript services, global offsets, central conversation stores, profiles, split MCP paths, CLI/socket fallbacks, extra packages, aliases, shims, generic send, unbound reply, public proof/hash/receipt values, public `TxnId`, network-client escape hatches, privileged institution paths, Router hooks, or runtime-visible fault controls;
- inferring any deferred retention, release, reply-recovery, richer-norm, audit, encryption, or administration policy.

Affected surfaces are all four conceptual layers and all seven consumers/products. Identity and Router are affected mainly by relocation and dependency names; their representation contracts remain stable. Client, daemon, adapters, Simulator, and evals receive substantive boundary changes.

Assumptions and guarantees:

- Registry and Router are correct and non-equivocating. Malicious/equivocating or replicated-service profiles are outside Gate 1.
- Endpoints may be Byzantine. For `n >= 4`, the storage guarantee assumes at most `f` Byzantine fixed members and honest stage-before-sign, yielding at least `n-2f` honest staged replicas. For `n < 4`, the replicated-storage guarantee assumes zero Byzantine members.
- OpenFloor action validity is unanimous. One honest required signer can prevent an invalid action certificate; all-malicious membership is outside that semantic guarantee.
- Safety is timing-independent and never lowers thresholds or guesses ancestry. Byzantine withholding may stop progress.
- Progress requires applicable identity material, Router availability, every required action signer, the durability/re-anchor threshold, and an honest reachable holder of missing ancestry.
- Registry outage blocks registration/uncached lookup; Router outage blocks new communication and evidence exchange; quorum unavailability blocks completion. Already certified local history remains readable and verifiable.
- An activated Simulator fault can intentionally stop progress. Its observations are endpoint-fault evidence, not Router-conformance evidence.
- Compatibility is deliberately broken for retired v1/profile/Ledger/testbed and five Simulator surfaces. Identity/Router representation compatibility and compatible Simulator facades are retained. Six cross-conversation eval cells may fail until host-native memory exists. Publication compatibility is deferred.

Per-question verdict: **PASS**.

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

All four current ADR frontmatter blocks name **Tapan Chugh** as the sole `decision-makers` value. The source records themselves store user/assistant roles or function-call events; the 20260811 trajectory explicitly says its session metadata does not identify the human using the session. The decision-maker field therefore names accountability but is not proof that every stored `user` event names Tapan.

The four-layer trajectory cites:

- Initial human direction: `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d` at `2026-08-11T17:56:38.308Z`.
- Planning result `fco_019ff1fd-87dc-7d03-b333-6f3bedf1e0d0`: simplify without changing too much.
- `fco_019ff200-fdb0-74b0-8757-b52ea4edd1f3`: five layers, shared BFT-like quorum/catch-up, preserved MCP split.
- `fco_019ff202-7769-7af0-9a5e-d60e38fd8567`: trusted Router, fixed one-third threshold with all members under four, any-member finalization.
- `fco_019ff204-876c-71f0-aac3-361b40a1bd51`: local record proof, automatic L3 catch-up, and the human suggestion to merge L2/L3.
- `fco_019ff206-4451-78f3-8be3-30888ac565c7`: four layers, API cleanup, and authority/spec before code. This expressly replaces the earlier five-layer selection.
- `fco_019ff209-a6a4-7d93-b543-45caf6a9445a`: separate action and durability certificates; human notes question profiles and old Client.
- `fco_019ff20c-30c7-75d3-894f-9c03246acaee`: explicit process configuration, `@moltzap/client`, and all-v1 cutover.
- `fco_019ff20f-00b2-77c1-952d-01680dbfbf52`: final non-v2 names and `HarnessClient`; the human note says move everything under `packages` and delete old code.
- `fco_019ff210-2654-71b3-b959-34c93e655183`: explicitly recorded as aborted, with no selection inferred.
- `fco_019ff211-9d26-7051-986b-267c722b6286`: freeze forward merges, land PR #974 first, and preserve compatible Simulator API with minimal changes.
- `fco_019ff213-9fe0-7ea0-8e57-458b9727fc70`: quorum re-anchor, one long-lived cutover branch, and blockers-only PR #974 cleanup.
- `msg_019ff231-e57a-7323-a0a3-c98c9b10ff22`: “set this plan as your goal. write it to durable storage first and then start shipping.”
- `msg_019ff210-429e-7912-8d33-b80c7b409d53`: “enable” the three named readability rules and the hedged statement “I don't think we have testbed anymore.”
- The reduced-boundary sequence: human prompts `msg_019ff821-75f6-70c3-b36b-54f732ad8242`, `msg_019ff822-0a13-7130-9814-109109a0ab1b`, and `msg_019ff827-7b2a-7441-9f35-8b538e86add8`; assistant proposal `msg_0fe7c1dd2e31cd97016a7cff8a2f50819397e84c52bd26d36c`; human acceptance `msg_019ff852-c742-7480-b464-fdae2792c6ad`; and later human messages `msg_019ff861-97cc-70e1-8158-4c670e77b30d` and `msg_019ff861-be31-7b40-b774-86ef3048c32a`.
- Registry recovery reversal/deferral: `msg_019ff259-becc-7400-9b3f-243c73c30dd4` accepts the immediately preceding narrow retry proposal; `msg_019ff2a0-6576-7172-8c6b-e32415d4ede2` rejects ignoring changed registration arguments; `msg_019ff2a1-23e6-7f90-b627-7df2faa176b6` directs the remaining Registry fight into an issue and tells the agent to continue the cutover. The ledger says that does not revoke the mismatch-failure answer or resolve the separately unanswered item.

The Client protocol trajectory cites:

- Request/result `fc_0fe7c1dd2e31cd97016a7d4fa1be4c819397c851716801b843` / `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0`: nested SignedMessage selected; host-native cross-conversation memory answer is “just defer it now. let the evals fail.”
- `fc_0fe7c1dd2e31cd97016a7d515b37bc8193a752005aaf28d092` / `fco_019ff989-86d8-7d83-92c1-16da24457d21`: initial “Every action” attention selection.
- Immediate human correction `msg_019ff989-fa2d-76f0-8d83-7b09f663643a`: “actually fine to not content again,” followed by the retained assistant interpretation that the author does not self-contend.
- Human correction `msg_019ff993-e348-7272-9e3c-f5ddce9d116e`: “look at the 4 layer plan now.”
- Assistant complete plan `msg_0fe7c1dd2e31cd97016a7d58c392bc8193bef23bb36ab9fc93`, followed by human instruction `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36`: “Implement the plan.”

The Simulator trajectory cites:

- Assistant alternatives in `msg_0fe7c1dd2e31cd97016a7dd586aa0c819380b891ef21a26512`.
- Human messages `msg_019ffc35-0352-7773-8385-27cd5007f44a` and `msg_019ffc35-0365-7dc3-bede-dd08ccfb4e38`, preserving the literal phrase “life-level ordering” and “that's the point of testing right.”
- Assistant interpretation `msg_0fe7c1dd2e31cd97016a7e01710a1c8193b46e90aaf91bdc8e` as link-level, post-Router perturbation. The ledger expressly says the two human messages are the decision events and the assistant message only records the interpretation used.

Explicit source gaps and limits recorded by the ledgers include:

- Session metadata does not identify the human; it lacks a native message ID, enclosing turn, parent locator, and actor role.
- Function-call request/result records lack stored actor roles and parent locators; public messages lack parent locators.
- The initial four-layer request does not specify final record type, threshold, API, or disclosure protocol.
- The adopted plan is identified as an assistant proposal; “set this plan as your goal” does not itself say an ADR, blind result, or final public interface was accepted.
- The testbed statement remains hedged rather than silently strengthened.
- The Client trajectory records no source statement of motives, confidence, urgency, reasons for each mechanism, exact database tables, every field/error literal, or environment-variable name.
- The Simulator trajectory records no human selection of the private interception transport, authentication, port, deployment object, or wire representation.
- Marked omissions exclude unrelated implementation status, tool output, hidden reasoning, and repeated summaries. No omitted material is silently reconstructed.

Per-question verdict: **PASS**.

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest stale current instruction is `docs/architecture.mdx` under **Client boundary during cutover**. It says:

- the Client “is being narrowed” while four public-interface choices are still being admitted;
- process-level coverage resumes only after those choices are admitted; and
- examples must wait until those choices are complete.

That page is not marked historical. It contradicts:

- `20260812-harness-client-uses-conversation-id.md`, which resolves all four choices;
- `20260813-client-protocol-and-attention.md`, which closes the protocol, daemon, management, attention, and Simulator contracts;
- `docs/spec/README.md` under **Implementation readiness**, which says those slices are ready; and
- current README/introduction statements that the daemon and real acceptance path are implemented.

The authority order resolves the implementation question: the current ADRs and normative specs win. The four selected answers are caller-minted `ConversationId`, current-conversation turns, `void` completion after local certification, and MCP-only management/history.

It does not resolve the repository consistency defect. Agent law says lower material must not contradict higher authority, and the decision lifecycle requires affected architecture pages to land atomically. A current published architecture page still presenting resolved choices as open is therefore blocker **B1**. It must be reconciled and the exact new candidate reviewed by a different fresh reviewer.

Historical `docs/architecture/harness-implementation-slate.md` and `l1-l2-implementation-ask.md` contain stronger obsolete profile, split-path, six-package, and `v2/*` instructions, but their top-level status blocks explicitly mark them historical and superseded. Their stale bodies are therefore resolvable historical archaeology rather than broken current lineage.

Per-question verdict: **FAIL**.

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

The selected Gate 1 behavior is detailed enough to implement without chat: the package graph, public Client types, daemon inputs/catalog, exact protocol values, thresholds, persistence rules, attention law, Simulator removals, fault boundary, errors, and acceptance criteria all have discoverable normative owners. The ADR shape checker also reports all 61 records mechanically well formed.

The candidate is nevertheless not a clean implementation handoff because blocker B1 leaves a current published architecture page claiming that resolved choices are still open. That is an accidental documentation gap, not implementation discretion.

Deliberate deferrals, grouped without changing their scope, are:

- **Release and compatibility:** which products publish; coordinated versus independent versions; release/deployment cutover policy; compatibility treatment for external consumers.
- **Membership, storage, and audit:** dynamic membership; pruning, garbage collection, retention and compaction; local disk-loss recovery; public observers; non-member audit/disclosure and cross-history conventions; alternate catch-up transports.
- **Service trust:** malicious or replicated Registry/Router profiles, Byzantine sequencing, fork detection, failover, identity rotation/recovery, delegation evidence, and peer-card custody.
- **Content and evidence:** fragmentation or larger resource profiles; binary/media content; end-to-end encryption and key distribution; signature compression; transactional-outbox mechanism for required evidence dissemination.
- **Task/norm behavior:** richer or executable norm vocabularies; non-unanimous action certificates; plural-action payload mapping; addressed turns; pass, abort, renewal, takeover, action recovery, disputes/remedies; fairness and starvation freedom; dynamic action tools.
- **Runtime and daemon:** cross-process reply recovery; delivery acknowledgment/replay and resumable subscriptions; daemon-wide concurrency, queue, mailbox, byte-budget, and overload policy; remote administration; hostile-host/local-auth defense; dynamic ports, attachment, and universal supervision.
- **Trust and hosts:** portable personal-trust conformance and host-native cross-conversation memory.

These are selected and therefore are **not** deferrals: the reduced four-part Client boundary, Registry `OperationId` recovery used by the daemon, 32-member/32,768-byte/no-fragmentation profile, five Simulator removals, all-sixteen-eval execution, and private post-Router fault boundary.

Accidental gap:

- **A1/B1:** `docs/architecture.mdx` still describes the four resolved Client choices and their process coverage as pending.

The source-event gaps listed in answer 4 are evidence-attribution limits, not missing implementation choices. No broken ADR anchor or missing normative-owner link was found mechanically.

Per-question verdict: **FAIL**.

## Discovery trail

| Order | Entry point, search, or navigation step | Path and heading discovered | Result |
|---:|---|---|---|
| 1 | Verified checkout identity, tree, cleanliness, and scoped instruction files | `AGENTS.md`, `v2/AGENTS.md` | Exact candidate checked out; worktree clean; authority order discovered |
| 2 | Read root and v2 instructions | `AGENTS.md` → Decisions; `v2/AGENTS.md` → Authority and reading order | Required local `decisions` procedure and constitutional entry point discovered |
| 3 | Loaded repository-required decision procedure | `.claude/skills/decisions/SKILL.md`, cold-read questions, template, provenance rules | Blind gate, quarantine, source-ledger, and verdict rules established |
| 4 | Read highest authority and decision index | `v2/VISION.md`; `docs/decisions/README.md` | Four current ADRs and supersession chain discovered |
| 5 | Inspected repository history only after discovering current authority | Candidate commit metadata and changed-path listing | Confirmed broad cutover candidate; quarantined paths were seen but not opened |
| 6 | Read all four current ADRs | 20260811, 20260812, both 20260813 records | Current outcome, retained scope, assumptions, trace owners, and deferrals reconstructed |
| 7 | Followed only linked non-review evidence | Three current decision trajectories | Human/agent events, alternatives, reversals, omissions, and source gaps reconstructed |
| 8 | Read current manifest lineage | `20260728-gate-1-architecture-freeze.md` → Supersession | Historical inventory correctly quarantined by its current Supersession section |
| 9 | Followed normative owners | `docs/spec/README.md`, layer interfaces, conversation history, harness, management, identity/router/enforcement chapters | Exact implementation and fault contracts reconstructed |
| 10 | Checked concrete package/public surface | Seven package manifests; Client contract/barrel/type canary | Seven packages and reduced Client shape match the normative graph |
| 11 | Searched current non-review repository text for retired vocabulary and unresolved choices | Historical slates and `docs/architecture.mdx` | Historical slates are marked superseded; current architecture page contains blocker B1 |
| 12 | Ran mechanical ADR integrity check | `pnpm exec tsx scripts/docs/adr/check-shape.ts` | PASS — 61 records well formed |
| 13 | Computed candidate digest and rechecked cleanliness | Git archive digest and `git status --short` | Digest recorded; no repository modifications |

## Author interventions

| Time | Intervention | Effect on review |
|---|---|---|
| None | No author message, hint, answer, or clarification was received | None |

## Blockers

| ID | Finding | Evidence | Required reconciliation |
|---|---|---|---|
| B1 | A current published architecture page presents the four resolved Client choices and their process coverage as pending | `docs/architecture.mdx` → **Client boundary during cutover**, versus the 20260812/20260813 ADR outcomes and `docs/spec/README.md` → **Implementation readiness** | Update the current architecture page to state the admitted reduced Client/daemon contract and implemented coverage; freeze a new candidate and use a different fresh reviewer |

## Checks

- `pnpm check:agent-setup`: PASS.
- `pnpm exec tsx scripts/docs/adr/check-shape.ts`: PASS, 61 records.
- Exact seven package manifests discovered with the required MoltZap dependency graph.
- Candidate remained clean and unmodified.
- No quarantined review content was opened or searched.

## Overall result

Result: **FAIL**

Questions 1–4 were accurate and independently discoverable. Question 5 found a current, unmarked stale architecture instruction that directly contradicts the admitted Client decisions and normative implementation-readiness statement. Although authority order tells an implementer which contract wins, repository law requires the lower current page to agree. That unresolved consistency defect also prevents question 6 from receiving a clean handoff verdict.

A maintainer must reconcile B1, freeze a new semantic candidate, and use a different fresh reviewer.
