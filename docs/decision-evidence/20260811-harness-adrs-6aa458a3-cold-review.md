# Blind decision review record

## Exact fixed prompt received

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

## Review identity

| Field | Value |
|---|---|
| Review run ID | `pr974-formal-blind-20260811T213256Z` |
| Candidate commit | `6aa458a360aa0eebadcfdb6130b93ab07d12a91f` |
| Candidate tree | `8061f6e94a5207a01d3190a8667222164e92832b` |
| Candidate branch | `agent/pr-974-altitude`, six commits ahead of `origin/pr/974` |
| Reviewer | Codex agent `/root/pr974_formal_blind_review` |
| Review started | `2026-08-11T21:32:56Z` |
| Review finished | `2026-08-11T21:44:08Z` |
| Duration | 11m 12s |
| Review budget | One uninterrupted fresh-agent context |
| Checkout status | Clean; `git diff --exit-code` returned 0 |
| Author interventions | None |

## Fresh-context attestation

- [x] I did not author or reconcile the candidate.
- [x] I received no design summary, diff tour, file pointer, search term, expected answer, previous result, or private candidate state.
- [x] I navigated from repository law, indexes, ordinary search, history, and source files.
- [x] Earlier cold/invalid-review paths appeared only in listings. I did not open, read, or search their contents, and no answer or verdict from them was returned.
- [x] I did not ask the author for help.
- [x] I made no file changes.
- [x] `pnpm check:agent-setup` passed, including the repository’s `gbrain` prerequisite.
- [x] `pnpm exec tsx scripts/docs/adr/check-shape.ts` passed all 53 ADRs.
- [x] Both cited issue comments and PRs #954, #955, #959, #960, #961, and #972 resolved with matching metadata.

## Fixed questions and answers

### 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

**Verdict: PASS**

The candidate makes three production-`main` decisions current:

1. A profile slot is `{agentName, mcpPort, agentId?, apiKey?}`. Name and stable nonzero port exist from creation; identity fields are committed together. The slot also scopes the filesystem checkpoint store.
2. `HarnessClient` is the sole production adapter-facing capability. It owns presentation projection, local checkpoints, conversation start, one turn stream, and live-turn-bound replies.
3. `moltzapd` serves one fixed loopback `/mcp` route. Its catalog is `{register,status}` before identity commit and the six active tools afterward. The CLI, Unix socket, bespoke local RPC dialect, and generic adapter send are retired.

These resolve the missing production path from profile name to daemon URL, duplicate adapter-owned network/presentation stacks, contested local membership projection, and registration that could not be reached before daemon activation.

Binding text is each accepted ADR’s `Decision Outcome`, including `Compatibility`, `Restart guarantee`, and `Accepted loss`. `Context and Problem Statement`, `Considered Options`, `Consequences`, record changelogs, and the trajectory are context, effects, or evidence rather than independent normative outcomes.

Supporting paths/headings:

- `docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md` → `Decision Outcome`, `Compatibility`
- `docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md` → `Decision Outcome`, `Restart guarantee`, `Accepted loss`
- `docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md` → `Decision Outcome`
- `docs/decisions/README.md` → `Canonical reading guidance`, `Records`

### 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

**Verdict: PASS**

No earlier accepted ADR is formally superseded: all three records are `accepted`, have no `superseded-by`, and the index records `—`. They replace shipped but previously unadmitted production shapes:

- three-field profiles and externally supplied daemon ports;
- adapters constructing `MoltZapService`/`MoltZapChannelCore` directly;
- two MCP paths plus the CLI/socket plane;
- generic outbound send.

They retain the production server and canonical network wire. Conversation membership is projected only across the endpoint-local MCP boundary; it is not added to the network `Conversation` representation.

They leave the clean-slate track untouched. The v2 `HarnessClient` record remains independently owned and structurally compatible rather than code-shared. The two-path clean-slate design and retained `docs/spec/cli.md` and `docs/spec/endpoints/daemon.md` copies are explicitly scoped away from `packages/*`.

