# Blind decision review record — PR 974 second isolated review

## Exact prompt received

```text
You are the fresh isolated blind reviewer. Work read-only in the candidate repository root `/home/tapanc/moltzap-pr-974-altitude`. You receive no design summary, diff tour, file pointer, search term, expected answer, prior review output, inherited conversation, memory, or private state. Do not ask the author questions; there will be no author interventions. Use ordinary repository navigation, history, and search. You MUST NOT open, read, or search the contents of any earlier `*-cold-review.md` record or invalid-review record; merely seeing an artifact path in a listing or history is allowed. If any command returns an answer or verdict from one of those quarantined records, stop and mark the run invalid. Stay in one uninterrupted context.

First record your reviewer identity, isolation attestation, candidate identity discovered with git, UTC start/end timestamps and duration, and then preserve an exact discovery trail (commands/paths/headings you independently used). Answer these questions verbatim and without inferred motives, confidence, urgency, or rationale:

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

For each question, give an explicit PASS/FAIL verdict and discovered supporting paths/headings. End with blockers and an overall PASS/FAIL. Do not edit any files.
```

## Verbatim completed review

# Blind review result: FAIL

## Review identity

| Field | Value |
|---|---|
| Review run ID | `pr974-second-blind-20260811T215523Z` |
| Candidate commit | `9eae736712ec4b736df4b87c1c6e279d337b4ddb` |
| Candidate tree | `a051ef067d71bf8df9366fa44a83165920fe3376` |
| Discovered branch | `agent/pr-974-altitude` |
| Reviewer | Codex agent `/root/pr974_second_blind_review` |
| Started | `2026-08-11T21:55:23Z` |
| Finished | `2026-08-11T22:04:28Z` |
| Duration | 9 minutes 5 seconds |
| Worktree | Clean before and after review |
| Author interventions | None |

## Fresh-context attestation

- I did not author or reconcile this candidate.
- I received no design summary, diff tour, file pointer, search term, expected answer, answer key, prior review output, or private state.
- I independently navigated the candidate repository and history.
- A quarantined cold-review pathname appeared in `git diff --name-only` and history. I did not open, read, or search its contents, and no answer or verdict from it was returned.
- I did not ask the author questions or modify files.

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

**Verdict: PASS**

The candidate makes a three-record production harness contract current on `main`:

1. A profile slot is one agent’s local presence: `{agentName, mcpPort, agentId?, apiKey?}`. The identity fields exist together or not at all; the operator supplies the stable nonzero port.
2. `HarnessClient` is the sole production adapter-facing capability. It owns local context projection, checkpoints, conversation start, a scoped turn stream, and live-turn-bound replies.
3. `moltzapd` serves one loopback listener at `/mcp`; its catalog changes from `{register,status}` before identity commit to six active tools afterward. The bespoke CLI, Unix socket, local RPC dialect, `/register/mcp`, and generic adapter send are retired.

These resolve three documented production gaps: no profile-owned endpoint or persistent checkpoint home; competing direct adapter integrations with no production `HarnessClient` caller; and registration being unreachable through MCP because the daemon could not bind before identity existed.

Binding material is the `Decision Outcome` of each accepted ADR, including nested `Compatibility`, `Restart guarantee`, and `Accepted loss` sections. `Context and Problem Statement`, `Considered Options`, `Consequences`, and record changelogs are explanatory or historical under `docs/decisions/README.md → Canonical reading guidance`. The source-event ledgers explicitly describe themselves as non-normative.

Supporting paths/headings:

- `docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md → Decision Outcome`
- `docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md → Decision Outcome / Restart guarantee / Accepted loss`
- `docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md → Decision Outcome`
- `docs/decisions/README.md → Canonical reading guidance`
- `docs/decision-evidence/20260805-production-harness-cutover-trajectory.md → Production harness cutover source-event ledger`

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

**Verdict: PASS**

