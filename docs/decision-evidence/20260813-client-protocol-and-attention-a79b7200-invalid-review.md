# Blind decision review

## Review identity

| Field | Value |
|---|---|
| Review run ID | `cold_candidate_review_2-20260813T071953Z` |
| Candidate root | `/home/tapanc/moltzap-v2-cutover` |
| Branch | `cutover/four-layer-v2` |
| Candidate HEAD | `f255c9a425e50597f38b6ec106b0c56ed6ea9370` |
| HEAD tree | `dc3d7f1917c2ad9a9593d9de0def7794c3488f9d` |
| Semantic worktree-delta digest | SHA-256 `a79b7200e2bcd0a1bfd3438d7725c765c418132adff59ab91198179381bf2a1d` |
| Reviewer | Fresh Codex sub-agent `/root/cold_candidate_review_2` |
| Started | `2026-08-13T07:19:53Z` |
| Finished | `2026-08-13T07:33:30Z` |
| Duration | 13 minutes 37 seconds |
| Review limit | One uninterrupted context, under 45 minutes |
| Working-tree stability | Status and digest were identical at start and finish |
| Rerun identity | Not supplied. A quarantined invalid-review path was visible in `git status`; no inference was made from it. |

The working tree is not a Git tree object: it has 17 modified tracked files and three untracked files. Exact identity is therefore HEAD plus the semantic worktree-delta digest. The digest includes the binary tracked delta and Git blob identities of non-quarantined untracked files:

- `8b5bfce48f9de8142d742867acd6ff53871f33cf` — `docs/decision-evidence/20260813-client-protocol-and-attention-trajectory.md`
- `8e564ddd26cd6144308018b5aa8139389c69610c` — `docs/decisions/20260813-client-protocol-and-attention.md`

Digest command:

```bash
{
  git diff --no-ext-diff --binary --full-index HEAD -- . \
    ':(exclude)docs/decision-evidence/*-cold-review.md' \
    ':(exclude)docs/decision-evidence/*-invalid-review.md'
  git ls-files --others --exclude-standard -z |
    while IFS= read -r -d '' candidate_path; do
      case "$candidate_path" in
        docs/decision-evidence/*-cold-review.md|docs/decision-evidence/*-invalid-review.md) continue ;;
      esac
      candidate_blob=$(git hash-object -- "$candidate_path")
      printf 'untracked %s %s\n' "$candidate_path" "$candidate_blob"
    done | LC_ALL=C sort
} | sha256sum
```

The quarantined `docs/decision-evidence/20260813-client-protocol-and-attention-c15b0e30-invalid-review.md` was excluded from the digest and every content search.

## Fresh-context attestation

- I did not author or reconcile the candidate.
- I received no candidate-specific author summary, diff tour, ADR/file pointer, search term, expected answer, or answer key.
- I navigated from `AGENTS.md`, repository-native indexes, and ordinary status/search.
- I loaded the repository-required `decisions` skill and fixed questions.
- I did not open, read, hash, or search an earlier cold-review or invalid-review artifact. Only the invalid-review pathname appeared in status.
- No command returned an answer or verdict from a quarantined artifact.
- I did not ask the author for help.
- I made no edits. Start/end status and digest match.
- Author interventions: none.

The read-only ADR shape check passed: `59 record(s) well-formed`.

## Fixed questions and unedited answers

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

The candidate makes current one endpoint-owned Client protocol and local runtime boundary behind the already-reduced `HarnessClient`.

Its binding outcome closes five related implementation gaps:

- Exact private Client evidence: closed, versioned RFC 8785 values; domain-separated SHA-256 hashes; stable self-addressed inner Identity `SignedMessage` evidence; replaceable all-member outer Router envelopes; fixed 32-member and 32,768-byte content limits; and the START genesis Router anchor.
- Automatic attention: only an unconsumed, locally certified, remote-authored head at the sole subscribed endpoint contends; the author does not self-contend; Router order selects the first BEGIN; and the endpoint persists consumption before attempting the turn frame.
- Daemon/MCP representation: SQLite/WAL endpoint state, explicit process inputs, the official MCP delegate plus one narrow listen-extension adapter, exact state-dependent catalogs, closed management DTOs and failures, and Registry-`OperationId` registration recovery.
- Runtime boundary: the unchanged resultless `HarnessClient`, one current-action turn, content-only bound reply, MCP-only management, and private proofs/protocol identifiers.
- Simulator/eval cutover: remove the five incompatible simulator contract families, provision one daemon sidecar per agent, and run all sixteen definitions without restoring Client-owned cross-conversation memory.

