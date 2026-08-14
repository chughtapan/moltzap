# Blind candidate review

## Run metadata

- Candidate: repository-content SHA-256 `835b72ba2c9f49389d0d47d8e80ae7afbc5d159f7326d0dfbaf57fdd53fdbb28`
- Repository: `/home/tapanc/moltzap-v2-cutover`
- Base HEAD: `f255c9a4`
- Started: `2026-08-13T07:46:56Z`
- Ended: `2026-08-13T07:54:18Z`
- Duration: 7 minutes 22 seconds
- Reviewer: `/root/cold_candidate_review_3`
- Isolation attestation: Fresh context; I did not author or reconcile the candidate. I received only the repository root, candidate digest, fixed questions, and quarantine instructions—no design summary, diff tour, expected answers, search term, or ADR/file pointer.
- Author interventions: None.
- Quarantine attestation: Two `*-invalid-review.md` paths appeared in `git status`. I did not open, read, or search their contents. All repository searches explicitly excluded `*-review.md` and `*-invalid-review.md`. No quarantined answer or verdict appeared in command output.
- Mutation attestation: Read-only throughout. Final `git status` matched the initial state.
- Mechanical observation: `git diff --check` was clean. The new ADR’s provenance paths and all three anchors resolve to independently discovered trajectory headings.

## Discovery trail

1. Listed the repository root, branch status, recent history, and ordinary files.
2. Read root `AGENTS.md`, which identifies `v2/VISION.md → The constitution` as canonical.
3. Discovered `docs/decisions/README.md`; its first row led to the new accepted ADR.
4. Followed the ADR’s provenance links into the new trajectory and verified its headings and source locators.
5. Followed lineage through:
   - `20260811-four-layer-endpoint-replicated-harness.md → Supersession`
   - `20260812-harness-client-uses-conversation-id.md → Decision Outcome`
   - `20260728-gate-1-architecture-freeze.md → Supersession`
6. Followed normative ownership into:
   - `docs/spec/conversation-history.md → Exact closed values`
   - `docs/spec/harness/tasks.md → Contention and automatic activation`
   - `docs/spec/harness/daemon.md → Explicit process configuration`
   - `docs/spec/harness/ingress.md → Raw MCP representation`
   - `docs/spec/harness/output.md → Raw MCP representation`
   - `docs/spec/management.md → Registration and status`
   - `docs/spec/layer-interfaces.md → Simulator cutover`
7. Checked current architecture orientation, package-scoped instructions, user-facing status pages, trace rows, and explicit historical/non-normative handoffs for stale conflicts.

## Independently discovered paths/headings

