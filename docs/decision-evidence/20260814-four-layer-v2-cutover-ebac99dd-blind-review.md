# Blind decision review

## Review identity

| Field | Value |
|---|---|
| Review run ID | `/root/blind_candidate_review_ebac99dd` |
| Candidate root | `/home/tapanc/moltzap-v2-cutover` |
| Candidate commit | `ebac99dd20e2d7679e9da761e97302874ace1d54` |
| Candidate tree | `f4f2343cf8dedcf1ae05bbf3027a65dddb0be35b` |
| Branch observed | `cutover/four-layer-v2-landing` |
| Reviewer | Fresh Codex sub-agent `/root/blind_candidate_review_ebac99dd` |
| Started | `2026-08-14T08:48:32Z` |
| Finished | `2026-08-14T08:55:26Z` |
| Duration | 6m 54s |
| Review budget | One uninterrupted fresh context, within the repository’s 45-minute ceiling |
| Worktree state | Clean before and after review |
| Author interventions | None |

## Isolation attestation

I did not author or reconcile this candidate. I received only the candidate root, exact commit, and fixed questions—no design summary, ADR pointer, expected answer, earlier review output, inherited candidate discussion, or author coaching.

I independently navigated through Git identity/history, the checked-in decision index, repository authority files, ADR lineage, specifications, provenance ledgers, package instructions, manifests, and public exports.

Two review-artifact paths appeared in commit path discovery:

- `docs/decision-evidence/20260814-four-layer-v2-cutover-24a09aa9-blind-review.md`
- `docs/decision-evidence/20260814-four-layer-v2-cutover-24a09aa9-wrong-hash-invalid-review.md`

I did not open, read, or search either artifact’s contents. No answer or verdict from a quarantined record was returned. I made no repository edits.

## Fixed questions and answers

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

This candidate does not admit a new architecture outcome. It reconciles the already-current four-layer cutover in two affected scopes:

- The retained 2026-07-28 daemon ADR now correctly says `HarnessClient` owns current-conversation runtime projection and does **not** maintain presentation checkpoints. Content observations and live reply grants remain separate.
- The Client, OpenClaw, and NanoClaw package instructions now classify their source as the final cutover implementation, not transitional rewrite input. They require maintenance behind the final reduced Client boundary and prohibit restoring retired machinery through compatibility facades.

The problem resolved is stale authority language: the old retained-scope sentence incorrectly carried checkpoints forward despite the accepted reduced Client, while package instructions still described completed cutover source as awaiting replacement.

Binding material is:

- `AGENTS.md`, scoped package `AGENTS.md`, and `v2/VISION.md`;
- the explicit `Supersession` scope of partially superseded ADRs;
- accepted current outcomes in `20260812-harness-client-uses-conversation-id.md` and `20260813-client-protocol-and-attention.md`;
- the still-current portions of `20260811-four-layer-endpoint-replicated-harness.md`;
- normative `docs/spec/` chapters.

For `20260728-endpoint-daemon-speaks-modern-mcp.md`, only its visible retained `Supersession` scope is current. Its profile, Ledger, watermark, receipt, `TxnId`, and old package language in the historical Decision Outcome is not binding. Context/problem statements, historical considered alternatives, consequences, provenance ledgers, architecture handoffs, and the record changelog are explanatory or evidentiary, not independent authority.

Verdict: **PASS**.

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

Retained from the 2026-07-28 daemon decision, where independent of profiles or Ledger:

- the pinned MCP core and official SDK boundary;
- modern Streamable HTTP framing;
- one loopback listener;
- discovery;
- sole local subscription ownership;
- trusted-local access and Origin validation;
- acknowledgment-before-notification ordering;
- transient at-most-once delivery;
- daemon-specific supervision.

Replaced by the four-layer cutover:

- named profiles and profile selectors;
- split registration/active MCP paths;
- Ledger state, receipts, offsets, and reconciliation;
- the product Ledger and Transcript services;
- old package ownership;
- universal cross-conversation presentation and checkpoints.

The 2026-08-11 four-layer ADR remains current for the four-layer model, endpoint-replicated certified history, durability thresholds, catch-up, re-anchor, recursive social features, daemon topology, seven-package graph, and cutover. Its four original Client-interface deferrals and proof-shaped success result were replaced by the accepted 2026-08-12 Client ADR.

The 2026-08-12 ADR fixes caller-minted `ConversationId`, identical-intent retry, one current-conversation certified action per turn, content-only bound reply, `void` completion after local certification, MCP-only management, and no `TxnId`, checkpoints, generic send, or public proof.