The problem is that the four-layer and reduced-Client decisions had not specified enough private evidence, anchoring, attention, MCP, recovery, and simulator behavior for independent daemons to interoperate or for Simulator to provision the actual stack. The candidate also records why the official MCP delegate needs a narrow Client-owned extension handler.

Binding authority is:

1. `AGENTS.md` and `v2/VISION.md`;
2. the accepted ADR’s `Decision Outcome`;
3. the normative chapters in `docs/spec/`, especially `conversation-history.md`, `harness/{client,daemon,ingress,output,tasks}.md`, `management.md`, and `layer-interfaces.md`.

The ADR’s `Context and Problem Statement` explains the prior gap. Its `Consequences` describe effects and named deferrals. Architecture plans explicitly label themselves non-normative. The trajectory is source evidence, not design authority.

Verdict: **PASS** — the intended decision and binding/non-binding boundary are discoverable.

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

It retains rather than replaces:

- The four-layer architecture, endpoint-replicated certified history, quorum durability, catch-up, Router re-anchor, seven-package graph, and trusted Registry/Router profile retained by `20260811-four-layer-endpoint-replicated-harness.md`.
- The `20260812-harness-client-uses-conversation-id.md` public boundary: pre-minted `ConversationId`, current-conversation action turns, content-only bound reply, `void` completion, and MCP-only management.
- Identity and Router’s existing representations, authentication, deep capabilities, limits, and retry behavior.
- OpenFloorV1 unanimous action certification, separate durability thresholds, and local personal-trust decisions.
- Compatible Simulator facades and the simulation-only `RunLedger`.

It resolves or replaces:

- Previously unassigned exact Client representation, genesis anchoring, attention activation/consumption, raw extension, daemon management, and registration-recovery choices.
- The five Simulator conflicts: content-free open, generic send, message-only/proof-shaped receive/results, runtime Router/credential/store authority, and persisted Router-commit/order evidence. These are removals, not shims.
- Automatic self-contention: the current policy is remote-authored actions only.
- Earlier cross-conversation presentation/checkpoint assumptions remain replaced by the 20260812 Client decision; host-native memory is outside Client.

It leaves untouched or deliberately deferred publication/version policy, retention/pruning and disk-loss recovery, dynamic membership, encryption, malicious or replicated Registry/Router profiles, cross-process reply recovery, plural-action mapping, remote administration, richer task/norm/dispute protocols, public observers/audit conventions, larger/fragmented resource profiles, and host-native cross-conversation memory.

The current contract lives in `v2/VISION.md`, the accepted 20260813 ADR, the updated trace dispositions in the 20260811 ADR, and the normative specifications named above.

There is, however, a lineage defect. The visible `Supersession` section of `20260728-gate-1-architecture-freeze.md` still says “the exact Client surface, and the five conflicting simulator contracts remain explicit deferrals.” Both are now resolved. The newer accepted ADR and updated 20260811 trace table make the intended authority result inferable, but a partially superseded record’s visible Supersession text is supposed to state current applicability.

Verdict: **FAIL** — the outcome is discoverable, but the current lineage is not contradiction-free.

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

An implementer must:

- Build the exact closed Client values and cross-field verification in `conversation-history.md`.
- Use stable inner signed evidence and separate all-member Router envelopes; retry may replace only the outer MessageId.
- Enforce the 32-member, 32,768-byte content, no-fragmentation profile and prove maximum artifacts remain within Identity limits.
- Obtain START’s Router instance through omitted-cursor poll and bind it into unanimous genesis signatures.
- Keep action certification unanimous and independent from the all-member/`n-f` durability threshold.
- Persist staged records before honest durability votes and atomically promote only complete certified records.
- Implement any-member evidence assembly, fixed-member catch-up, and threshold re-anchoring.
- Contend only for subscribed, unconsumed, remote-authored certified heads; never self-contend.
- Persist `(ConversationId, RecordHash)` immediately before the complete SSE frame and never offer that head again locally.
- Implement the state-dependent MCP catalog, exact management/result/error shapes, Registry idempotency recovery, one endpoint database, and one loopback endpoint.
- Keep hashes, certificates, grants, signing material, Router access, stores, and management operations outside `HarnessClient`.
- Apply the five Simulator removals, one Registry/Router per run, one persistent daemon sidecar per agent, and runtime exposure limited to MCP or injected Client.

