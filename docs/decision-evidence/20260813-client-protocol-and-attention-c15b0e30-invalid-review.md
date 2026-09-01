# Blind review result

## Review identity

| Field | Value |
|---|---|
| Review run | `/root/cold_candidate_review-20260813T062338Z` |
| Reviewer | fresh Codex subagent `/root/cold_candidate_review` |
| Review started | `2026-08-13T06:23:38Z` |
| Review finished | `2026-08-13T06:35:14Z` |
| Review duration | `00:11:36` |
| Candidate commit | none; candidate is a working-tree overlay |
| Base HEAD | `f255c9a425e50597f38b6ec106b0c56ed6ea9370` |
| Base tree | `dc3d7f1917c2ad9a9593d9de0def7794c3488f9d` |
| Candidate content digest | `sha256:c15b0e30b6a1d89bd6e821883096b16b7a30db3f2a4f7a9f113596c7c0c965e9` |
| Digest scope | base HEAD, complete binary tracked diff, and sorted non-quarantined untracked path/content hashes; the digest matched on two checks |
| Mechanical ADR check | `PASS — 59 record(s) well-formed.` |

The candidate digest was computed with:

```bash
{
  printf 'base-head\0%s\0' "$(git rev-parse HEAD)"
  git diff --binary --full-index --no-ext-diff HEAD -- .
  while IFS= read -r candidate_path; do
    case "$candidate_path" in
      *-cold-review.md|*-invalid-review.md) continue ;;
    esac
    printf 'untracked\0%s\0' "$candidate_path"
    sha256sum -- "$candidate_path"
  done < <(git ls-files --others --exclude-standard | LC_ALL=C sort)
} | sha256sum
```

## Exact six-question prompt

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

## Isolation attestation

I did not author or reconcile the candidate. I received no author conversation, summary, private state, earlier blind-review output, design tour, decision-file pointer, search term, expected answer, or answer key. I received only the repository root and fixed questions, then navigated through repository-native instructions and indexes.

I did not open, read, or search an earlier `*-cold-review.md` or `*-invalid-review.md`. No command returned an answer or verdict from one. I made no edits, asked no author questions, accepted no hints, used no sub-reviewer, and completed this in one uninterrupted fresh context.

## Discovery trail

1. `git status`, history, and the root file inventory established the base revision and dirty candidate overlay.
2. `AGENTS.md → Decisions` required the repository-local decisions procedure; its fixed questions matched the supplied questions.
3. `docs/decisions/README.md → Records` independently exposed the new accepted `20260813-client-protocol-and-attention.md`.
4. The new record led to `20260813-client-protocol-and-attention-trajectory.md` and its three linked headings.
5. Its context led backward through `20260812-harness-client-uses-conversation-id.md` and the retained scope, deferrals, trace table, and changelog of `20260811-four-layer-endpoint-replicated-harness.md`.
6. `v2/VISION.md → Authority`, `The constitution`, `First executable profile`, and `Deliberate deferrals` established the higher contract.
7. I traced the normative owners under `docs/spec/`, especially `conversation-history.md`, `harness/{client,daemon,ingress,output,tasks}.md`, `management.md`, and `layer-interfaces.md`.
8. Package-scoped instructions exposed the unresolved Simulator authority conflict in `packages/simulator/AGENTS.md → Five blocked contracts`.
9. Repository searches for protocol type definitions, recovery language, and stale Simulator deferrals exposed the missing wire schemas and additional contradictions.
10. The ADR-shape checker passed; final status and digest confirmed no review mutation.

## Author interventions

None.

## Unedited numbered answers

### 1. Answer

The candidate makes current the accepted decision that Client owns one closed, repository-versioned endpoint protocol, durable attention consumption, and the exact local daemon representation behind the unchanged semantic `HarnessClient`.

It resolves six previously open areas:

- Client evidence and transport representation;
- START’s initial Router-instance anchor;
- automatic OpenFloor contention activation;
- the non-standard MCP listen extension that the official SDK’s closed event union cannot express;
- daemon management and persistence representation; and
- the five Simulator contracts incompatible with the four-layer architecture.