The current production contract lives in the three new accepted ADR outcomes, supplemented operationally by package law and public symbols such as `harness-client.ts → HarnessClientService`. The clean-slate contract lives on `v2`, not in the main-resident spec copies.

Supporting paths/headings:

- `docs/decisions/20260729-v2-authority-lives-with-v2.md` → `Binding outcome`
- `docs/spec/cli.md` → `Scope`
- `docs/spec/endpoints/daemon.md` → `Scope`
- `packages/client/AGENTS.md` → `Structure`, `Concepts`
- `packages/client/src/harness-client.ts` → `HarnessClientService`

### 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

**Verdict: FAIL**

The functional obligations are discoverable:

- enforce strict slot decoding, required `agentName`/`mcpPort`, and all-or-neither identity fields;
- derive only `http://127.0.0.1:<mcpPort>/mcp`; never allocate, scan, bind port zero, or fall back;
- keep presentation checkpoints in a profile-scoped filesystem `KeyValueStore`;
- expose only `HarnessClient` to OpenClaw/NanoClaw adapters;
- keep search/history as private client read-plane operations and history incapable of recreating reply authority;
- bind replies to live turns;
- bind the daemon before identity exists, switch catalogs after registration, notify open clients of the change, and never return key material;
- remove the CLI/socket/local-RPC/generic-send surfaces.

Affected areas are local profile/configuration, the endpoint-local MCP boundary, client-owned presentation/recovery, protocol/server management reads, OpenClaw, NanoClaw, and simulator provisioning. The canonical network wire and v2 remain outside scope.

Discoverable failure and compatibility assumptions include fatal bind collision, checkpoint-loss re-presentation, the checkpoint-before-delivery loss window, no acknowledgment/replay, unrecoverable lost registration response for the same agent name, and strict pre-launch breakage without a migration shim.

The blocker is the production trust contract. The new records make an unauthenticated-looking loopback listener current but do not say whether same-host processes are trusted, whether Host/Origin validation is binding, or whether a local token is forbidden, required, or deferred. The only explicit statement is in `20260728-endpoint-daemon-speaks-modern-mcp.md`, but the profile ADR explicitly calls that clean-slate outcome precedent rather than production authority, and the retained specs scope themselves away from `packages/*`. Current code happens to validate localhost Host/Origin and add no token, but implementation is not normative authority.

An implementer therefore must guess a security-sensitive choice.

Supporting paths/headings/symbols:

- New three ADRs → `Decision Outcome`
- `docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md` → `Decision Outcome`
- `docs/spec/endpoints/daemon.md` → `Scope`, `Process and profile`
- `packages/client/src/harness-mcp-server.ts` → `makeHarnessMcpRequestListener`
- `packages/client/src/profile.ts` → `profileRecordSchema`
- `packages/client/src/harness-context-projection.ts` → `reconstructHarnessContext`
- `packages/client/src/moltzapd.ts` → `serveProfileSlot`

### 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

**Verdict: PASS**

All three ADRs name **Tapan Chugh** as decision-maker. The trajectory separately warns that stored user roles and the `chughtapan` account do not independently authenticate a person.

For the profile-slot decision, the ledger cites:

- agent message `3fdf75a2-…`, presenting the compatibility and proactive-DM concerns;
- user message `846eb3e5-…`, stating the required port was not a concern pre-launch and proactive DMs could be dealt with later;
- PRs #954 and #955 as mechanical events.

For the HarnessClient decision, it cites:

- user message `39159e1d-…`, asking why legacy machinery was retained;
- agent message `836728c5-…`, distinguishing settled directory behavior from open status/docker choices;
- user message `5a444536-…`, retaining status and requesting simplification;
- user message `6ca4d0c9-…`, requiring checked-in reviews and ADR precedence;
- PRs #959, #960, and #972;
- issue #926 comment `5185240471`, the agent-authored ownership/divergence sweep;
- issue #926 comment `5198672021`, cited in the trajectory preamble and containing the stored membership-projection turn.

For the daemon decision, it cites:

- user `97d842db-…`, agent `657c5378-…`, and users `0ed9a11f-…`/`4b93bb9e-…` for the discovered two-path shape and “one server” correction;
- Codex-session turns at `2026-07-31T21:57:09Z`, `23:54:09Z`, and `23:54:40Z`, showing the separate-path proposal followed by the one-server reversal;
- agent message `6dcea6f6-…`, which presents the two-path, one-state-gated-path, and defer alternatives;
- user `8fd049fd-…`, approving correction;
- user `5a444536-…`, retaining status;
- PR #961.

Explicit source gaps are:

- both underlying sessions remain local to the maintainer’s machine;
- durable comment `5198672021` is agent-authored and cannot independently prove transcription fidelity;
- the later local attestation is the literal text `hes`, interpreted in the ledger only through its preceding prompt;
- no retained event states a reason for any call;
- restart and reply-authority guarantees have no main-side human source and are adopted from the clean-slate record;
- checkpoint durability choices have no retained human event;
- earlier quotation timestamps/truncation defects are recorded and corrected rather than silently normalized.

Supporting path:

- `docs/decision-evidence/20260805-production-harness-cutover-trajectory.md` → all three stable ADR headings, `Source gaps`

### 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

**Verdict: FAIL**

The strongest contradiction concerns ownership of context projection and checkpoints.

The accepted HarnessClient outcome says `HarnessClient` owns context projection and local checkpoints. The implementation agrees: `harness-client.ts → projectTurn` invokes `harness-context-projection.ts → reconstructHarnessContext` on the client side after receiving the raw MCP turn.

Candidate-authored documentation says the opposite:

- `docs/architecture.mdx` says enrichment happens “in the slot’s own moltzapd.”
- `docs/integrations/openclaw.mdx` says MCP turns already carry enriched context and that the checkpoint marker lifecycle is the daemon’s.

Authority resolves the current contract: the accepted ADR wins, so `HarnessClient` owns these responsibilities. The exact candidate still contains contradictory implementation guidance and therefore fails semantic consistency.

A second stale instruction exists in `packages/client/src/README.md`, which says the package still implements the `moltzap` CLI, local-daemon RPC, and a `cli/` directory. The accepted daemon ADR, package manifest, and tracked tree say those surfaces are gone.

Supporting paths/headings:

- Harness ADR → `Decision Outcome`, `Restart guarantee`
- `docs/architecture.mdx` → `Package dependency graph`
- `docs/integrations/openclaw.mdx` → `How it works`, `Architecture`
- `packages/client/src/README.md` → `Client source boundary`
- `packages/client/package.json` → `bin`
- `packages/client/src/harness-client.ts` → `projectTurn`
- `packages/client/src/harness-context-projection.ts` → `reconstructHarnessContext`

### 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

**Verdict: FAIL**

Most behavior is implementable from the repository, but the production local-security choice requires guessing.

Deliberate deferrals or accepted non-guarantees:

- checkpoint file format, fsync policy, cache algorithm, sharding, quota, and corruption recovery;
- re-presentation after checkpoint-store loss;
- loss between checkpoint advance and runtime receipt, with no acknowledgment or replay;
- proactive one-to-one conversation reuse;
- registration operation identifiers, idempotency keys, retry, and crash recovery;
- shell inspection without an MCP client;
- attaching a second client to an already-running slot.

Accidental gaps or contradictions:

- no production normative owner for loopback MCP trust/authentication, Host/Origin validation, or token policy;
- architecture and OpenClaw docs assign client-owned projection/checkpoints to the daemon;
- client source-boundary documentation still claims the retired CLI/socket/local-RPC surface;
- the profile ADR says the break is accepted “without … a release note,” while `CHANGELOG.md → Unreleased` contains a detailed breaking release note and migration instruction. The runtime contract is unaffected, but the compatibility statement is internally inconsistent.

Explicit provenance gaps, not implementation choices:

- local-only session sources and agent-authored durable transcription;
- no stated reason for any call;
- no main-side human source for restart/reply-authority guarantees;
- no retained human decision about checkpoint durability.