It must avoid a product Ledger, Transcript service, named profiles, split MCP paths, generic send, public proof-shaped results, a public `TxnId`, raw runtime network authority, compatibility facades, reinterpretation of retired simulator events, or automatic Client/Simulator cross-conversation context.

Affected areas are primarily Communication and endpoint-owned Client state, with OpenFloor task/norm behavior and local personal-trust attention. Identity and Router are dependencies whose public boundaries remain unchanged. Consumers are OpenClaw, NanoClaw, Simulator, evals, daemon MCP clients, and application runtimes.

Assumptions and guarantees are:

- One correct, non-equivocating Registry and one correct, non-equivocating Router.
- Potentially Byzantine endpoints.
- For `n >= 4`, at most `f=floor((n-1)/3)` Byzantine fixed members for the stated durability/intersection guarantee; completion then guarantees at least `n-2f` honest staged replicas.
- For `n < 4`, all members vote and the replicated-storage guarantee assumes zero Byzantine members.
- OpenFloor action validity remains unanimous.
- Safety is timing-independent.
- Progress needs relevant Registry/cached identity material, Router availability, every required action signer, the durability/re-anchor threshold, and an honest source for missing ancestry.
- Existing certified local history remains readable through Registry or Router outage.
- Loopback clients and the local operator are trusted.
- Delivery and reply authority are transient; an ambiguous write may lose a turn.
- No global ownership guarantee exists for copied state directories or duplicated private keys.
- Compatible Simulator contracts remain, but the five named families break; six cross-conversation eval cases may fail. Publication compatibility remains unselected.

A blocking configuration contradiction prevents exact implementation: `v2/AGENTS.md` and `v2/VISION.md` require the daemon to receive an explicit MCP bind address and port, while the accepted ADR and `docs/spec/harness/daemon.md` declare exactly seven inputs, provide only `MOLTZAPD_MCP_PORT`, and hard-code `127.0.0.1`.

Verdict: **FAIL** — most behavior and assumptions are exact, but the process interface cannot satisfy both authorities.

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

The ADR names **Tapan Chugh** as decision-maker.

The trajectory cites:

1. L3 signing and host-memory choices:

   - Request `fc_0fe7c1dd2e31cd97016a7d4fa1be4c819397c851716801b843`, result `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0`, turn `019ff969-5e2e-78b0-903f-2237aeae4010`.
   - Signing alternatives: `Nested SignedMessage (Recommended)`, `Compact attestation API`, and `Fragmented evidence`.
   - Result: `Nested SignedMessage (Recommended)`.
   - Memory alternatives: `Implement host integration (Recommended)`, `Mark unsupported`, and `Adapter context cache`.
   - Result: `None of the above`, with note `just defer it now. let the evals fail`.
   - The stored actor role is absent for both function-call records.

2. Attention selection and reversal:

   - Request `fc_0fe7c1dd2e31cd97016a7d515b37bc8193a752005aaf28d092`, result `fco_019ff989-86d8-7d83-92c1-16da24457d21`, turn `019ff984-906f-7400-b6f3-9251a37c831b`.
   - Alternatives: `Remote action only (Recommended)`, `Every action`, and `Defer trigger`.
   - Initial result: `Every action`.
   - User message `msg_019ff989-fa2d-76f0-8d83-7b09f663643a`, turn `019ff989-f8b5-7e30-b9ba-7806c5e72e3e`: `actually fine to not content again`.
   - Assistant message `msg_0fe7c1dd2e31cd97016a7d53f2c2f48193af0a0e94796ed417` records the implementation interpretation: remote-authored actions may trigger contention; the endpoint does not immediately contend after its own action.

3. Four-layer correction:

   - User message `msg_019ff993-e348-7272-9e3c-f5ddce9d116e`: `look at the 4 layer plan now`.
   - The ledger states that this excludes the older central-Ledger track.

4. Complete plan and instruction:

   - Assistant message `msg_0fe7c1dd2e31cd97016a7d58c392bc8193bef23bb36ab9fc93` presents the plan.
   - User message `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36`: `Implement the plan.`

Explicit source gaps and omissions recorded by the trajectory are:

- The root session has no parent thread.
- Public message records have turn IDs but no parent-message or parent-turn locator.
- Function-call records have neither parent locators nor stored actor roles.
- Unrelated implementation status, tool output, hidden reasoning, repeated summaries, and portions of the final plan are omitted.
- The ledger says no wording was normalized.
- The source does not separately state motives, confidence, urgency, or a reason for each mechanism.