No earlier ADR is formally superseded: all three new records are `accepted`, name no `superseded-by`, and do not change an earlier record’s status.

They replace production mechanisms that lacked a current main-owned contract:

- The three-field profile plus externally supplied daemon port becomes the slot-owned record and port.
- Direct OpenClaw/NanoClaw construction of `MoltZapService`, `MoltZapChannelCore`, and network lifecycles becomes sole consumption through `HarnessClient`.
- The CLI/socket/two-MCP-route implementation becomes one state-gated `/mcp` listener and one published daemon binary.
- Generic proactive send becomes unconditional conversation start.

They retain:

- The older accepted fixed loopback URL, nonzero-port, bind-failure, trusted-local-process, Origin-validation, and no-local-token decisions.
- The network `Conversation` representation without participants; participant projection exists only across the endpoint-local MCP boundary.
- Search and history as daemon management operations rather than public `HarnessClient` methods.
- Structural compatibility with the separately owned v2 `HarnessClient` contract without shared code or runtime generation selection.
- All v2 contracts and `v2/*` implementation authority.

The apparent overlap with the older Gate 1 daemon record is resolved by scope. `20260729-v2-authority-lives-with-v2.md` assigns `main` ownership to v1 production and the `v2` branch to `v2/*`; the new ADRs expressly govern `packages/*`. The main-resident `docs/spec/cli.md` and `docs/spec/endpoints/daemon.md` carry explicit scope notes saying they are v2 material, not production specifications.

The current production normative contract is the three accepted ADR outcomes on `main`. The exact implementation owners are discoverable in `packages/client`, `packages/openclaw-channel`, and `packages/nanoclaw-channel`.

Supporting paths/headings:

- `docs/decisions/20260729-v2-authority-lives-with-v2.md → Binding outcome`
- `docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md → Decision Outcome`
- `docs/spec/cli.md → Scope`
- `docs/spec/endpoints/daemon.md → Scope`
- `origin/v2:docs/decisions/20260801-harness-client-owns-runtime-context.md → Decision Outcome`
- The three 2026-08-05 ADR `Decision Outcome` sections

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

**Verdict: PASS**

An implementer must:

- Strictly decode the slot record; require `agentName` and `mcpPort`; accept `agentId` and `apiKey` only as a pair.
- Treat missing slot and existing unregistered slot as distinct errors.
- Derive `http://127.0.0.1:<mcpPort>/mcp`; never allocate, scan, hash, increment, fall back, or bind port zero.
- Key presentation checkpoints by profile name.
- Give adapters only `HarnessClient`: conversation start and one scoped turn stream carrying bound replies.
- Keep search/history internal to context reconstruction and never recreate reply authority from history.
- Advance checkpoints immediately before emitting the associated turn.
- Keep participant enrichment endpoint-local and leave the network representation closed.
- Bind one listener before identity exists, expose exactly `register` and `status` in slot state, then the six active tools without `register`.
- Keep `status` in both catalog states and notify open subscribers when the catalog changes.
- Bind only `127.0.0.1`, validate localhost Host and Origin, and add no local token.
- Persist registration credentials to the slot without returning key material.
- Publish only `moltzapd`; remove the CLI, Unix socket, local RPC dialect, `/register/mcp`, and generic adapter send.

Affected consumers are `@moltzap/client`, OpenClaw, NanoClaw, simulator adapter acquisition/tests, package exports, documentation, and packaging. `v2/*` is unaffected.

Assumptions and guarantees:

- Local processes are trusted. Hostile same-host defense and local authorization remain deferred.
- Duplicate port use fails at bind rather than silently misrouting.
- Preserved checkpoints give at-most-once context presentation in normal operation.
- Lost checkpoints may re-present context.
- Failure after checkpoint advancement but before runtime receipt loses that context; there is no acknowledgement or replay.
- Historical reads never recreate reply authority.
- Registration is non-idempotent and claims no operation identifier, retry identity, or crash recovery.
- The config change is intentionally breaking: old three-field files fail strict decoding, with no shim or automated migration.
- These ADRs select no broader Byzantine/network-service fault model; existing production network behavior remains outside this decision bundle.

