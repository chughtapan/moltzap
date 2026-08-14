# Blind teammate review

## Review identity

| Field | Value |
|---|---|
| Review run ID | `blind-candidate-review-02711893-20260814T065430Z` |
| Candidate commit | `027118932cc2df6ce30297806729b16c3c4e9cb3` |
| Candidate tree | `1e41ed2118dd7e14b82464522692fe47ba244621` |
| Content digest | Git SHA-1 tree digest `1e41ed2118dd7e14b82464522692fe47ba244621` |
| Digest scope and command | Entire candidate tree; `git rev-parse 027118932cc2df6ce30297806729b16c3c4e9cb3^{tree}` |
| Reviewer | Codex fresh sub-agent `/root/blind_candidate_review_02711893` |
| Reviewer session | `/root/blind_candidate_review_02711893` |
| Review started | `2026-08-14T06:54:30Z` |
| Review finished | `2026-08-14T07:00:05Z` |
| Duration | 5 minutes 35 seconds |
| Review budget | One uninterrupted fresh context; no numerical budget supplied |
| Rerun of | None disclosed |
| Author interventions | None |

Candidate HEAD matched the requested commit. The worktree was clean before and after review.

## Isolation attestation

- [x] I did not author or reconcile the candidate.
- [x] I received no inherited candidate conversation, summary, memory, private state, or earlier blind-review output.
- [x] I received only the repository root, candidate commit, fixed questions, and isolation/quarantine instructions.
- [x] I received no design summary, diff tour, ADR/file pointer, search term, expected answer, or answer key.
- [x] I navigated through repository-native indexes, ordinary history, scoped search, and independently discovered files.
- [x] I did not open, read, or search the contents of any `*-cold-review.md`, `*-blind-review.md`, or `*-invalid-review.md` artifact. Artifact names appeared in the candidate file list only; no prior answer or verdict was returned.
- [x] I did not ask the author for help or modify the candidate.
- [x] Author interventions were none.

## Exact fixed questions

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

## 1. Current decisions, problem, and authority

The candidate makes two accepted decisions current.

First, Client owns one closed, versioned endpoint protocol, durable attention consumption, and the exact local daemon/MCP representation behind the unchanged semantic `HarnessClient`. This closes previously unresolved choices for:

- canonical private evidence, hashes, signatures, Router envelopes, resource limits, genesis anchoring, catch-up, and re-anchoring;
- automatic attention activation and durable consumed-head behavior;
- the MCP extension, daemon configuration, SQLite state, registration recovery, catalog, management DTOs, and errors; and
- the five incompatible Simulator contracts.

Second, an explicitly activated Simulator directed-link fault scope may perturb post-Router delivery before recipient Client consumption. With no active scope, delivery preserves exact `SignedMessage` bytes and recipient Router order. An active scope may drop, delay, hold, or reorder delivery for endpoint-recovery testing without changing Router state or contracts.

The problems resolved are independently interoperable daemon implementation, the official MCP SDK’s inability to represent the admitted extension filter directly, migration of Simulator to the real daemon-backed stack, and preservation of directed-link fault testing without weakening Router conformance.

Binding statements are:

- `AGENTS.md` and `v2/VISION.md`;
- the `Decision Outcome` sections of the two accepted 2026-08-13 ADRs and retained current portions of earlier ADRs;
- the normative `docs/spec/` chapters named by the trace table.

The ADR context sections explain the problem. Consequences and architecture pages explain effects and implementation orientation. The two trajectories explicitly identify themselves as non-normative evidence ledgers. Implementation code is evidence/conformance, not normative authority. ADR frontmatter is authoritative for status.

Independently discovered paths/headings:

- `docs/decisions/README.md` → “Canonical reading guidance”, “Records”
- `docs/decisions/20260813-client-protocol-and-attention.md` → “Decision Outcome”
- `docs/decisions/20260813-simulator-link-faults-perturb-delivery.md` → “Decision Outcome”
- `v2/VISION.md` → “Authority”, “The constitution”, “First executable profile”
- `docs/spec/README.md` → “Authority and reading order”

Per-question verdict: **PASS**.

## 2. Replacement, retention, and normative ownership

The candidate retains:

- the four-layer system and endpoint-replicated certified history from `20260811-four-layer-endpoint-replicated-harness.md`;
- the reduced `HarnessClient` contract from `20260812-harness-client-uses-conversation-id.md`;
- existing Identity and Router representations, authentication, bounds, and production guarantees;
- unanimous OpenFloor action validity, separate durability thresholds, catch-up, re-anchor, local trust, the seven-package graph, and simulation `RunLedger`;
- compatible Simulator facades and behaviors.

It resolves or replaces:

- the remaining Client representation, initial-anchor, attention-trigger, MCP, daemon-management, and resource-limit deferrals;
- content-free conversation opening, generic established send, message-only receive/proof results, runtime Router/key/store authority, and persisted Router-order/commit events;
- the previously unresolved Simulator fault boundary with private post-Router perturbation.

It leaves untouched:

- Router’s production non-equivocating order and opaque delivery contract;
- Registry, Client, and `moltzapd` production interfaces during faulted runs;
- the five Simulator removals;
- publication/version policy and other explicit deferrals.

The earlier architecture-freeze inventory still contains eight-layer, Ledger, six-package, and old MCP rows, but its visible `Supersession` section declares those rows a historical snapshot and directs readers to the current replacement ADR trace table. The four-layer ADR remains partially superseded only for the Client-interface portion replaced by the 2026-08-12 record; its core outcome remains current.

The current normative contract lives in:

- `v2/VISION.md`;
- the two new accepted ADRs;
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` → retained outcome and “Gate 1 traceability disposition”;
- `docs/spec/conversation-history.md`;
- `docs/spec/harness/client.md`;
- `docs/spec/harness/daemon.md`;
- `docs/spec/harness/ingress.md`;
- `docs/spec/harness/output.md`;
- `docs/spec/harness/tasks.md`;
- `docs/spec/management.md`;
- `docs/spec/layer-interfaces.md`.

Per-question verdict: **PASS**.

## 3. Implementation obligations and assumptions

An implementer must:

- Encode Client protocol values as closed Effect Schemas using RFC 8785 canonical JSON.
- Use the specified domain-separated SHA-256 hashes and exact prefixes.
- Represent stable ACK, action, durability, catch-up, and re-anchor evidence as deterministic self-addressed inner `SignedMessage` values, transported in separately replaceable all-member outer messages.
- Enforce 2–32 fixed members, at most 32,768 canonical content bytes, no fragmentation, and derived compliance with Identity’s existing limits.
- Bind START genesis to the current `RouterInstanceId`, preserve unanimous action certification, stage before durability voting, apply the specified durability threshold, support any-member completion, verified catch-up, and threshold re-anchor.
- Persist identity, START intent, memberships/cards, anchors, staged/partial evidence, certified history, and consumed attention in the one WAL-mode SQLite database.
- Keep cursors, grants, subscriptions, frames, folds, and reply closures volatile.
- Automatically contend only for an unconsumed locally certified remote-authored head while the sole reply-capable listener exists. The author must not self-contend.
- Persist `(ConversationId, RecordHash)` immediately before the one complete SSE frame and never re-offer or bid that head after any post-commit write outcome or restart.
- Preserve the exact state-dependent MCP catalog, extension, tool DTOs, error mappings, seven daemon inputs, and registration recovery contract.
- Preserve the semantic `HarnessClient` as caller-minted `ConversationId`, `start`, one-action turns, and content-only bound reply returning `void` after local certified durability.
- Remove the five incompatible Simulator surfaces without aliases, inert fields, semantic reinterpretation, or hidden raw authority.
- Keep fault interception private and run-scoped after Router ordering. The inactive path must be byte/order transparent. A faulted run must be classified as endpoint-tolerance evidence, never Router-conformance evidence.
- Give application runtimes only loopback MCP or injected `HarnessClient`; never keys, admission material, Registry/Router origins or credentials, fault controls, or endpoint stores.
- Maintain exactly the seven-package dependency graph.

Affected layers and consumers are endpoint-owned Communication, Tasks/norms, Personal trust, `@moltzap/client`, `moltzapd`, OpenClaw, NanoClaw, Simulator, and Evals. Identity and Router retain their existing public contracts.

Trust and fault assumptions:

- one correct non-equivocating Registry;
- one correct non-equivocating Router;
- potentially Byzantine endpoints;
- for `n >= 4`, at most `f = floor((n - 1) / 3)` Byzantine members for the `n - 2f` honest-staged-replica guarantee;
- for `n < 4`, zero Byzantine members for the replicated-storage guarantee;
- trusted local operator and loopback MCP client;
- no global lease or copied-directory/duplicated-key detection guarantee.

Safety is timing-independent. Progress requires pinned/resolvable identities, Router availability, unanimous action signers, the durability or re-anchor threshold, and an honest reachable ancestry source when catch-up is needed. Withholding, unavailable quorum, Router outage, held/dropped Simulator delivery, or missing ancestry may halt progress without weakening verification or certified history. The six cross-conversation eval cases may fail until host-native memory exists.

Per-question verdict: **PASS**.

## 4. Decision-makers, events, reversals, deferrals, and source gaps

Both new ADRs name **Tapan Chugh** as the human decision-maker.

### Client protocol and attention trajectory

Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.

- `fc_0fe7c1dd2e31cd97016a7d4fa1be4c819397c851716801b843` at `2026-08-13T05:01:27.667Z` presented:
  - nested `SignedMessage`;
  - compact attestation API;
  - fragmented evidence;
  - implement host memory;
  - mark unsupported;
  - adapter context cache.
- `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0` at `2026-08-13T05:02:14.424Z` records selection of nested `SignedMessage` and the human note: “just defer it now. let the evals fail.”
- `fc_0fe7c1dd2e31cd97016a7d515b37bc8193a752005aaf28d092` at `2026-08-13T05:08:47.345Z` presented remote-only attention, every-action attention, and deferral.
- `fco_019ff989-86d8-7d83-92c1-16da24457d21` at `2026-08-13T05:12:47.576Z` records the initial selection “Every action.”
- Human message `msg_019ff989-fa2d-76f0-8d83-7b09f663643a` at `2026-08-13T05:13:17.101Z` immediately corrected that selection: “actually fine to not content again”.
- Assistant message `msg_0fe7c1dd2e31cd97016a7d53f2c2f48193af0a0e94796ed417` at `2026-08-13T05:19:48.493Z` records the applied interpretation: no self-recontention; only another member’s action triggers contention.
- Human message `msg_019ff993-e348-7272-9e3c-f5ddce9d116e` at `2026-08-13T05:24:06.601Z` says “look at the 4 layer plan now,” excluding the older central-Ledger track.
- Assistant message `msg_0fe7c1dd2e31cd97016a7d58c392bc8193bef23bb36ab9fc93` at `2026-08-13T05:41:01.581Z` contains the complete implementation plan.
- Human message `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36` at `2026-08-13T05:41:53.563Z` says “Implement the plan.”

The function-call records have no stored actor role and no parent locator. The root session has no parent thread. The ledger omits unrelated implementation status, tool output, hidden reasoning, and repeated summaries. It explicitly says the source does not separately state motives, confidence, urgency, reasons for individual mechanisms, or every field/table/error/environment name.

### Simulator link-fault trajectory

Source session: `019fd899-779c-7e70-a8e4-338727b13e6c`.

- Assistant message `msg_0fe7c1dd2e31cd97016a7dd586aa0c819380b891ef21a26512` at `2026-08-13T14:32:47.690Z` presented:
  - order-safe faults that stall at the held global position; or
  - deletion-first removal of directed-link controls.
- Human messages:
  - `msg_019ffc35-0352-7773-8385-27cd5007f44a` at `2026-08-13T17:39:20.530Z`: “I think life-level ordering is fine for the simulator. that”
  - `msg_019ffc35-0365-7dc3-bede-dd08ccfb4e38` at `2026-08-13T17:39:20.549Z`: “that's the point of testing right”
- Assistant message `msg_0fe7c1dd2e31cd97016a7e01710a1c8193b46e90aaf91bdc8e` at `2026-08-13T17:40:05.109Z` records the applied interpretation of “life-level” as “link-level,” allowing explicit post-Router perturbation for fault-tolerance evidence.

The two human messages are explicitly identified as the decision events; the assistant message records the interpretation. The ledger preserves “life-level” literally and marks four omitted leading status bullets. It records no source selection of an inter-process transport, authentication scheme, port, deployment object, or wire representation for the private interception path.

The ADR provenance anchors resolve to the cited trajectory headings.

Per-question verdict: **PASS**.

## 5. Strongest apparent contradiction or stale instruction

The strongest apparent contradiction is in historical architecture material:

- `docs/architecture/harness-implementation-slate.md` still describes `v2/harness`, Registry/Router/Ledger composition, `TxnId`, cross-conversation presentation checkpoints, split `/register/mcp` and `/mcp`, and retained Ledger recovery.
- `docs/architecture/l1-l2-implementation-ask.md` still contains a six-package graph with transcript, harness, and testbed.
- The body of `docs/decisions/20260728-gate-1-architecture-freeze.md` still contains historical eight-layer, central-Ledger, and old MCP trace rows.

This is resolved by the authority order and explicit status markers:

- `harness-implementation-slate.md` begins “historical implementation handoff; non-normative and superseded.”
- `l1-l2-implementation-ask.md` begins “HISTORICAL IMPLEMENTATION HANDOFF — SUPERSEDED BY THE FOUR-LAYER CUTOVER.”
- The architecture-freeze ADR is `partially-superseded`; its `Supersession` section says the old inventory is an immutable historical snapshot and directs readers to `v2/VISION.md`, the replacement trace table, and current specifications.
- Higher authority—root agent law, `v2/VISION.md`, current ADR outcomes, then normative specifications—uniformly requires four layers, no product Ledger, seven packages, no `TxnId`, one `/mcp`, current-conversation turns, and the post-Router Simulator fault boundary.

No unresolved contradiction or broken lineage remains.

Per-question verdict: **PASS**.

## 6. Implementability and unresolved choices

Yes. A teammate can implement the decisions from the repository without chat or guessing. The exact closed values, hashes, envelopes, limits, persistence categories, state transitions, public capabilities, tools, DTOs, errors, configuration, simulator removals, fault guarantees, assumptions, and acceptance criteria all have discoverable normative owners.

Deliberate deferrals are:

- plural legal-action payload mapping;
- cross-process reply recovery;
- dynamic membership and membership/key epochs;
- non-unanimous action certificates, addressed turns, richer norms, fairness, pass/abort/renewal/takeover, disputes, witnesses, and public audit/disclosure protocols;
- pruning, garbage collection, compaction, local disk-loss recovery, and alternate catch-up transports;
- fragmentation and later/larger resource profiles;
- end-to-end encryption and key distribution;
- delivery acknowledgment/replay, resumable subscriptions, queue/concurrency/overload limits;
- remote administration and global copied-directory/duplicate-key ownership detection;
- publication membership, package-version coordination, release/deployment policy, and external-consumer compatibility;
- host-native cross-conversation memory.

The private Simulator interposition’s exact IPC transport, authentication, port, deployment object, and wire mechanism are deliberately mechanism-free, not missing binding choices: any implementation must remain private, run-scoped, post-Router, byte-preserving, inaccessible to application runtimes, and compliant with the stated observable guarantees.

The Client trajectory’s source gaps concerning human selection of field names, database tables, error literals, and environment variables are not implementation gaps because the normative specifications provide those executable details.

Accidental gaps found: **none**.

Per-question verdict: **PASS**.

## Discovery trail

| Order | Navigation step | Independently discovered path/heading | Result |
|---:|---|---|---|
| 1 | Verified candidate and listed changed paths | Git HEAD/tree and candidate file names | Exact clean candidate; quarantined paths seen only as names |
| 2 | Opened repository decision index | `docs/decisions/README.md` → “Records” | Found two new accepted ADRs |
| 3 | Read both accepted records | Their `Decision Outcome`, guarantees, isolation, consequences | Identified the two current decisions |
| 4 | Followed provenance links | Both 2026-08-13 trajectory files and cited stable headings | Reconstructed decisions, alternatives, correction, deferral, and source gaps |
| 5 | Followed authority guidance | `AGENTS.md`, `v2/AGENTS.md`, `v2/VISION.md` | Established authority order and four-layer constitution |
| 6 | Loaded the repository-required decision procedure | `.claude/skills/decisions/SKILL.md`; cold-read questions/template | Confirmed gate, quarantine, and result requirements |
| 7 | Followed current lineage | 2026-08-11 and 2026-08-12 ADRs; architecture-freeze `Supersession` | Reconstructed retained/replaced scope |
| 8 | Read normative owners | Conversation history, Client, daemon, ingress, output, tasks, management, layer interfaces | Verified exact implementation contract and assumptions |
| 9 | Searched current docs for stale terminology | Current specs, orientation, package instructions | Found no current-authority Ledger/eight-layer contradiction |
| 10 | Inspected strongest stale-looking pages | Historical Harness and L1/L2 handoffs | Explicitly quarantined as superseded/non-normative |
| 11 | Inspected package graph and Simulator fault implementation boundary | Package manifests, scoped AGENTS, Simulator network/run modules | Consistent seven-package graph and private fault interposition |
| 12 | Rechecked repository state | Git status and `git diff --check` | No modifications; no whitespace error |

## Author interventions

None.

## Blockers

None.

## Overall result

**PASS**

All six answers were independently discoverable and consistent across status, lineage, authority, normative ownership, trust/fault assumptions, compatibility cuts, and source-event attribution. Provenance anchors resolve, historical contradictions are explicitly superseded, no binding choice requires chat or invention, and no quarantined review content was accessed.

## Maintainer acceptance

| Field | Value |
|---|---|
| Maintainer | `Tapan Chugh` |
| Reviewed result | `blind-candidate-review-02711893-20260814T065430Z` |
| Candidate identity matches | `yes` |
| Gate decision | `PENDING` |
| Decision time | `pending` |
| Rationale | Maintainer acceptance is not inferred from implementation or shipping authorization. |

## Rerun identity

| Field | Value |
|---|---|
| Superseded by review run | `none` |
| Superseded candidate commit | `none` |
| Superseded candidate content digest | `none` |
| Reason a rerun was required | `none` |