The binding outcome is `docs/decisions/20260813-client-protocol-and-attention.md → Decision Outcome`, including its representation, attention, daemon/MCP/management, and Simulator subsections. Higher binding law remains `AGENTS.md` and `v2/VISION.md`; subordinate `docs/spec/` chapters are normative implementations of that outcome.

Per `docs/decisions/README.md → Canonical reading guidance`, the ADR’s `Context and Problem Statement` and `Consequences` are explanatory or historical reasoning rather than the current binding outcome. The trajectory explicitly identifies itself as non-normative evidence. `docs/architecture/*` is non-normative orientation.

Verdict: **PASS**

### 2. Answer

The decision retains rather than replaces:

- the four-layer model, endpoint-replicated certified history, durability thresholds, catch-up, re-anchor, process topology, package graph, and fault assumptions retained by `20260811-four-layer-endpoint-replicated-harness.md`;
- the caller-minted `ConversationId`, current-conversation turn, content-only bound reply, `void` completion, and management-absence boundary of `20260812-harness-client-uses-conversation-id.md`;
- Identity ownership of AgentCards, signing authority, and `SignedMessage`;
- Router ownership of opaque attributed transport and volatile order; and
- the absence of a central Ledger, generic send, public proof, and runtime network authority.

It closes previously unresolved implementation choices rather than replacing the retained four-layer outcome. The changed 20260811 record’s trace table and changelog repoint representation, attention, management, resource-bound, and Simulator rows to the new owners. The five conflicting Simulator outcomes are replaced by explicit removals.

The current contract is distributed across:

- `v2/VISION.md → Conversations and records`, `Local runtime surface`, and `Deliberate deferrals`;
- the current outcomes of the 20260811, 20260812, and 20260813 ADRs;
- `docs/spec/conversation-history.md → Closed Client representation`;
- `docs/spec/harness/tasks.md → Contention and automatic activation`;
- `docs/spec/harness/ingress.md → Raw MCP representation`, `Attention activation`, and `Delivery law`;
- `docs/spec/harness/daemon.md`;
- `docs/spec/harness/output.md → Raw MCP representation`;
- `docs/spec/management.md`; and
- `docs/spec/layer-interfaces.md → Simulator cutover`.

Publication/version policy and the other named deferrals remain untouched.

This lineage is not consistently propagated: `packages/simulator/AGENTS.md` and `docs/spec/harness/client.md → Deliberate deferrals` still treat the five Simulator cuts as unresolved.

Verdict: **FAIL**

### 3. Answer

An implementer is directed to:

- encode Client values as closed Effect Schemas using RFC 8785 JCS, repository `moltzapVersion`, closed kinds, domain-separated SHA-256 hashes, ordered signer maps, and canonical prefixed base64url hashes;
- use stable self-addressed inner Identity `SignedMessage` evidence inside replaceable all-member outer `SignedMessage` transport;
- enforce 32 total members, 32,768 canonical content bytes, no fragmentation, and derived-size compatibility with Identity’s existing limits;
- bind START genesis to its conversation, canonical membership, and an omitted-cursor poll’s `RouterInstanceId`;
- contend automatically only for an unconsumed, locally certified, remote-authored head while owning the sole active subscription;
- let the first valid BEGIN in Router order win, require unanimous ACK, and use the 90-second volatile grant;
- persist `(ConversationId, RecordHash)` immediately before the turn frame and never offer, bid, or replay that head afterward;
- retain the official MCP SDK behind the narrow admitted extension handler;
- run one loopback-only `moltzapd` with the seven exact environment inputs and one SQLite/WAL endpoint database;
- keep the specified durable state while treating cursors, folds, grants, subscriptions, frames, and reply closures as volatile;
- expose the state-dependent MCP catalogs and closed management operations;
- remove the five incompatible Simulator contracts, provision one Registry and Router per run plus one persistent daemon sidecar per agent, and give applications only loopback MCP;
- run all sixteen eval definitions while allowing the six host-memory-dependent cases to fail; and
- avoid a generic signing API, central Ledger, generic send, public proof/DTO surface, open extension bags, runtime credentials, hidden Router access, compatibility shims, and reinterpretation of Router-order evidence.