Supporting paths/symbols:

- `packages/client/src/profile.ts → profileRecordSchema`
- `packages/client/src/harness-client.ts → HarnessClientService`
- `packages/client/src/moltzapd.ts → serveProfileSlot`
- `packages/client/src/moltzapd-catalog.ts → makeActiveTools`
- `packages/client/src/harness-mcp-wire.ts → HarnessDaemonPhase`
- `packages/client/src/harness-mcp-server.ts → makeHarnessMcpHttpRequests`
- `scripts/architecture/check-boundaries.js → checkAdapterFile`

## 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

**Verdict: PASS**

All three ADRs name **Tapan Chugh** as decision-maker.

The production ledger cites:

- Profile slot:
  - Assistant message `3fdf75a2-5707-40e7-8403-e95dee71ac83`, then user message `846eb3e5-3a93-4b6e-b33c-213102377717`.
  - The user says required `mcpPort` is not a concern because the product is pre-launch and says proactive DMs can be dealt with later.
  - Mechanical PRs #954 and #955.
- HarnessClient:
  - User message `39159e1d-a69f-466b-82a3-028d01816ee8`.
  - Assistant message `836728c5-1a19-41e2-bbd2-51145b0ab17c`, which distinguishes an ADR-settled directory question from open status and Docker questions.
  - User messages `5a444536-1723-4d8b-8633-9b0af7c78166` and `6ca4d0c9-07b1-446d-80e6-11aebd3c3c7e`, retaining status as a tool, requesting simplification, and stating that checked-in reviews and ADR precedence should apply.
  - Mechanical PRs #959, #960, and #972.
  - Issue #926 comment `5185240471`, an agent-authored classification sweep.
- One MCP path:
  - User message `97d842db-f24b-4912-8b82-3b829ce509d5`, assistant message `657c5378-0317-4399-b01d-9dce2c410bf4`, and user messages `0ed9a11f-2c36-4df9-8bfe-e7f1a01d5484` and `4b93bb9e-965b-4a62-85ae-b520c98a4bbb`.
  - Codex session `019fba0c-9f1e-7911-9496-45b305a00cb5` user inputs at `2026-07-31T21:57:09Z`, `23:54:09Z`, and `23:54:40Z`, recording the separate-path proposal followed by the one-server reversal and “the daemon can handle both the things.”
  - Assistant message `6dcea6f6-a3c2-4522-af24-224ef1c6760f`, which presents two paths, one state-gated path, and deferral.
  - User message `8fd049fd-2f65-4f29-bde8-76e2a4700643`, plus the reused status event `5a444536-1723-4d8b-8633-9b0af7c78166`.
  - Mechanical PR #961.
- Retained local trust:
  - Gate 1 session `019fa633-abe3-7223-8c51-6d061f5c5855` records the user’s HTTP-MCP reversal, the user statement “local process security is deferred for now. assume trusted,” and the one-active-adapter reply “only one per daemon; both cannot race.”

External repository locators were independently verified: issue comments `5198672021` and `5185240471`, and PRs #954, #955, #959, #960, #961, and #972 exist with the identities, timestamps, and titles stated by the ledger.

Explicit source gaps:

- Both source sessions remain local to the maintainer’s machine.
- Issue #926 comment `5198672021` is durable but agent-authored and cannot independently prove the session transcription.
- The later attestation reply is literally `hes`; the ledger records its affirmative reading and the condition under which that reading would fail.
- Three defects in an earlier second-hand quotation are recorded; the directly read Codex events replace those quotations.
- No retained user event gives reasons for the calls.
- The restart and reply-authority guarantees have no main-side human source and are adopted from the clean-slate ADR.
- Checkpoint durability properties are undecided and have no retained event.
- Registration non-idempotence is recorded as an existing server property, not a selected human choice.

