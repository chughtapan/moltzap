# Blind teammate review

Overall result: **PASS**

Maintainer acceptance: **accepted by Tapan Chugh on 2026-08-30**

## Review identity

| Field | Value |
|---|---|
| Review run | `/root/adr_blind_review_6` |
| Candidate root | `/tmp/moltzap-adr-blind.NOYFKl` |
| Candidate source root | `/home/tapanc/moltzap-v2-cutover` |
| Candidate commit | `19058536fdc59a915a7cdc3d8288191a044d6c82` |
| Candidate tree | `504cecba6bb8f03a2bd96fbf3c6b6395119054be` |
| Candidate content digest | SHA-256 `fd3fba702093ac79b5c3e83adeabf635a49d1d5f757f42338e2c2820592e9e43` |
| Digest scope | Complete Git tree manifest at candidate `HEAD` |
| Digest command | `git ls-tree -r --full-tree HEAD \| sha256sum` |
| Freeze mechanism | Detached depth-one fetch of the exact candidate commit |
| Reviewer | Fresh Codex teammate agent `/root/adr_blind_review_6` |
| Isolation | `fork_turns: none`; no inherited conversation or author state |
| Review budget | One uninterrupted fresh-agent context, with a 45-minute ceiling |
| Duration | Approximately `00:08:08`, as reported by the reviewer |
| Candidate state | Detached and clean throughout the run |

## Maintainer acceptance

Tapan Chugh accepted this PASS result on 2026-08-30 with the literal reply
`approve` in the active Codex session. The current tool context exposes no
native session or message locator, so none is invented. This acceptance was
recorded after the reviewer completed its isolated run and does not alter the
unedited report below.

The depth-one candidate preserves the exact reviewed Git tree while keeping
earlier quarantined review verdicts out of history command output. The
quarantined artifacts that belong to the candidate tree remain present and
were not opened or searched by the reviewer.

## Exact prompt

```text
Candidate repository root: /tmp/moltzap-adr-blind.NOYFKl

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.
```

## Isolation attestation and author interventions

- The reviewer did not author or reconcile the candidate.
- The reviewer received only the candidate root and the six fixed questions.
- The reviewer received no inherited author conversation, compaction, memory,
  private state, prior-review output, ADR pointer, design summary, diff tour,
  search term, expected answer, or expected result.
- The author sent no follow-up, clarification, or hint during the run.
- The reviewer did not open or search any prior cold-, invalid-, or
  blind-review artifact content.
- The reviewer did not modify the candidate.

## Independently discovered paths and headings

The reviewer reported independently locating:

- `AGENTS.md` and `v2/VISION.md` for the authority order and current cutover
  profile;
- `docs/decisions/README.md` for decision-reading and supersession guidance;
- the Decision Outcome and supersession boundaries in
  `20260828-action-signatures-follow-router-order.md`,
  `20260828-hosts-own-send-retry-policy.md`, and
  `20260828-channel-adapters-use-stock-host-apis.md`;
- `20260827-addressed-messaging-replaces-openfloor.md` for the strongest
  apparent stale body text and its visible resolution;
- the `Gate 1 traceability disposition` in
  `20260811-four-layer-endpoint-replicated-harness.md`;
- the named normative headings in `docs/spec/harness/tasks.md`,
  `docs/spec/conversation-history.md`, `docs/spec/harness/client.md`,
  `docs/spec/harness/output.md`, `docs/spec/harness/channels.md`, and
  `docs/spec/harness/ingress.md`;
- the three 2026-08-28 source-gap reports and the superseded context in
  `20260827-addressed-messaging-trajectory.md`.

## Discovery trail

The reported trail began with repository law, `v2/VISION.md`, and the
decision index; identified the three accepted replacement ADRs; followed
their visible lineage into the earlier addressed-messaging record, stable
manifest rows, and normative spec owners; then followed each provenance link
to its source-gap report and the older addressed-messaging trajectory. The
reviewer searched for the strongest conflicting retry instruction and
separately examined surviving `idempotencyKey` references, resolving those as
stock OpenClaw RPC identity rather than Client send identity. Finally, the
reviewer ran the ADR shape checker directly with Node 24. It passed all 65
records. The prescribed `pnpm exec tsx` wrapper could not start because the
isolated depth-one checkout had no installed `tsx` binary.

## Unedited reviewer report