There is an additional provenance defect visible from the ledger itself: the “complete implementation plan” retains only a literal excerpt and then paraphrases omitted material concerning SQLite/WAL, daemon configuration, management behavior, Simulator sidecars, and eval behavior. The terse `Implement the plan.` instruction therefore lacks literal retained context for several exact binding choices in the ADR, including exact environment keys, DTOs, and failure mappings. The repository provenance law requires material public context as literal excerpts or an explicit source-gap report, not reconstructed summary.

Verdict: **FAIL** — locators and major selections are discoverable, but material source-event attribution is incomplete.

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

The strongest contradiction is the daemon bind interface:

- `v2/AGENTS.md` → `Explicit daemon configuration` says the daemon receives its “MCP bind address and port” explicitly.
- `v2/VISION.md` → `Processes and persistence` repeats that requirement.
- `docs/architecture/four-layer-v2-cutover.md` and `docs/architecture/components.md` repeat it.
- The accepted 20260813 ADR → `Daemon, MCP, and management representation` says process configuration is exact, lists seven inputs, provides only `MOLTZAPD_MCP_PORT`, and says it binds only to `127.0.0.1`.
- `docs/spec/harness/daemon.md` says all seven inputs are required and likewise has no address input.

Authority order cannot make an implementable choice here. The constitution requires an explicit address input; the current accepted ADR and normative spec prohibit an eighth input and fix the address. The candidate must either:

- change the high-authority wording to “fixed loopback address and explicitly configured port”; or
- add and specify an exact address input, including its permitted value and trust consequences.

Two additional stale instructions are lower authority but should also be reconciled:

- Root `README.md` and `packages/client/src/README.md` say registration and recovery remain deliberately pending, although the accepted ADR and `management.md` now specify them.
- `20260728-gate-1-architecture-freeze.md` still calls the exact Client surface and five Simulator contracts deferrals in its visible Supersession section.

Verdict: **FAIL — blocker**.

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

No. Most of the contract is unusually concrete, but the following accidental gaps require a binding choice:

1. **Accidental gap — MCP bind configuration.** The high-authority explicit-address requirement conflicts with the exact seven-input, fixed-loopback contract.

2. **Accidental gap — zero-head/genesis catch-up.** `CatchUpRequest` requires non-null `knownRecordHash` and `knownAnchorHash`, and the protocol describes the response as the one next item. The guarantee also says a fixed member omitted from a completed storage quorum automatically catches up. For `n >= 4`, a member can contribute its START action signature, disconnect before receiving the assembled genesis certificate, and be omitted from the first durability threshold. On feed-gap recovery it has no certified local record position from which to request “the next” item. No null/pre-genesis anchor, dedicated bootstrap request, or same-record certificate-enrichment request is defined. An interoperable implementation would have to invent one.

3. **Accidental gap — source attribution.** Material parts of the plan adopted by `Implement the plan.` are summarized rather than retained literally in the trajectory.

4. **Accidental gap — current lineage and entry-point text.** The architecture-freeze Supersession and current root/Client README statements still present resolved choices as pending.

Discoverable deliberate deferrals are:

- Publication membership, package version coordination, release ordering, and compatibility treatment for external consumers.
- Dynamic membership and membership/key epochs.
- History pruning, garbage collection, compaction, retention, and disk-loss recovery.
- Encryption and key distribution.
- Public observers, non-member disclosure/audit protocols, and cross-history conventions.
- Malicious or replicated Registry/Router profiles, Byzantine sequencing, failover, and persistent Router replay.
- Fragmentation and larger or negotiated resource profiles.
- Cross-process reply recovery.
- Plural-action payload-to-action mapping.
- Host-native cross-conversation memory; the six dependent eval cases may fail.
- Delivery acknowledgment/replay, resumable subscriptions, daemon-wide queue/concurrency/overload limits.
- Remote administration, hostile-host/local authentication work, and global copied-directory/duplicate-key ownership detection.
- Richer norms, non-unanimous action certificates, addressed turns, fairness, pass/abort/renewal, disputes, signature compression, distributed norm bundles, and per-action tools.
- Alternate catch-up transports and richer management search/ranking/summary/total/page-size features.

Those deferrals are sufficiently labeled and should not be guessed. The accidental gaps above are not labeled deferrals and block an interoperable implementation.