Supporting paths/headings:

- `docs/decision-evidence/20260805-production-harness-cutover-trajectory.md →` all three decision headings and `Source gaps`
- `docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md → The endpoint daemon exposes modern MCP over loopback HTTP`

## 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

**Verdict: FAIL**

The strongest architecture-level apparent contradiction—main-resident v2 CLI/daemon specifications versus the production one-path/no-CLI outcome—is resolvable by branch and scope authority. The scope notes and `V2 authority lives with V2` make those specifications non-production.

A separate current instruction is not resolvable as valid behavior:

- `SKILL.md → Error Codes` says `Unauthorized` caused by a bad or expired API key should be handled by **“Re-register the slot.”**
- The same file says registration is non-idempotent and a lost response requires a new agent name.
- The accepted daemon outcome says `register` exists only before commit and disappears from the active catalog.
- `packages/client/src/moltzapd-registration.ts → makeRegisterHandler` rejects registration once the daemon is active.
- No credential recovery, rotation, or slot-replacement contract selects what should happen instead.

Applying the authority order establishes that the `SKILL.md` instruction is stale, but it does not produce a correct recovery action. This is blocker **B1**.

## 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

**Verdict: FAIL**

The core three-part architecture is implementable from the repository. The complete candidate is not contradiction-free without guessing about two operator-facing paths.

| Item | Classification | Status |
|---|---|---|
| Checkpoint format, fsync policy, cache/sharding, quota, and corruption recovery | Deliberate ADR-level deferral; no retained human event selects them | Non-blocking |
| Acknowledgement/replay across checkpoint advancement and runtime receipt | Explicitly accepted loss | Non-blocking |
| Hostile same-host defense and a future local token | Explicit deferral | Non-blocking |
| Registration operation identifiers, idempotency keys, and crash recovery | Explicitly unclaimed | Non-blocking |
| Reuse of proactive one-to-one conversations | Explicitly left for later in the retained user event | Non-blocking |
| Recovery from an invalid/expired persisted API key | **Accidental gap**: `SKILL.md` prescribes impossible same-slot re-registration | **B1** |
| Standalone versus adapter-owned daemon handoff | **Accidental documentation gap**: `SKILL.md` installs OpenClaw and starts `moltzapd` manually, while `docs/integrations/openclaw.mdx` says the plugin starts that slot’s daemon and the HarnessClient ADR rejects a second acquisition. The skill never states the ownership handoff or that the standalone daemon must stop before plugin acquisition. | **B2** |

## Discovery trail

1. Established UTC start, clean status, branch, HEAD, and latest commit with `date -u`, `git status`, `git rev-parse`, and `git log -1`.
2. Used `git branch -a`, `git log --graph`, `git show --stat`, merge-base checks, and name-only diffs to discover the candidate history and changed decision paths. A quarantined review pathname appeared only as a pathname.
3. Read `AGENTS.md → Decisions` and `docs/decisions/README.md → Canonical reading guidance / Records`.
4. Loaded the repository-required `.claude/skills/decisions/SKILL.md`, `references/provenance.md`, `.claude/skills/cold-read/SKILL.md`, the fixed questions, and the blank review template.
5. Read all three 2026-08-05 ADRs in full.
6. Read `20260805-production-harness-cutover-trajectory.md` in full.
7. Followed the second provenance link to `20260728-gate-1-engineering-review-trajectory.md → The endpoint daemon exposes modern MCP over loopback HTTP`.
8. Read the older endpoint ADR, the v2-authority ADR, the main simulator ADR, and the explicit scope notes in both main-resident v2 specifications.
9. Verified the referenced clean-slate `HarnessClient` ADR exists on `origin/v2` and is absent from the candidate branch.
10. Searched, explicitly excluding quarantined files, for `/register/mcp`, `--port`, socket/CLI language, direct adapter service/core use, generic send, profile shapes, migration language, and daemon ownership.
11. Read profile, HarnessClient, daemon phase/catalog, MCP server, registration, acquisition, and adapter-containment implementations and their focused tests.
12. Inspected package binary/export maps and the architecture boundary checks.
13. One adapter-import search had malformed shell quoting and failed before reading a file; it was rerun with a corrected `rg` command.
14. Verified issue-comment and PR metadata through `gh api`.
15. Inspected `scripts/docs/adr/check-shape.ts` to ensure it would not read quarantined artifacts, then ran it: `PASS — 53 record(s) well-formed`.
16. Compared the candidate’s `SKILL.md` against `origin/main` and searched all non-quarantined current docs/code for registration retry and daemon-handoff instructions.
17. Rechecked clean worktree status, commit, tree, UTC end, and duration.