The 2026-08-13 ADR owns the exact private Client representation, attention consumption, MCP extension, daemon configuration/management representation, registration recovery, and Simulator cuts.

Identity and Router contracts, local trust assumptions, and publication/version deferral remain untouched.

Current normative ownership is discoverable through:

- `v2/VISION.md`;
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md`;
- `docs/decisions/20260812-harness-client-uses-conversation-id.md`;
- `docs/decisions/20260813-client-protocol-and-attention.md`;
- `docs/spec/harness/daemon.md`;
- `docs/spec/management.md`;
- `docs/spec/harness/ingress.md`;
- `docs/spec/harness/client.md`;
- `docs/spec/harness/output.md`;
- `docs/spec/conversation-history.md`;
- `docs/spec/layer-interfaces.md`.

Verdict: **PASS**.

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- Maintain exactly the seven-package graph. Client depends only on Identity and Router; OpenClaw and NanoClaw depend only on Client.
- Keep `HarnessClient` structural and scoped, with `start` and `turns`; mint `ConversationId` before START.
- Make identical canonical START retries resume and changed peers/content conflict.
- Project exactly one current-conversation certified action per turn.
- Keep reply as a content-only closure bound to its originating live turn.
- Return `void` from START and reply only after the local endpoint durably stores the complete certified record.
- Run one explicitly configured `moltzapd` per state directory/AgentId with one SQLite WAL store and one `127.0.0.1:<port>/mcp` listener.
- Use the exact state-dependent MCP catalogs, sole listener, acknowledgment ordering, and Client-owned extension.
- Persist `(ConversationId, RecordHash)` consumption before the turn frame; a failed or ambiguous write may lose the turn but cannot cause another bid, offer, or replay.
- Keep content/history distinct from live reply authority.
- Keep Registry/Router representations and credentials at their owners.

An implementer must avoid:

- profiles, profile acquisition, split MCP paths, stdio, Unix RPC, bespoke CLI, secondary listener, dynamic discovery, or bind fallback;
- product Ledger, Transcript service, offsets, receipts, `TxnId`, public hashes, protocol messages, proof-shaped runtime results, or presentation checkpoints;
- generic established-conversation send or reply by identifier;
- service/channel-core/protocol-server compatibility facades;
- adapters importing Identity, Router, Client internals, simulator, evals, or one another;
- rebuilding reply authority from history, a later turn, or `ConversationId`.

Affected surfaces are endpoint-owned Communication, Client-owned task/norm and personal-trust composition, daemon/runtime MCP, OpenClaw, NanoClaw, Simulator, and eval consumers. Identity and Router remain independent lower-boundary services rather than being redesigned.

Assumptions:

- Registry and Router are correct and non-equivocating; malicious/equivocating service profiles are outside Gate 1.
- Endpoints may be Byzantine.
- For `n >= 4`, `f=floor((n-1)/3)` and `n-f` storage votes provide at least `n-2f` honest staged replicas under honest stage-before-sign and non-double-vote assumptions.
- For `n < 4`, unanimity is required and the replicated-storage guarantee tolerates zero Byzantine members.
- Action validity remains unanimous OpenFloorV1 and is separate from durability.
- Safety is timing-independent. Progress requires available Registry/cached identity as applicable, Router availability, enough responsive action signers and storage voters, and an honest reachable source for missing ancestry.
- Registry, Router, quorum, or source unavailability may halt progress without invalidating certified local history.
- Loopback clients and the local operator are trusted; hostile-host defense and local authorization are deferred.
- Compatibility preserves only host behavior fitting the reduced boundary. No compatibility shim may restore removed semantics. Publication/version and external-consumer compatibility remain separate decisions.

The actual manifests independently confirm seven products and the specified production dependency edges.

Verdict: **PASS**.

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

The relevant ADR frontmatter names one accountable human: **Tapan Chugh**. The ledgers explicitly warn that stored `user` roles do not independently authenticate a person, so I do not attribute session messages beyond their recorded roles.

Key source events discovered:

- In `20260728-gate-1-engineering-review-trajectory.md → The endpoint daemon exposes modern MCP over loopback HTTP`, session `019fa633-abe3-7223-8c51-6d061f5c5855` records:
  - the user’s stdio-to-HTTP reversal at `2026-07-28T04:14:43.733Z`;
  - trusted-local security deferral at `2026-07-28T04:18:26.761Z`;
  - “only one per daemon; both cannot race” after the adapter-concurrency prompt at `2026-07-28T04:37:34.722Z`.
  - Its explicit source-gap statement says the pinned MCP commit, discovery metadata, error codes, subscription frames, port/profile rules, compare-and-swap watermarks, delivery-loss behavior, and receipt design came from assistant-authored review/repository edits rather than separate user selections.

- In `20260801-harness-mcp-and-dispatch-trajectory.md → Harness vocabulary and one profile-slot daemon`, session `019fba0c-9f1e-7911-9496-45b305a00cb5` records:
  - per-AgentId daemon and MCP-only adapters (`msg_019fba20-fa77-7382-883d-eac56b1fbde6`);
  - moving CLI workflows to MCP and later removing the bespoke CLI;
  - the FastMCP A/B/C prompt and user answer `C`, selecting no FastMCP (`msg_019fba4a-f475-7261-bdfc-3b8d7c97993f`);
  - the runtime/admin split prompt and user answer `A`;
  - the listen-contract explanation and “okay, so that contract should be fixed”;
  - one MCP server and “the daemon can handle both the things”;
  - transient versus reliable delivery and “okay lets keep that”;
  - shared raw extension `C`, later replaced by the user’s client-side correction and “okay lets do A for now” for different MCP wires with an identical Client interface;
  - rejection of public `turnId`;
  - independent implementations selected with `A`, rejection of v1/v2 public labels and earlier application names;
  - final `HarnessClient`/`moltzapd` vocabulary approval.
  - The ledger marks assistant proposals as such, retains “for now” without strengthening it, and records the exact production credential mechanism as qualified rather than selected.

- In `20260811-four-layer-v2-cutover-trajectory.md`:
  - the initial four-layer/endpoint-history request is `msg_019ff1f8-2124-73e2-8e49-7559e6b8b43d`;
  - planning selections retain the earlier five-layer answer and its later replacement by Four layers;
  - the user selects trusted Router, fixed one-third storage threshold with unanimity below four, any-member finalization, automatic catch-up, separate action/durability certificates, explicit daemon configuration, `@moltzap/client`, all-v1 cutover, final package names, and long-lived branch;
  - the earlier “Local record proof” selection is later replaced by the reduced Client decision;
  - `set this plan as your goal` adopts the retained execution proposal but expressly does not itself admit every interface detail;
  - Registry recovery mismatch is answered as failure, while unresolved recovery work is explicitly deferred with “just skip fighting the registry … open this as an issue and proceed.”
  - Under `Reduced HarnessClient boundary`, the user asks why `TxnId` remains, requests further simplification, receives the exact reduced-boundary proposal, and answers “accept the reduced boundary” (`msg_019ff852-c742-7480-b464-fdae2792c6ad`, `2026-08-12T23:33:22.370Z`).
  - The ledger states the initial four-layer request did not specify the final record type, threshold, API, or disclosure protocol; those required later selections or repository authority.

- In `20260813-client-protocol-and-attention-trajectory.md`:
  - nested `SignedMessage` is selected;
  - host memory receives the user note “just defer it now. let the evals fail”;
  - “Every action” is selected for attention, then immediately reversed by `msg_019ff989-fa2d-76f0-8d83-7b09f663643a`: “actually fine to not content again”;
  - the user corrects the plan to the four-layer track;
  - the complete implementation plan is followed by `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36`: “Implement the plan.”
  - Its explicit source-gap statement says the source does not separately state motives, confidence, urgency, reasons for each mechanism, every protocol field, database table, error literal, or environment-variable name; those are repository-owned specifications and implementation details.

All cited provenance anchors resolved. No source event was treated as stronger than the ledger states.

Verdict: **PASS**.

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest apparent contradiction is the old 2026-07-28 freeze and daemon body language asserting profiles, Ledger/`TxnId`, cross-conversation projection, watermarks, receipts, and presentation checkpoints, while the current Client says one current-conversation action and no checkpoint.

It resolves cleanly:

1. Both old records are `partially-superseded`.
2. Their visible `Supersession` sections state that the old bodies/inventory are historical where replaced.
3. The architecture-freeze Supersession explicitly says its table is an immutable 2026-07-28 snapshot and that the 2026-08-11 replacement table owns current dispositions.
4. Current trace rows `G1-DEC-622`, `624`, `634`, and `638` replace offsets/checkpoints and resolve current-conversation-only behavior.
5. The accepted 2026-08-12 Client ADR and `docs/spec/harness/client.md → Public values` make the current contract explicit.
6. The candidate’s corrected retained-scope sentence now agrees with this chain.

The non-normative pre-cutover handoffs similarly contain transitional source descriptions, but they are labelled handoff/historical material and lose to scoped package law, current ADRs, and specs. They are not implementation authority.

No unresolved contradiction or broken lineage remains.

Verdict: **PASS**.

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Yes. The current daemon, Client, adapter, package, MCP, durability, attention, and failure contracts are sufficiently specified without chat. Paths, ownership, representation, thresholds, success semantics, exact catalogs, environment inputs, error boundaries, and acceptance criteria are checked in.

Deliberate deferrals, grouped by owner:

- **Release/compatibility:** which products publish, coordinated versus independent versions, release ordering, deployment cutover, and treatment of external consumers.
- **Storage/recovery:** pruning, garbage collection, post-certificate retention policy, recovery after local disk loss, copied-directory/global duplicate-key ownership.
- **Runtime delivery:** delivery acknowledgment/replay, resumable subscriptions, cross-process reply recovery, daemon-wide queue/concurrency/byte/overload limits.
- **Daemon security/operations:** hostile-host/local authentication, dynamic ports/discovery, remote administration, universal supervision.
- **Protocol evolution:** dynamic membership, fragmentation/larger resource profiles, plural-action payload mapping, richer norms, pass/abort/renewal/takeover/dispute protocols, non-unanimous action certificates.
- **Trust/system evolution:** malicious or replicated Registry/Router, encryption/key distribution, public observers, cross-history audit/disclosure conventions, portable personal-trust protocols.
- **Host features:** host-native cross-conversation memory; the affected eval cases may fail rather than restoring Client-owned context.
- **Management evolution:** future query text, summaries, ranking, totals, full-text search, alternate page sizes.

These are explicitly negative boundaries; none must be guessed to implement Gate 1. I found **no accidental gap** in the reviewed scope.

Verdict: **PASS**.

## Independently discovered paths/headings

- `AGENTS.md → Decisions`, `Docs`
- `.claude/skills/decisions/SKILL.md → Blind review gate`
- `.claude/skills/cold-read/references/questions.md`
- `docs/decisions/README.md → Canonical reading guidance`, `Records`
- `v2/AGENTS.md → Authority and reading order`, `Final product graph`
- `v2/VISION.md → Authority`, `The constitution`, `First executable profile`, `Deliberate deferrals`
- `docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md → Supersession`, `Record changelog`
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md → Supersession`, `Guarantees and progress assumptions`, `Gate 1 traceability disposition`
- `docs/decisions/20260812-harness-client-uses-conversation-id.md → Decision Outcome`
- `docs/decisions/20260813-client-protocol-and-attention.md → Decision Outcome`
- `docs/spec/harness/daemon.md`
- `docs/spec/harness/client.md`
- `docs/spec/harness/ingress.md`
- `docs/spec/harness/output.md`
- `docs/spec/management.md`
- `docs/spec/layer-interfaces.md`
- the four provenance trajectories cited above
- `packages/client/AGENTS.md`
- `packages/openclaw-channel/AGENTS.md`
- `packages/nanoclaw-channel/AGENTS.md`
- all seven package manifests and `packages/client/src/index.ts`