Verdict: **FAIL**.

## Independently discovered paths and headings

- `AGENTS.md` — `Decisions`, `Docs`
- `.claude/skills/decisions/SKILL.md` — `Blind review gate`
- `.claude/skills/decisions/references/provenance.md`
- `.claude/skills/cold-read/references/questions.md`
- `v2/AGENTS.md` — `Authority and reading order`, `Implementation rules`
- `v2/VISION.md` — `The constitution`, `First executable profile`, `Deliberate deferrals`
- `docs/decisions/README.md` — `Canonical reading guidance`, `Records`
- `docs/decisions/20260813-client-protocol-and-attention.md` — complete record
- `docs/decisions/20260812-harness-client-uses-conversation-id.md`
- `docs/decisions/20260811-four-layer-endpoint-replicated-harness.md` — `Supersession`, `Explicit deferrals`, `Gate 1 traceability disposition`
- `docs/decisions/20260728-gate-1-architecture-freeze.md` — `Supersession`
- `docs/spec/README.md` — `Implementation readiness`
- `docs/spec/conversation-history.md` — `Exact closed values`, catch-up, recovery, fault matrix
- `docs/spec/harness/{client,daemon,ingress,output,tasks}.md`
- `docs/spec/management.md`
- `docs/spec/layer-interfaces.md` — `Simulator cutover`
- `docs/architecture/{four-layer-v2-cutover,first-implementation,seven-package-cutover-handoff}.md`
- `docs/decision-evidence/20260813-client-protocol-and-attention-trajectory.md`
- `packages/simulator/AGENTS.md`
- `packages/client/AGENTS.md`
- `README.md`
- `packages/client/src/README.md`

## Discovery trail

| Order | Navigation step | Result |
|---:|---|---|
| 1 | Recorded UTC start, root, HEAD, branch, and status | Discovered the semantic candidate files and one quarantined invalid-review pathname |
| 2 | Read root `AGENTS.md` and `README.md` | Found authority order, required local decision procedure, and a stale registration statement |
| 3 | Loaded `decisions` skill, provenance rules, fixed questions, and template | Established review/quarantine requirements |
| 4 | Read `v2/AGENTS.md` and `v2/VISION.md` | Established top-level four-layer law and explicit-bind requirement |
| 5 | Followed `docs/decisions/README.md` | Discovered the new accepted ADR and replacement chain |
| 6 | Read the 20260813, 20260812, 20260811, and architecture-freeze records | Reconstructed retained/replaced scope and found stale lineage |
| 7 | Followed `docs/spec/README.md` into all Client-owned normative chapters | Reconstructed exact protocol, daemon, MCP, management, and Simulator contracts |
| 8 | Read current architecture execution/handoff pages | Confirmed implementation ordering and compatibility cuts |
| 9 | Followed the ADR’s provenance anchors into the new trajectory | Reconstructed calls, alternatives, reversal, deferral, instruction, and recorded source gaps |
| 10 | Searched current authority/spec/orientation paths while excluding quarantined artifacts | Found the bind-address conflict, stale registration text, and missing zero-head catch-up form |
| 11 | Ran the read-only ADR shape check | Mechanical result: PASS, 59 records |
| 12 | Recomputed UTC finish, status, HEAD/tree, and digest | Candidate remained unchanged |

## Author interventions

None.

## Blockers

| ID | Finding | Required reconciliation |
|---|---|---|
| B1 | Explicit MCP bind address required by `v2/AGENTS.md`/`v2/VISION.md`, but forbidden by the exact seven-input ADR/spec contract | Choose fixed loopback plus explicit port, or specify the eighth address input consistently |
| B2 | Exact catch-up wire has no bootstrap form for a fixed member without a certified record/anchor | Define a null/sentinel genesis position, dedicated bootstrap request, or other exact interoperable recovery value |
| B3 | Material adopted plan content is paraphrased rather than retained literally in provenance | Add literal material excerpts with source locators, or record a source gap and obtain renewed human review |
| B4 | Current Supersession/README text says resolved choices remain deferred | Update lineage and current entry-point documentation atomically |

## Overall result

Result: **FAIL**

The candidate makes the intended Client protocol, attention, daemon, and Simulator decision largely clear, and its mechanical ADR shape passes. It does not pass the blind gate because the exact process interface contradicts higher authority, catch-up has an unassigned bootstrap wire case, material source attribution is incomplete, and current lineage/entry-point text still presents resolved decisions as pending.