## Blockers

| ID | Finding | Required reconciliation |
|---|---|---|
| B1 | `SKILL.md` instructs impossible same-slot re-registration for `Unauthorized`; no valid credential-recovery path is defined. | Remove the false instruction and state the supported recovery, or admit the needed recovery/rotation decision. |
| B2 | The OpenClaw skill flow starts a standalone daemon while the plugin independently owns and starts the same slot daemon; no handoff is documented. | Split standalone-MCP and adapter-owned flows and explicitly document ownership and shutdown/handoff. |

## Overall result

**FAIL**

The decision outcomes, scope, lineage, assumptions, and provenance are independently discoverable, and the mechanical ADR gate passes. The two current operator-facing contradictions—especially the impossible `Unauthorized` recovery—prevent a contradiction-free implementation and handoff without guessing.

## Exact command-level discovery trail

Commands below are recorded in execution order. Commands issued together are retained as multiline blocks. The quarantined review artifact appeared only as a pathname in listing/diff output.

1.

```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'
git status --short --branch
git rev-parse HEAD
git branch --show-current
git log -1 --format='%H%n%h %D%n%aI%n%s'
```

2.

```bash
git branch -a
git log --oneline --decorate --graph -15
git show --stat --summary --format=fuller HEAD
git merge-base HEAD origin/v2
git merge-base HEAD origin/main
git diff --name-status origin/v2...HEAD
git diff --name-status origin/pr/974...HEAD
```

3.

```bash
wc -l AGENTS.md docs/decisions/README.md docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md docs/decision-evidence/20260805-production-harness-cutover-trajectory.md
rg -n '^#{1,6} ' AGENTS.md docs/decisions/README.md docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md docs/decision-evidence/20260805-production-harness-cutover-trajectory.md
sed -n '1,260p' AGENTS.md
sed -n '1,260p' docs/decisions/README.md
```

4.

```bash
wc -l .claude/skills/decisions/SKILL.md .claude/skills/decisions/references/provenance.md
sed -n '1,260p' .claude/skills/decisions/SKILL.md
sed -n '1,320p' .claude/skills/decisions/references/provenance.md
```

5.

```bash
find .claude/skills/cold-read -maxdepth 2 -type f -print | sort
wc -l .claude/skills/cold-read/SKILL.md .claude/skills/cold-read/references/questions.md docs/decision-evidence/cold-review-template.md
sed -n '1,260p' .claude/skills/cold-read/SKILL.md
sed -n '1,240p' .claude/skills/cold-read/references/questions.md
sed -n '1,260p' docs/decision-evidence/cold-review-template.md
```

6.

```bash
git rev-parse HEAD^{tree}
git status --porcelain=v1
sed -n '1,220p' docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md
sed -n '1,220p' docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md
sed -n '1,240p' docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md
```

7.

```bash
sed -n '1,220p' docs/decision-evidence/20260805-production-harness-cutover-trajectory.md
sed -n '221,440p' docs/decision-evidence/20260805-production-harness-cutover-trajectory.md
```

8.

```bash
wc -l docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md
rg -n '^#{1,6} ' docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md
sed -n '1,18p' docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md
sed -n '711,767p' docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md
wc -l docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md
sed -n '1,260p' docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md
```