- `AGENTS.md → Project`, `Decisions`, `Docs`
- `v2/VISION.md → Authority`, `The constitution`, `Deliberate deferrals`
- `v2/AGENTS.md → Authority and reading order`, `Implementation rules`
- `docs/decisions/README.md → Canonical reading guidance`, `Records`
- `docs/decisions/20260813-client-protocol-and-attention.md → Decision Outcome`, `Consequences`
- `docs/decision-evidence/20260813-client-protocol-and-attention-trajectory.md → Source and omissions`, all three provenance headings, and the final implementation instruction
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md → Supersession`, `Guarantees and progress assumptions`, `Gate 1 traceability disposition`
- `docs/decisions/20260812-harness-client-uses-conversation-id.md → Decision Outcome`
- `docs/decisions/20260728-gate-1-architecture-freeze.md → Supersession`
- The normative specification headings listed in the discovery trail
- `docs/architecture/harness-implementation-slate.md`, whose header explicitly marks it historical, non-normative, and superseded

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

**Verdict: PASS**

The candidate makes current one closed, versioned, endpoint-owned Client protocol behind the unchanged semantic `HarnessClient`. It fixes:

- exact canonical evidence, hashes, signer sets, nested `SignedMessage` transport, resource limits, genesis anchor, catch-up, and re-anchor representation;
- subscription-gated, non-author automatic contention and durable attention consumption;
- the local MCP extension adapter, event and reply-grant representation;
- SQLite daemon state, exact process inputs, registration recovery, and MCP-only management DTOs; and
- removal of the five incompatible Simulator contract families.

It resolves choices explicitly identified in the ADR’s `Context and Problem Statement`: private evidence representation, initial Router anchoring, automatic contention activation, an MCP extension the official SDK cannot express directly, daemon/management representation, and Simulator compatibility conflicts.

Binding authority is:

1. `AGENTS.md` and `v2/VISION.md`;
2. the accepted ADR’s `Decision Outcome`;
3. the normative `docs/spec/` chapters named by the current trace table.

The decision index explicitly says an accepted ADR’s Decision Outcome is current, while context, consequences, examples, and historical reasoning are explanatory. The trajectory labels itself a non-normative source-event ledger. Architecture plans and handoffs label themselves non-normative. Deferrals repeated in `v2/VISION.md` and normative specs remain binding negative boundaries even when summarized under ADR consequences.

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

**Verdict: PASS**

No earlier accepted outcome is silently superseded. The candidate closes implementation deferrals left by the four-layer ADR and preserves the reduced Client ADR.

It retains:

- the four-layer stack and endpoint-replicated history from the 2026-08-11 ADR;
- one correct Registry, one correct Router, Byzantine endpoint assumptions, unanimous OpenFloor action validity, and separate durability thresholds;
- the 2026-08-12 `HarnessClient`: pre-minted `ConversationId`, `start`, current-conversation turns, content-only bound reply, and `void` completion;
- Identity as the only signing boundary and Router as opaque transport;
- the official MCP core, one loopback daemon endpoint, and MCP-only management; and
- every compatible Simulator facade and behavior.

It resolves or replaces previously unresolved behavior by:

- selecting nested stable inner `SignedMessage` evidence and replaceable outer Router envelopes;
- fixing Client canonical representation, limits, genesis anchor, re-anchor and catch-up detail;
- activating contention only for subscribed non-authors of remote actions;
- fixing consumed-attention persistence;
- fixing daemon configuration, SQLite state, registration recovery, MCP extension, management DTOs, and error mappings; and
- deleting content-free open, generic send, message-only/proof-shaped results, runtime Router/key/store authority, and Router commit/order events instead of shimming them.

It leaves Identity and Router wire behavior, the seven-package graph, and the absence of a product Ledger untouched.

The current contract lives in:

- `v2/VISION.md`;
- `20260811-four-layer-endpoint-replicated-harness.md`, as retained by its Supersession section;
- `20260812-harness-client-uses-conversation-id.md`;
- this accepted ADR;
- the current 2026-08-11 trace table; and
- `conversation-history.md`, `harness/tasks.md`, `harness/daemon.md`, `harness/ingress.md`, `harness/output.md`, `harness/client.md`, `management.md`, and `layer-interfaces.md`.

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

**Verdict: PASS**

An implementer must:

- Encode closed Client values as RFC 8785 canonical JSON with repository version and closed `kind`.
- Use the seven domain-separated SHA-256 labels and exact hash prefixes.
- Create deterministic self-addressed inner Identity messages for signatures, ACKs, durability votes, catch-up attestations, and re-anchor votes.
- Carry evidence in separate outer messages addressed to every fixed member, including the sender, permitting fresh outer `MessageId` only after `retry_identity_unknown`.
- Enforce 2–32 fixed members, 32,768 canonical content bytes, no fragmentation, and derived Identity-limit tests.
- Bind START genesis to membership, conversation, and the omitted-cursor Router instance.
- Implement one-item fixed-member catch-up and threshold re-anchor without guessing ancestry or selecting a head by Router order.
- Keep action unanimity separate from storage durability.
- Automatically contend only for an unconsumed, locally certified, remotely authored head while the endpoint owns the sole active subscription.
- Persist `(ConversationId, RecordHash)` immediately before the complete SSE frame and never offer or bid that head again after any write outcome or restart.
- Run one Client-owned SQLite/WAL endpoint store at the exact state-directory path and preserve the specified durable/volatile separation.
- Use the exact seven `MOLTZAPD_*` inputs, bind only `127.0.0.1`, and expose the exact pre-registration and active MCP catalogs.
- Delegate standard MCP behavior to the official pinned SDK while narrowly intercepting only the MoltZap listen extension.
- Preserve the public `HarnessClient`; keep protocol hashes, proofs, management, signing authority, and network clients private.
- Rewire Simulator and evals through real daemon-backed Client semantics and apply the five explicit removals.

An implementer must avoid a product Ledger, generic send, public proof/receipt, `TxnId`, protocol/server compatibility package, alternate MCP stack, profile system, CLI/socket, runtime network authority, compatibility shim, Router-order persistence claim, or automatic cross-conversation context.

Affected areas are communication/Client, tasks and norms, local personal trust/attention, daemon/MCP management, OpenClaw/NanoClaw consumers, Simulator, and evals. Identity and Router remain affected only through their existing public capabilities and limits; their representations are not changed.

Assumptions and guarantees are explicit:

- Registry and Router are correct and non-equivocating.
- Local operator and loopback MCP client are trusted.
- Endpoints may be Byzantine.
- OpenFloor actions remain unanimous; one honest required signer can prevent invalid certification.
- For `n >= 4`, at most `f=floor((n-1)/3)` Byzantine endpoints plus honest stage-before-sign yields at least `n-2f` honest staged replicas.
- For `n < 4`, storage completion is unanimous and its replicated-storage guarantee assumes zero Byzantine members.
- Safety does not depend on timing. Withholding, outages, missing ancestry, or missing quorum may halt progress without weakening verification.
- Router restart requires completed threshold re-anchor.
- Catch-up requires an available honest holder of retained ancestry.
- Copied state directories or duplicated private keys receive no global lease guarantee.
- Compatible Simulator contracts remain; five named families break intentionally. External-consumer compatibility and publication remain deferred.
- All sixteen eval definitions execute, but six cross-conversation cases may fail until host-native memory exists.

## 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

**Verdict: PASS**

The ADR names **Tapan Chugh** as the sole `decision-makers` value.

The trajectory identifies Codex TUI session `019fd899-779c-7e70-a8e4-338727b13e6c` and records:

- L3 signing and host memory request `fc_0fe7c1dd2e31cd97016a7d4fa1be4c819397c851716801b843`, `2026-08-13T05:01:27.667Z`, and result `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0`, `2026-08-13T05:02:14.424Z`, in turn `019ff969-5e2e-78b0-903f-2237aeae4010`.
  - Alternatives were `Nested SignedMessage`, `Compact attestation API`, and `Fragmented evidence`.
  - The result selected `Nested SignedMessage (Recommended)`.
  - Host-memory alternatives were host integration, unsupported cells, or adapter cache.
  - The result selected none and recorded: `just defer it now. let the evals fail`.
- Attention request `fc_0fe7c1dd2e31cd97016a7d515b37bc8193a752005aaf28d092`, `2026-08-13T05:08:47.345Z`, and result `fco_019ff989-86d8-7d83-92c1-16da24457d21`, `2026-08-13T05:12:47.576Z`, in turn `019ff984-906f-7400-b6f3-9251a37c831b`.
  - Alternatives were `Remote action only`, `Every action`, or defer live turns.
  - The result initially selected `Every action`.
- Human correction message `msg_019ff989-fa2d-76f0-8d83-7b09f663643a`, `2026-08-13T05:13:17.101Z`, stored role `user`: “actually fine to not content again”.
- Assistant interpretation message `msg_0fe7c1dd2e31cd97016a7d53f2c2f48193af0a0e94796ed417`, `2026-08-13T05:19:48.493Z`, stored role `assistant`, recorded the subsequent plan’s no-self-recontention interpretation.
- Human four-layer correction `msg_019ff993-e348-7272-9e3c-f5ddce9d116e`, `2026-08-13T05:24:06.601Z`, stored role `user`: “look at the 4 layer plan now”.
- Complete agent plan `msg_0fe7c1dd2e31cd97016a7d58c392bc8193bef23bb36ab9fc93`, `2026-08-13T05:41:01.581Z`, stored role `assistant`. It includes the final protocol, daemon, Simulator, test, assumption, and deferral slate.
- Human implementation instruction `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36`, `2026-08-13T05:41:53.563Z`, turn `019ff9a4-2966-7860-aa43-3a15b49343e8`, stored role `user`: “Implement the plan.”

Explicit source gaps and omissions:

- The root session has no parent thread.
- Public messages have enclosing turns but no parent-message or parent-turn locator.
- Function-call records have no parent locator and no stored actor role.
- Unrelated implementation status, tool output, hidden reasoning, and repeated summaries are omitted.
- Only the final plan’s enclosing tags were omitted; wording was otherwise not normalized.
- The source does not separately state motives, confidence, urgency, or a reason for every mechanism.
- It does not state every field, database table, error literal, or environment-variable name later supplied by repository specifications.

## 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

**Verdict: PASS**

The strongest apparent contradiction is the 2026-07-28 architecture-freeze inventory, which still contains binding-looking rows for a central Ledger, Transcript append, `LedgerOffset`, author-only completion, and Ledger reconciliation.

It is resolved explicitly:

- Its frontmatter is `partially-superseded`, with the 2026-08-11 four-layer ADR as replacement.
- Its `Supersession` section says the old inventory is an immutable historical snapshot and that affected rows follow the replacement ADR’s current trace table.
- That section points the exact Client surface to the 2026-08-12 ADR and the closed Client protocol, daemon, and Simulator cuts to this candidate.
- The 2026-08-11 trace table re-owns or replaces all affected `G1-DEC-*` rows and links their current normative owners.
- Root `AGENTS.md` makes `v2/VISION.md → The constitution` canonical; both state four layers, endpoint storage, and no product Ledger.

A secondary stale document, `docs/architecture/harness-implementation-slate.md`, still displays split MCP paths, profiles, Ledger recovery, and cross-conversation checkpoints. Its first lines explicitly mark it “historical implementation handoff; non-normative and superseded” and direct current work to the ADRs/specifications.

No unresolved contradiction or broken lineage remains.

## 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

**Verdict: PASS**

Yes. The candidate provides an indexed accepted ADR, valid provenance anchors, current lineage, stable trace rows, exact normative owners, closed value declarations, transport/signature rules, limits, attention state transition, daemon configuration/state, MCP DTOs and failures, Simulator removals, assumptions, and acceptance criteria.

No accidental gap or missing authority link was found. Database table layout, internal scheduling, and private helper structure are ordinary implementation mechanisms; they are not absent public decisions.

The unresolved choices discovered are all explicitly deliberate deferrals:

- Protocol evolution: dynamic membership, non-unanimous action certificates, public observers, alternate catch-up transports, larger resource profiles or fragmentation, encryption/key distribution, and non-member audit/disclosure protocols.
- Task/norm evolution: plural-action payload mapping, addressed turns, fairness/starvation freedom, pass/abort/renewal, disputes/remedies, signature compression, executable norm bundles, portable norm pins, and per-action runtime tools.
- Storage/recovery: pruning, compaction, garbage collection, disk-loss recovery, cross-process reply recovery, transactional-outbox mechanism, and global duplicate-key/copied-directory ownership.
- Delivery/operations: delivery acknowledgment, replay/resumable subscriptions, daemon-wide concurrency, queues, byte/record/frame budgets, and overload policy.
- Management: remote administration, query text, summaries, ranking, totals, full-text search, alternate page sizes, and later retention behavior.
- Compatibility/release: external-consumer compatibility treatment, package publication membership, version coordination, release ordering, and deployment/release cutover.
- Runtime memory: host-native cross-conversation memory; the six dependent eval cases may fail meanwhile.

None is needed to implement the admitted Gate 1 single-action, fixed-membership profile.

# Overall result: PASS

All six questions are accurate and independently discoverable. Status, lineage, authority, assumptions, normative ownership, source attribution, and explicit deferrals are consistent. No author hint was required, no quarantined content was consulted, and no blocker or accidental gap was found.

Maintainer acceptance remains required; this review is not self-certifying.