## Discovery trail

| Order | Navigation step | Result |
|---:|---|---|
| 1 | Verified commit, clean worktree, commit paths, and repository tree | Exact candidate matched; quarantine paths recorded only |
| 2 | Read decision index | Found authority order, current statuses, and endpoint-daemon lineage |
| 3 | Read root/v2 agent law and Vision | Established binding hierarchy, current cutover, assumptions, and deferrals |
| 4 | Read the changed ADR/package instructions and non-quarantined diff | Identified the checkpoint correction and final-package-state reconciliation |
| 5 | Followed replacement ADRs and trace table | Reconstructed retained/replaced outcomes and normative owners |
| 6 | Read current harness and package-interface specifications | Verified implementer obligations, failures, trust, liveness, and compatibility |
| 7 | Followed every relevant provenance anchor | Verified calls, alternatives, reversals, deferrals, and explicit source gaps |
| 8 | Checked manifests and Client public barrel | Confirmed seven packages, dependency edges, exports, and reduced Client surface |
| 9 | Searched current authority and historical orientation for stale terms | Found and resolved the historical checkpoint/profile/Ledger conflict by status and authority order |

## Blockers

None.

## Overall result

**PASS**

All six answers are accurate and independently discoverable. Candidate identity, status, lineage, current normative ownership, assumptions, source-event attribution, and package boundaries are consistent. The strongest stale material is explicitly historical or superseded and resolves through the checked-in authority order. No source locator is broken, no current decision requires an invented choice, and no author hint was needed.

This reviewer result remains evidence; maintainer acceptance is still required.