Client, Tasks/norms, and local Personal trust are directly affected. Identity and Router are consumed through their existing public boundaries without acquiring Client semantics. OpenClaw, NanoClaw, Simulator, and evals are downstream consumers.

The fault profile assumes one correct non-equivocating Registry and Router. Endpoints may be Byzantine; for `n >= 4`, durability assumes at most `f=floor((n-1)/3)` Byzantine members and guarantees at least `n-2f` honest staged replicas. Small-group replicated storage assumes zero Byzantine members. Action validity remains unanimous. Safety is timing-independent; progress needs applicable Registry/Router availability, every action signer, the durability threshold, and an honest holder of missing ancestry. The local operator and loopback client are trusted. Copied directories or duplicated private keys receive no global lease guarantee. Retired v1 compatibility is intentionally not preserved.

Those duties are discoverable at the semantic level, but the missing exact wire/error definitions and conflicting scoped instructions prevent execution without invention.

Verdict: **FAIL**

### 4. Answer

The ADR names **Tapan Chugh** as decision-maker.

The trajectory cites:

- L3 signing and host-memory request `fc_0fe7c1dd2e31cd97016a7d4fa1be4c819397c851716801b843` and result `fco_019ff97f-dd98-7812-a93e-9d17c9cb2dd0`, turn `019ff969-5e2e-78b0-903f-2237aeae4010`. The result selects `Nested SignedMessage (Recommended)` over `Compact attestation API` and `Fragmented evidence`. For host memory it records `None of the above` with `just defer it now. let the evals fail`, rather than the offered host integration, unsupported-cell, or adapter-cache options.
- Attention request `fc_0fe7c1dd2e31cd97016a7d515b37bc8193a752005aaf28d092` and result `fco_019ff989-86d8-7d83-92c1-16da24457d21`, turn `019ff984-906f-7400-b6f3-9251a37c831b`. The result initially selects `Every action`.
- User message `msg_019ff989-fa2d-76f0-8d83-7b09f663643a` at `2026-08-13T05:13:17.101Z`: “actually fine to not content again”. The following assistant message records the interpretation as no self-recontention and remote-authored activation only.
- User message `msg_019ff993-e348-7272-9e3c-f5ddce9d116e` at `2026-08-13T05:24:06.601Z`: “look at the 4 layer plan now”. The ledger states this excludes the older central-Ledger track.
- Assistant plan message `msg_0fe7c1dd2e31cd97016a7d58c392bc8193bef23bb36ab9fc93` at `2026-08-13T05:41:01.581Z`, followed by user instruction `msg_019ff9a4-2b1b-7103-8801-32e8ff998a36` at `2026-08-13T05:41:53.563Z`: “Implement the plan.”

Explicitly recorded source gaps and omissions are:

- the root session has no parent thread;
- public-message and function records provide no parent locator;
- stored actor roles are absent from the function-call/result records;
- unrelated status, tool output, hidden reasoning, repeated summaries, and portions of the final implementation plan are omitted;
- the final-plan excerpt marks omitted implementation/test bullets; and
- the source does not separately state motives, confidence, urgency, or a reason for each mechanism.

The provenance anchors resolve, and the mechanical ADR check passes.

Verdict: **PASS**

### 5. Answer

The strongest contradiction is in current agent law.

`packages/simulator/AGENTS.md → Five blocked contracts` says implementation must not change the five Simulator contracts until a separately admitted decision selects replacements, must stop when reaching them, and points to `v2/VISION.md → Deliberate deferrals`.

The candidate’s `v2/AGENTS.md → One simulator` and `Remaining implementation gate`, `v2/VISION.md → Deliberate deferrals`, the new accepted ADR, and `docs/spec/layer-interfaces.md → Simulator cutover` say the opposite: the five cuts are admitted removal inputs and implementation must perform them.

Root `AGENTS.md` says scoped instructions refine but never override project law and that an instruction conflict is an authority defect requiring work in that scope to stop. The authority order therefore cannot resolve this by silently choosing one instruction. It is a blocker. The scoped file also points to a nonexistent `Simulator compatibility gate` heading.