9.

```bash
wc -l docs/decisions/20260729-v2-authority-lives-with-v2.md docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md docs/spec/cli.md docs/spec/endpoints/daemon.md packages/client/AGENTS.md packages/openclaw-channel/AGENTS.md packages/nanoclaw-channel/AGENTS.md
sed -n '1,240p' docs/decisions/20260729-v2-authority-lives-with-v2.md
sed -n '1,260p' docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md
sed -n '1,220p' docs/spec/cli.md
sed -n '1,260p' docs/spec/endpoints/daemon.md
sed -n '1,220p' packages/client/AGENTS.md
sed -n '1,220p' packages/openclaw-channel/AGENTS.md
sed -n '1,220p' packages/nanoclaw-channel/AGENTS.md
```

10.

```bash
sed -n '1,90p' docs/spec/endpoints/daemon.md
rg -n 'Harness|harness|profile|mcpPort|moltzapd|OpenClaw|NanoClaw|MCP|CLI|socket|production' docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md
sed -n '200,330p' docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md
```

11.

```bash
rg -n --hidden --glob '!.git/**' --glob '!docs/decision-evidence/*-cold-review.md' --glob '!docs/decision-evidence/*-invalid-review.md' '/register/mcp|REGISTER_MCP_PATH|register/mcp' README.md SKILL.md docs packages scripts package.json nx.json
rg -n --hidden --glob '!.git/**' --glob '!docs/decision-evidence/*-cold-review.md' --glob '!docs/decision-evidence/*-invalid-review.md' -- '--port' README.md SKILL.md docs packages scripts package.json nx.json
rg -n --hidden --glob '!.git/**' --glob '!docs/decision-evidence/*-cold-review.md' --glob '!docs/decision-evidence/*-invalid-review.md' 'local-daemon-rpc|local socket|Unix domain socket|socket plane|moltzap CLI|moltzap binary|CLI and socket|bespoke CLI' README.md SKILL.md docs packages scripts package.json nx.json
```

12.

```bash
rg -n --hidden --glob '!.git/**' --glob '!docs/decision-evidence/*-cold-review.md' --glob '!docs/decision-evidence/*-invalid-review.md' 'moltzap (register|status|start|agents|conversations|messages|send)|bin/moltzap|"moltzap"\s*:' README.md SKILL.md docs packages scripts package.json nx.json
rg -n --hidden --glob '!.git/**' --glob '!docs/decision-evidence/*-cold-review.md' --glob '!docs/decision-evidence/*-invalid-review.md' 'MoltZapService|MoltZapChannelCore' packages/openclaw-channel packages/nanoclaw-channel packages/simulator packages/client/src/README.md packages/client/AGENTS.md docs/integrations docs/guides README.md
rg -n --hidden --glob '!.git/**' --glob '!docs/decision-evidence/*-cold-review.md' --glob '!docs/decision-evidence/*-invalid-review.md' 'sendToAgent|sendToConversation|generic send|conv:<|conversation target|existing conversation' packages/openclaw-channel packages/nanoclaw-channel packages/client/src/README.md packages/client/AGENTS.md docs/integrations docs/guides README.md
```

13.

```bash
sed -n '1,180p' docs/integrations/openclaw.mdx
sed -n '1,150p' packages/openclaw-channel/src/README.md
sed -n '1,130p' packages/openclaw-channel/src/MODULE.md
sed -n '1,140p' docs/guides/user-agent-communication.mdx
sed -n '400,475p' packages/simulator/src/agents/openclaw/runtime.ts
sed -n '1,240p' docs/concepts/profiles.mdx
sed -n '1,220p' packages/client/src/README.md
rg -n 'HarnessClient|moltzapd|MoltZapService|MoltZapChannelCore|profile|mcpPort|CLI|MCP|socket' docs/architecture.mdx README.md SKILL.md docs/quickstart.mdx docs/introduction.mdx docs/guides/two-agent-chat.mdx
sed -n '1,220p' docs/architecture.mdx
```