```text
## Blind review record

- Candidate: `19058536fdc59a915a7cdc3d8288191a044d6c82`
- Root: `/tmp/moltzap-adr-blind.NOYFKl`
- State: detached, clean worktree
- Reviewer: `/root/adr_blind_review_6`
- Isolation: fresh agent context; received only the candidate root and six fixed questions. No author summary, file pointer, expected answer, prior review output, or mid-run coaching.
- Author interventions: none
- Quarantine: no prior cold-, invalid-, or blind-review artifact content was opened or searched.
- Duration: approximately 8m08s
- Mechanical check: ADR shape checker passed all 65 records using Node 24. The prescribed `pnpm exec tsx` invocation could not start because `tsx` is absent in the isolated checkout.

## 1. Current decision and authority — PASS

The candidate makes three coordinated decisions current:

1. `20260828-action-signatures-follow-router-order.md`
   - Resolves the conflict between pre-order `ActionProposal.authorSignature` and the rule that an honest endpoint signs only the first valid gap-free Router-ordered candidate.
   - A proposal now contains only version, kind, and `ActionCore`; its all-member outer Identity `SignedMessage` proves authorship.
   - Every member, including the author, locks the Router-ordered candidate before emitting an `ActionSignatureStatement`.

2. `20260828-hosts-own-send-retry-policy.md`
   - Removes ambiguity and host coupling caused by caller-supplied Client idempotency.
   - `send` accepts only `to` and `content`; every invocation gets a fresh Client-minted `PostId`.
   - Recovery retains that `PostId` only for the same persisted invocation. A later call is always a new post.

3. `20260828-channel-adapters-use-stock-host-apis.md`
   - Resolves NanoClaw integration having become a host fork.
   - MoltZap adapters stop at the stock callback boundary and do not own or patch host persistence, sessions, ACLs, prompts, output interpretation, retries, or sandboxing.

Binding authority is:

- `AGENTS.md` and `v2/VISION.md`;
- the three accepted ADR Decision Outcomes;
- the updated stable manifest in `20260811-four-layer-endpoint-replicated-harness.md`;
- the normative `docs/spec/` headings referenced by that manifest.

Per `docs/decisions/README.md`, ADR context, consequences, examples, and changelog explanations are historical or explanatory rather than independently binding. Decision-evidence files are non-normative ledgers.

## 2. Replacement and lineage — PASS

Action signatures:

- Replace the conflicting normative `ActionProposal.authorSignature` mechanism, not another admitted outcome.
- Retain first-Router-ordered-candidate locking, GENESIS unanimity, author-inclusive POST `q(n)`, durability thresholds, recovery identity, and evidence merging.
- Current owners include:
  - manifest rows `G1-DEC-407`, `410`, `507`, and `516`;
  - `docs/spec/harness/tasks.md` → `POST`, `Candidate selection`, `Screening and signing`, `Durability`;
  - `docs/spec/conversation-history.md` → `Certificates and certified records`, `Proposal ordering and recovery identity`, `Direct packets and Router envelopes`.

Host retry:

- Partially supersedes `20260827-addressed-messaging-replaces-openfloor.md` only for caller `IdempotencyKey`, `PostId` derivation from a host identifier, cross-invocation deduplication, and `idempotency-conflict`.
- Retains explicit addresses, GENESIS/POST, certification, durability, delivery, recovery, compatibility, and the fresh-state cut.
- Current owners include manifest rows `G1-DEC-221`, `403`, `413`, `610`, `632`, and `633`, plus `harness/client.md`, `harness/output.md`, and `conversation-history.md`.

Stock host adapters:

- Partially supersede the addressed-messaging record only where it imposed MoltZap-owned host session topology, prompt/final-text interpretation, inbox persistence/replay, ACL materialization, or sandbox execution.
- Retain the addressed Client contract, exact inbound projection, explicit outbound address validation, stable Client delivery identity, certification, and endpoint durability.
- Current owners include manifest rows `G1-DEC-609`, `619`, `620`, `624`, `625`, `629`–`631`, `638`–`641`, and `819`, plus `harness/channels.md`, `harness/output.md`, and `harness/ingress.md`.

OpenFloor removal and earlier fully superseded Client/model-surface records remain historical and are not revived. Identity, Router opacity, endpoint replication, and the seven-package graph are untouched.

## 3. Implementer obligations and assumptions — PASS

An implementer must:

- Remove action-signature evidence from `ActionProposal`.
- Sign proposals only with the complete outer all-member envelope, including self.
- Verify envelope sender equals the post author.
- Durably lock the first valid gap-free Router-ordered candidate before any member, including the author, emits an action vote.
- Preserve GENESIS unanimity and author-inclusive POST `q(n)` certificates.

For sends:

- Expose exactly `{to, content}` through `HarnessEndpoint.send` and MCP `send_message`.
- Mint a fresh random 32-byte `PostId` per invocation before persisting intent or emitting traffic.
- Reuse it only while recovering that persisted intent.
- Remove public `IdempotencyKey` and `idempotency-conflict`.
- Never classify a later host call as retry, repeat, or replacement.

For adapters:

- Consume only public `HarnessEndpoint` or loopback MCP.
- Project canonical sender, address, content, and exact group membership through stock host callbacks.
- Bind ordinary replies to the current canonical inbound address and validate explicit proactive `agent:`/`group:` inputs.
- Invoke Client once per host callback.
- Acknowledge inbound Client delivery only after successful stock callback completion.
- Avoid host patches, provider databases, queue-ID forwarding, adapter retry/deduplication, session selection, prompt/output parsing, ACL ownership, and sandbox drivers.

Affected domains are Client L3/protocol/wire representation, Client/MCP runtime semantics, and OpenClaw/NanoClaw integration. Registry and Router contracts remain unchanged and content-blind; Simulator/evals remain consumers.

Assumptions and limits are discoverable:

- Correct non-equivocating Registry and Router.
- Potentially Byzantine endpoints; for `n >= 4`, the replicated-storage profile assumes at most `f=floor((n-1)/3)` Byzantine members. Small-group replicated-storage guarantees assume zero Byzantine members.
- Safety is timing-independent.
- Progress requires Router availability, usable identity material, responsive action and durability quorums, and history sources when catch-up is needed.
- A selected quorum may withhold and stall the conversation; no fairness, timeout replacement, or view change is claimed.
- Callback completion is the MoltZap/host boundary. Host durability, deduplication, and replay effects require stock-host guarantees and tests.
- The addressed protocol remains a deliberate hard cut using protocol `2026.827.1`, store schema 2, and events-v2. Mixed or old peers/stores fail closed; no compatibility shim is permitted.

## 4. Decision-makers and source events — PASS with explicit source gaps

All three ADRs name Tapan Chugh as decision-maker.

No source-faithful event establishes any of the three current calls. Each corresponding source-gap report states that the active Codex context lacked:

- native source-session identity;
- message/event locators;
- enclosing turn and parent locators;
- exact UTC message timestamps.

Each report therefore retains no event row, does not reconstruct the decision from ADR prose or repository changes, and requests a dated correction if the original export appears.

The retry ADR additionally links older superseded context in session `019fd899-779c-7e70-a8e4-338727b13e6c`:

- line 2920, `2026-08-27T18:57:37Z`: cross-conversation context, groups, and shared meetings;
- line 2922, `19:27:10Z`: remove OpenFloorV1;
- line 2924, `19:55:09Z`: fall back to existing OpenClaw/NanoClaw code where possible;
- line 2925, `20:41:17Z`: asks for one main session and `agent:`/`group:` forms;
- line 2927, `20:52:54Z`: agent addresses and no automatic notifications.

None mentions Client idempotency. The trajectory explicitly records that missing agent prompts, structured selections, and the implementation plan prevent it from establishing detailed interface/wire choices. It is superseded context, not evidence for the new retry call.

No current source event records alternatives, the three reversals, or their rationale/urgency/confidence. That absence is explicitly documented rather than inferred.

## 5. Strongest apparent contradiction — PASS, resolved

The strongest contradiction is the body of partially superseded `20260827-addressed-messaging-replaces-openfloor.md`, which still specifies:

- caller `IdempotencyKey` and retry deduplication;
- one MoltZap-selected native session;
- MoltZap-enforced durable host acceptance and replay behavior.

Its visible `Supersession` section immediately resolves all three conflicts, and the decision index instructs readers to follow the two 2026-08-28 replacements. `v2/VISION.md`, the manifest, normative specs, package instructions, and current implementation agree with those replacements. No blocker remains.

A broad search also found `idempotencyKey` in Simulator/evals OpenClaw gateway types. That is OpenClaw’s stock native principal `agent` RPC identity, not `HarnessEndpoint.send`, and it never enters the social Client contract. It is not a contradiction.

## 6. Implementability and unresolved choices — PASS

A teammate can implement the selected behavior without chat or guessing. The repository supplies exact public shapes, closed wire schemas, threshold rules, ordering and persistence behavior, callback sequencing, error taxonomies, compatibility behavior, manifest ownership, package boundaries, and acceptance requirements.

Deliberate deferrals include:

- publication membership and coordinated versus independent package versioning;
- dynamic or named groups and mutable membership;
- timeout replacement, view change, fairness, disputes, richer action/norm vocabularies, and signature aggregation;
- fragmentation, larger resource profiles, encryption, pruning, and disk-loss recovery;
- malicious or replicated Registry/Router profiles and remote administration;
- stronger host session, prompt, final-text, persistence, replay, ACL, or sandbox guarantees absent from stock host contracts.

Intentional ownership boundaries, not gaps:

- Hosts choose whether to call send again.
- Hosts define what successful callback completion persists.
- A missing stock capability is contributed upstream or accepted as a weaker integration guarantee, not implemented through a fork.

Accidental gaps:

- All three current decisions lack recoverable source events. These are provenance gaps, not implementation ambiguities, and should be consciously reviewed by the named maintainer.
- No accidental normative-owner, lineage, schema, or implementation-choice gap was found.

Overall result: **PASS — no blocker found.** Maintainer acceptance is still required; this reviewer result is not self-certifying.
```

## Per-question verdicts

| Question | Verdict |
|---|---|
| 1 | **PASS** |
| 2 | **PASS** |
| 3 | **PASS** |
| 4 | **PASS with explicit source gaps** |
| 5 | **PASS; apparent contradiction resolved** |
| 6 | **PASS** |

## Blockers and overall result

The reviewer found no blocker and returned **PASS**. The only accidental gaps
are the three already-explicit provenance source gaps; the reviewer found no
accidental normative-owner, lineage, schema, or implementation-choice gap.
Maintainer acceptance was recorded on 2026-08-30 after the reviewer report.