Two further contradictions reinforce the failure:

- `docs/spec/harness/client.md → Deliberate deferrals` still lists the five Simulator conflicts as deferred.
- `docs/spec/harness/daemon.md → Deliberate deferrals` defers registration recovery after an uncertain local commit, while `docs/spec/management.md → Registration and status` specifies exact byte-identical recovery. The higher current ADR does not explicitly settle that recovery behavior, and the 20260811/20260812 records leave it outside their decisions.

Verdict: **FAIL**

### 6. Answer

No. A teammate cannot implement the candidate without chat or guessing.

Accidental gaps/blockers:

1. The scoped Simulator agent law forbids the exact work the current ADR requires.
2. `harness/client.md` retains a stale Simulator deferral.
3. Registration recovery is simultaneously deferred and normatively specified.
4. The claimed “exact Effect Schemas” do not exist in the candidate. The repository only lists protocol concepts. It does not define literal `kind` spellings or complete fields/types for membership, genesis anchor, START proposal, BEGIN, ACK, MULTICAST proposal, action signature, durability vote, completed certified record, catch-up request/page/incomplete result, or re-anchor evidence.
5. Consequently, `CertifiedRecord` in `read_conversation` has no exact encoded schema, and independent implementations cannot produce interoperable history pages.
6. Hash and deterministic-ID preimages remain underspecified: the exact canonical object for each artifact, the `AgentId` byte representation/delimiting in evidence `MessageId`, and the exact genesis-anchor value layout are absent.
7. The public and MCP error contracts are described only as categories or “at least” distinctions. Exact variants, tags, fields, and management/history/subscription failure results are not fixed.
8. Exact encodings for daemon JWK environment input, private-key file, and admission-credential file are not stated at the Client owner.
9. `docs/spec/README.md` declares these representations implementation-ready despite the missing definitions above.

Deliberate deferrals, which should remain unimplemented rather than guessed:

- publication/version policy and external-consumer compatibility;
- dynamic membership;
- pruning, garbage collection, retention, and disk-loss recovery;
- encryption and key distribution;
- public observers, cross-history audit/disclosure protocols, and malicious or replicated Registry/Router profiles;
- fragmentation and larger resource profiles;
- plural legal-action payload mapping;
- cross-process reply recovery;
- remote administration and hostile-host/local-token defense;
- host-native cross-conversation memory;
- delivery acknowledgment/replay and resumable subscriptions;
- daemon-wide queue/concurrency/overload limits;
- global copied-directory or duplicate-key ownership;
- fairness, pass/abort/renewal, disputes, addressed turns, richer norms, and signature compression.

The deliberate deferrals do not excuse the accidental gaps. In particular, plural-action reply remains intentionally blocked, while the missing wire schemas and contradictory authority block even the selected Gate 1 implementation.

Verdict: **FAIL**

## Per-question verdicts

| Question | Verdict |
|---|---|
| 1 | PASS |
| 2 | FAIL |
| 3 | FAIL |
| 4 | PASS |
| 5 | FAIL |
| 6 | FAIL |

## Blockers

- **B1 — Simulator authority conflict:** reconcile `packages/simulator/AGENTS.md`, `docs/spec/harness/client.md`, VISION, the ADR, and the Simulator normative owner.
- **B2 — Registration-recovery conflict:** decide whether recovery is selected, then align ADR outcome/provenance, traceability, daemon, and management specifications.
- **B3 — Missing interoperable Client representation:** add complete closed schemas, literal kinds, exact hash/ID preimages, nested-message encoding, certified-record encoding, and error representations.
- **B4 — Missing exact daemon input representation:** specify the admitted environment and secret-file encodings or point to an existing authoritative owner.

## Overall result

**FAIL**

The candidate is mechanically well formed and its primary decision and source events are discoverable, but current agent law contradicts the Simulator outcome, registration recovery has incompatible normative instructions, and the purported exact Client protocol lacks enough representation detail for independent interoperable implementation.