14.

```bash
git log --format='%H %aI %s' origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD -- docs/decisions docs/decision-evidence | sort
git log --diff-filter=A --format='%H %aI %s' -- docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md
git cat-file -e origin/v2:docs/decisions/20260801-harness-client-owns-runtime-context.md && echo PRESENT_ON_ORIGIN_V2
git cat-file -e HEAD:docs/decisions/20260801-harness-client-owns-runtime-context.md 2>/dev/null || echo ABSENT_ON_CANDIDATE_BRANCH
git show origin/v2:docs/decisions/20260801-harness-client-owns-runtime-context.md | sed -n '1,260p'
```

15.

```bash
rg -n 'mcpPort|config.json|profile slot|migration|rewrite|pre-launch|HarnessClient|moltzapd|CLI' CHANGELOG.md
sed -n '1,150p' CHANGELOG.md
sed -n '1,190p' packages/client/src/profile.ts
sed -n '1,210p' packages/client/src/profile.test.ts
rg -n 'unknown|three-field|partial|agentId.*apiKey|apiKey.*agentId|not registered|not found|mcpPort' packages/client/src/profile.test.ts
sed -n '210,430p' packages/client/src/profile.test.ts
sed -n '430,620p' packages/client/src/profile.test.ts
```

16.

```bash
git remote get-url origin
gh api repos/chughtapan/moltzap/issues/comments/5198672021 --jq '[.id,.user.login,.created_at,.html_url] | @tsv'
gh api repos/chughtapan/moltzap/issues/comments/5185240471 --jq '[.id,.user.login,.created_at,.html_url] | @tsv'
for pr_number in 954 955 959 960 961 972; do gh api "repos/chughtapan/moltzap/pulls/${pr_number}" --jq '[.number,.user.login,.created_at,.title,.html_url] | @tsv'; done
```

17.

```bash
rg -n 'export (interface|class|const|function)|HarnessClient|startConversation|turns|reply' packages/client/src/harness-client.ts
rg -n 'export (interface|class|const|function)|harnessClientForProfile|checkpoint|mcpPort|127\.0\.0\.1|profile' packages/client/src/moltzapd-child.ts
rg -n 'export (interface|class|const|function)|register|status|catalog|tool' packages/client/src/moltzapd-catalog.ts
rg -n '127\.0\.0\.1|Origin|origin|Host|host|/mcp|MCP_PATH|listen' packages/client/src/harness-mcp-server.ts packages/client/src/harness-mcp-server.test.ts
sed -n '1,280p' packages/client/src/harness-client.ts
sed -n '1,260p' packages/client/src/moltzapd-catalog.ts
```

18.

```bash
rg -n 'slot|active|register|status|six|tools|HARNESS_.*TOOL|phase' packages/client/src/harness-mcp-wire.ts packages/client/src/moltzapd.ts packages/client/src/moltzapd-registration.ts
sed -n '1,260p' packages/client/src/moltzapd.ts
sed -n '1,210p' packages/client/src/moltzapd-registration.ts
sed -n '1,220p' packages/client/src/harness-mcp-wire.ts
sed -n '1,240p' SKILL.md
rg -n 'HARNESS_(REGISTER|STATUS|SEARCH_AGENTS|SEARCH_CONVERSATIONS|START_CONVERSATION|READ_CONVERSATION|REPLY)_TOOL' packages/client/src/harness/index.ts packages/client/src/harness/*.ts packages/client/src/harness-mcp-wire.ts
```

19.