Supporting paths/headings:

- all three new ADRs → `Decision Outcome`, `Consequences`
- trajectory → `Source gaps`
- `CHANGELOG.md` → `Unreleased`
- contradiction paths from Question 5

## Discovery trail

Commands below are verbatim; commands issued concurrently are grouped.

1. Loaded required workspace guidance:

```bash
cat /home/tapanc/.codex/skills/nx-workspace/SKILL.md
```

2. Froze initial candidate identity:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse --show-toplevel
git rev-parse HEAD
git status --short --branch
git show -s --format=fuller HEAD
```

3. Discovered branch/base and changed paths:

```bash
git branch --all --verbose --no-abbrev
git merge-base origin/main HEAD
git diff --name-status origin/main...HEAD
```

The changed-path listing exposed the quarantined review filename only; it was not opened.

4. Loaded repository law and the required decision-review procedure:

```bash
cat AGENTS.md
cat .claude/skills/decisions/SKILL.md
cat .claude/skills/cold-read/references/questions.md
cat docs/decision-evidence/cold-review-template.md
```

5. Followed repository-native indexes:

```bash
find docs/decisions -maxdepth 1 -type f -print | sort
find docs/decision-evidence -maxdepth 1 -type f -print | sort
cat docs/decisions/README.md
cat docs/decision-evidence/README.md
```

6. Read the three new ADRs and their linked trajectory:

```bash
cat docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md
cat docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md
cat docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md
cat docs/decision-evidence/20260805-production-harness-cutover-trajectory.md
```

7. Followed discovered authority and scope links:

```bash
cat docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md
cat docs/decisions/20260729-v2-authority-lives-with-v2.md
git show origin/v2:docs/decisions/20260801-harness-client-owns-runtime-context.md
cat docs/spec/cli.md
cat docs/spec/endpoints/daemon.md
```

8. Read affected package law:

```bash
cat packages/client/AGENTS.md
cat packages/openclaw-channel/AGENTS.md
cat packages/nanoclaw-channel/AGENTS.md
cat packages/simulator/AGENTS.md
```

9. Audited retired and current surfaces, always excluding quarantined records:

```bash
rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*.md' '/register/mcp|REGISTER_MCP_PATH|makeRegistrationServer' .
rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*.md' -- '--port|mcpPort' README.md SKILL.md docs packages scripts package.json
rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*.md' 'MoltZapService|MoltZapChannelCore' packages/openclaw-channel packages/nanoclaw-channel
rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*.md' 'moltzap (register|start|status|send|agents|conversations|messages)|Unix domain socket|local socket|local-daemon-rpc' README.md SKILL.md docs packages scripts package.json
```

10. Inspected public and owning symbols:

```bash
cat packages/client/src/harness-client.ts
cat packages/client/src/harness-context-projection.ts
cat packages/client/src/moltzapd-registration.ts
cat packages/client/src/moltzapd-catalog.ts
sed -n '1,290p' packages/client/src/moltzapd.ts
sed -n '350,470p' packages/client/src/moltzapd-child.ts
sed -n '1,430p' packages/client/src/profile.ts
jq '{bin, exports, scripts}' packages/client/package.json
```

11. Found the stale CLI source boundary:

```bash
rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*.md' 'emitNoPersist|CLI registration|CLI transport selection|moltzap register' packages docs README.md SKILL.md
cat packages/client/src/README.md
git ls-files 'packages/client/src/cli/**' 'bin/**' 'docs/cli/**' 'docs/snippets/*cli*'
```

12. Verified source-event locators:

```bash
gh api repos/chughtapan/moltzap/issues/comments/5198672021 --jq '{id,html_url,user:.user.login,created_at,body}'
gh api repos/chughtapan/moltzap/issues/comments/5185240471 --jq '{id,html_url,user:.user.login,created_at,body}'
gh api repos/chughtapan/moltzap/pulls/954 --jq '{number,title,user:.user.login,created_at,html_url,state}'
gh api repos/chughtapan/moltzap/pulls/955 --jq '{number,title,user:.user.login,created_at,html_url,state}'
gh api repos/chughtapan/moltzap/pulls/959 --jq '{number,title,user:.user.login,created_at,html_url,state}'
gh api repos/chughtapan/moltzap/pulls/960 --jq '{number,title,user:.user.login,created_at,html_url,state}'
gh api repos/chughtapan/moltzap/pulls/961 --jq '{number,title,user:.user.login,created_at,html_url,state}'
gh api repos/chughtapan/moltzap/pulls/972 --jq '{number,title,user:.user.login,created_at,html_url,state}'
```

13. Verified mechanical ADR integrity:

```bash
pnpm exec tsx scripts/docs/adr/check-shape.ts
```

14. Found the context-ownership contradiction:

```bash
cat docs/architecture.mdx
sed -n '1,130p' docs/integrations/openclaw.mdx
rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*.md' 'checkpoint|context markers|context projection|cross-conversation context|enrichment' README.md SKILL.md docs packages/client/AGENTS.md packages/openclaw-channel/AGENTS.md packages/nanoclaw-channel/AGENTS.md
git diff --no-ext-diff --unified=30 origin/main...HEAD -- docs/integrations/openclaw.mdx
git diff --no-ext-diff --unified=30 origin/main...HEAD -- docs/architecture.mdx
```

15. Audited the unresolved local-security behavior:

```bash
sed -n '1,280p' packages/client/src/harness-mcp-server.ts
rg -n 'Origin|origin|authorization|token|loopback|127\.0\.0\.1|localhost' packages/client/src/harness-mcp-server.ts packages/client/src/harness-mcp-wire.ts packages/client/src/moltzapd.ts
rg -n 'local processes|trusted-local|hostile|Origin|loopback|packages/\*|production' docs/decisions/*.md
```

16. Ran repository setup and froze the final unchanged identity:

```bash
pnpm check:agent-setup
date -u +%Y-%m-%dT%H:%M:%SZ
git status --short --branch
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'
git diff --exit-code
```

## Author interventions

None.

## Blockers

| ID | Finding | Required reconciliation |
|---|---|---|
| B1 | Production loopback trust/authentication behavior has no current main-owned normative contract. | State the production trust boundary, Host/Origin requirements, and token policy—or explicitly defer them—in a main-owned current outcome with provenance. |
| B2 | Candidate-authored architecture/OpenClaw docs assign HarnessClient-owned context projection and checkpoints to `moltzapd`. | Align both docs with the accepted HarnessClient ownership contract. |
| B3 | `packages/client/src/README.md` and profile helpers/tests still describe the retired CLI/local-RPC surface. | Remove or clearly re-scope the stale source documentation and dead CLI-only helpers. |
| B4 | Profile ADR says no release note while `CHANGELOG.md` contains one. | Reconcile the compatibility wording with the actual candidate artifact. |

## Overall result

**FAIL**

The three core outcomes, branch ownership, implementation obligations, and source gaps are independently discoverable, and mechanical ADR/link checks pass. Landing is blocked because a security-sensitive production choice remains non-normative and candidate-authored documentation contradicts the accepted ownership and retired-surface decisions.

## Maintainer acceptance

| Field | Value |
|---|---|
| Maintainer | Not supplied |
| Reviewed result | `pr974-formal-blind-20260811T213256Z` |
| Candidate identity matches | Yes |
| Gate decision | **REJECTED** |
| Decision time | Not supplied |
| Rationale | The blind review result is FAIL. Semantic reconciliation and a fresh rerun are required before acceptance. |

## Rerun requirement

A rerun is required after semantic reconciliation of the blockers above. The rerun must use a fresh isolated reviewer against the newly frozen candidate.

| Field | Value |
|---|---|
| Rerun required | Yes |
| Rerun review run ID | Not assigned |
| Rerun candidate commit | Not assigned |
| Rerun candidate tree | Not assigned |
| Reason | Semantic reconciliation is required after this failed review. |