```bash
node -e 'const p=require("./packages/client/package.json"); console.log(JSON.stringify({bin:p.bin,exports:p.exports},null,2))'
rg -n '"moltzap"|"moltzapd"|src/cli|local-daemon-rpc|local-socket-server' packages/client/package.json package.json nx.json knip.json scripts/architecture/check-boundaries.js
sed -n '1,230p' scripts/architecture/check-boundaries.js
sed -n '35,60p' knip.json
sed -n '300,390p' scripts/architecture/check-boundaries.js
rg -n 'MoltZapService|MoltZapChannelCore|@moltzap/client(?!/harness-client)|harness-client' packages/openclaw-channel/src packages/nanoclaw-channel/src --pcre2 --glob '!**/*.test.ts' --glob '!**/__tests__/**'
```

The next adapter-import command contained malformed shell quoting, returned `/bin/bash: unexpected EOF while looking for matching '"'`, and read no additional file. The corrected search was:

```bash
rg -n 'ADAPTER_PACKAGES|function checkAdapterFile|HarnessClient|MoltZapService|MoltZapChannelCore' scripts/architecture/check-boundaries.js
sed -n '230,315p' scripts/architecture/check-boundaries.js
rg -n 'from "@moltzap/client|from ''@moltzap/client' packages/openclaw-channel/src packages/nanoclaw-channel/src --glob '!**/*.test.ts' --glob '!**/__tests__/**'
```

20.

```bash
rg -n 'decision-evidence|cold-review|invalid-review|readFile|glob|readdir' scripts/docs/adr/check-shape.ts
sed -n '1,300p' scripts/docs/adr/check-shape.ts
rg -n 'Decision provenance:.*(cold-review|invalid-review)' docs/decisions || true
pnpm exec tsx scripts/docs/adr/check-shape.ts
```

21.

```bash
git diff --unified=5 origin/main...HEAD -- SKILL.md
rg -n 're-register|register again|retry.*register|lost response|not idempotent|Unauthorized' README.md SKILL.md docs packages --glob '!docs/decision-evidence/*-cold-review.md' --glob '!docs/decision-evidence/*-invalid-review.md' --glob '!docs/decisions/**' --glob '!**/*.test.ts'
rg -n --hidden --glob '!.git/**' --glob '!docs/decision-evidence/*-cold-review.md' --glob '!docs/decision-evidence/*-invalid-review.md' 'stop.*moltzapd|kill.*moltzapd|already-running slot|already running slot|starts? (that |the )?slot.*daemon|spawns? (that |the )?slot.*daemon|bind conflict|existing one|second acquisition|daemon ownership|owns.*daemon' README.md SKILL.md CHANGELOG.md docs packages/client packages/openclaw-channel packages/nanoclaw-channel
rg -n 'moltzapd --profile|harnessClientForProfile|openclaw plugins install' SKILL.md docs/quickstart.mdx docs/concepts/profiles.mdx docs/integrations/openclaw.mdx CHANGELOG.md packages/client/AGENTS.md packages/openclaw-channel/AGENTS.md
```

22.

```bash
date -u '+%Y-%m-%dT%H:%M:%SZ'
git status --short --branch
git diff --exit-code -- . ':(exclude)docs/decision-evidence/*-cold-review.md' ':(exclude)docs/decision-evidence/*-invalid-review.md'
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

23.

```bash
review_end_utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
review_start_epoch=$(date -u -d '2026-08-11T21:55:23Z' '+%s')
review_end_epoch=$(date -u -d "$review_end_utc" '+%s')
review_elapsed=$((review_end_epoch-review_start_epoch))
printf '%s\n%s seconds (%d minutes %d seconds)\n' "$review_end_utc" "$review_elapsed" "$((review_elapsed/60))" "$((review_elapsed%60))"
git status --porcelain=v1
git rev-parse HEAD
git rev-parse HEAD^{tree}
```

## Author interventions

None.

## Maintainer acceptance

| Field | Value |
|---|---|
| Review result | **FAIL** |
| Maintainer acceptance | **PENDING** |
| Candidate commit | `9eae736712ec4b736df4b87c1c6e279d337b4ddb` |
| Candidate tree | `a051ef067d71bf8df9366fa44a83165920fe3376` |
