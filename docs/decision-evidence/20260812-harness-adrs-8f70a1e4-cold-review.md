# PR #974 seventh blind review

## Exact fixed prompt

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

## Verbatim review output

# Blind review record

## Review identity

- Reviewer: fresh isolated Codex agent `/root/pr974_seventh_blind_review`
- Candidate root: `/home/tapanc/moltzap-pr-974-altitude`
- Branch: `agent/pr-974-altitude`
- Commit: `8f70a1e47558e95dbfe957e563a59099b81afe28`
- Tree: `2297c39b33663521167b68fb38927df195a0ef2b`
- Started: `2026-08-12T00:30:56Z`
- Finished: `2026-08-12T00:36:11Z`
- Duration: 5m 15s
- Worktree: clean at start and finish
- Author interventions: none

## Isolation attestation

I attest that:

- I did not author or reconcile the candidate.
- I received only the candidate root and the fixed six questions, without a design summary, diff tour, decision pointer, search term, expected answer, prior review output, memory, or private state.
- I navigated the repository and history independently.
- I did not ask the author questions.
- I did not modify any file.
- Directory and diff-stat listings exposed names of quarantined records, including `20260805-harness-adrs-d4b22b4d-cold-review.md`. I did not open, read, or search any cold-review or invalid-review record, and no command returned an answer or verdict from one.

## 1. Current decision and authority

**Verdict: PASS**

The candidate makes three linked production decisions current:

1. A profile slot is `{agentName, mcpPort, agentId?, apiKey?}`. Name and port exist before registration; identity and credential are committed together.
2. `HarnessClient` is the sole production adapter-facing capability. It owns presentation reconstruction, local checkpoints, and replies bound to live turns.
3. One loopback listener serves one fixed `/mcp` path. Its catalog changes from `{register, status}` before identity commit to the six active tools afterward. The CLI, Unix socket, bespoke local RPC, and generic adapter send are retired.

Together they resolve the inability to derive a daemon endpoint from a profile, competing adapter/network ownership paths, and a registration route that was unreachable before identity existed.

The binding material is the `accepted` frontmatter and each ADR’s `Decision Outcome`, including `Restart guarantee` and `Compatibility`. Per `docs/decisions/README.md → Canonical reading guidance`, Context, Considered Options, Consequences, changelogs, implementation examples, and trajectories are historical or non-normative explanation.

Supporting paths:

- `docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md`
- `docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md`
- `docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md`
- `docs/decisions/README.md → Canonical reading guidance`
- `docs/decision-evidence/20260805-production-harness-cutover-trajectory.md`

## 2. Earlier outcomes, retention, and normative owner

**Verdict: PASS**

The records replace production mechanics rather than formally superseding the clean-slate ADR lineage:

- Replaced in `packages/*`:
  - the old three-field profile;
  - caller-supplied daemon ports;
  - adapters constructing `MoltZapService`, `MoltZapChannelCore`, and transports;
  - separate CLI/socket/RPC and `/register/mcp` production surfaces;
  - generic adapter send.
- Retained:
  - fixed loopback host/path and stable nonzero port;
  - no port discovery, port zero, or bind fallback;
  - trusted-local Gate 1 boundary with Host and Origin validation and no local token;
  - Registry ownership of registration;
  - closed canonical network `Conversation` without participants;
  - daemon-owned service/core internals;
  - `MoltZapService` and raw client capabilities for non-adapter SDK consumers.
- Left untouched:
  - the clean-slate v2 two-path contract and v2 package/SharedCore/Ledger mechanics;
  - the production network wire;
  - Registry, Router, and server protocol authority;
  - v2 publication and cutover policy.

For production `packages/*`, the current normative contract is the three accepted 2026-08-05 ADR outcomes on `main`. Package instructions and source implement them.

For `v2/*`, authority remains on the `v2` branch. `origin/v2` independently contains:

- `20260801-harness-is-one-profile-slot-daemon.md`
- `20260801-harness-client-owns-runtime-context.md`
- `20260801-inbound-notifications-separate-content-from-grants.md`
- normative `docs/spec/harness/*` and `docs/spec/management.md`

Supporting paths/headings:

- `AGENTS.md → Project`, `Docs`
- `v2/VISION.md → Authority`
- `docs/decisions/20260729-v2-authority-lives-with-v2.md → Binding outcome`
- `docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md → Decision Outcome`
- `packages/client/AGENTS.md`
- `packages/openclaw-channel/AGENTS.md`
- `packages/nanoclaw-channel/AGENTS.md`

## 3. Implementation obligations and assumptions

**Verdict: PASS**

An implementer must:

- Persist strict slot records with required `agentName`/`mcpPort` and an all-or-neither identity pair.
- Reject unknown/malformed fields, port zero, fallback allocation, and missing versus unregistered slots as distinct cases.
- Bind only `127.0.0.1:<mcpPort>/mcp`, validate localhost Host and Origin, and switch catalogs without rebinding.
- Notify open subscribers when the catalog changes.
- Keep credentials on disk and out of registration results.
- Route adapters exclusively through `HarnessClient`; adapters must not acquire or close transports or use daemon internals.
- Keep participant projection local to daemon-to-client MCP and off the network wire.
- Persist per-profile, per-conversation presentation checkpoints before emitting the corresponding turn.
- Never recreate reply authority from history; bind replies only to live inbound turns.
- Remove the CLI/socket/RPC/generic-send paths and publish only `moltzapd`.

Affected surfaces are the production local endpoint/harness boundary and its OpenClaw, NanoClaw, and simulator consumers. Registry remains registration authority; the production WebSocket wire and canonical protocol representations remain unchanged.

Assumptions and failure envelope:

- Same-host processes are trusted. Host/Origin checks do not provide hostile-same-host isolation; no local token or local TLS is claimed.
- Registration is non-idempotent. A lost result requires a new agent name; no operation identifier or crash-recovery guarantee exists.
- Presentation is at most once only while checkpoints survive.
- Checkpoint loss re-presents context.
- Advancing a checkpoint before runtime receipt creates an accepted loss window.
- History reconstructs context but never reply authority.
- A second client acquisition for an already-owned slot fails at bind; there is no attach-to-existing path.
- Port reuse fails startup rather than silently misrouting.
- Existing three-field configurations fail strict decode. There is no shim or automatic migration; release notes explain rewriting.
- Repeated proactive messages start new conversations rather than reusing one.

Implementation evidence:

- `packages/client/src/profile.ts`
- `packages/client/src/moltzapd.ts`
- `packages/client/src/moltzapd-catalog.ts`
- `packages/client/src/moltzapd-registration.ts`
- `packages/client/src/harness-mcp-server.ts`
- `packages/client/src/harness-mcp-wire.ts`
- `packages/client/src/harness-mcp-subscription.ts`
- `packages/client/src/harness-client.ts`
- `packages/client/src/harness-context-projection.ts`
- `packages/client/src/moltzapd-child.ts`
- `scripts/architecture/check-boundaries.js → adapter containment`
- `CHANGELOG.md → Breaking profile and daemon/harness entries`

## 4. Decision-makers, source events, and source gaps

**Verdict: PASS**

All three ADRs name **Tapan Chugh** as decision-maker. The trajectory distinguishes stored roles from authenticated personal identity and marks repository bodies authored by agents under the maintainer account.

Material retained events include:

- Profile:
  - Agent message `3fdf75a2…` raised configuration breakage and proactive-conversation reuse.
  - User message `846eb3e5…` states required `mcpPort` is not a concern because pre-launch and proactive reuse can be handled later.
  - PRs #954 and #955 are separate mechanical events.
- Harness:
  - User message `39159e1d…`: “why are we keeping the legacy stuff?”
  - Codex user turn at `2026-08-04T07:51:13Z` selects participants on the local MCP projection but not the main wire.
  - Agent message `836728c5…` distinguishes management operations and asks about status/docker suites.
  - User message `5a444536…` keeps status and asks to simplify docker suites.
  - User message `6ca4d0c9…` says reviews should be checked in and ADR wins on confusion.
  - PRs #959, #960, and #972 and issue comment `5185240471` are mechanical/agent-authored repository events.
- Daemon:
  - User messages `0ed9a11f…` and `4b93bb9e…` state one MCP server, not two.
  - Codex turns first propose a separate registration path, then reverse to one server and state the daemon can handle both.
  - Agent message `6dcea6f6…` presents two-path, state-gated one-path, and CLI-defer options.
  - User message `8fd049fd…` confirms correction.
  - User message `5a444536…` keeps status.
  - PR #961 is the mechanical implementation event.
- Retained Gate 1 trust provenance:
  - A user reverses stdio toward a persistent HTTP MCP daemon.
  - A user explicitly defers local process security and assumes trusted processes.
  - A user selects one active adapter per daemon.

GitHub locators for comments `5198672021`, `5185240471`, and PRs #954, #955, #959, #960, #961, and #972 resolved with matching authors, timestamps, and titles.

Explicit source gaps:

1. The two local sessions are not independently resolvable; the durable transcription is agent-authored, and the later local attestation is the literal terse reply `hes`.
2. The recovered one-versus-two-server turns remain machine-local; defects in the earlier quotation and external defect table are recorded.
3. No retained event states a reason for any call.
4. Restart and reply-authority guarantees have no main-side human source; production adopts them from the clean-slate record.
5. No direct human event selects the complete “sole production HarnessClient capability” statement.
6. No retained event discusses checkpoint durability properties.

Supporting headings:

- `20260805-production-harness-cutover-trajectory.md → The profile slot is the unit of local identity`
- `… → HarnessClient is the production adapter contract`
- `… → The daemon serves one loopback MCP path`
- `… → Source gaps`
- `20260728-gate-1-engineering-review-trajectory.md → The endpoint daemon exposes modern MCP over loopback HTTP`

## 5. Strongest apparent contradiction

**Verdict: PASS**

The strongest apparent contradiction is that:

- `docs/spec/cli.md` calls itself “Gate 1 normative,” retains a CLI, and says registration is not exposed through MCP.
- `docs/spec/endpoints/daemon.md` describes the clean-slate daemon and an exact model-output tool set.
- `v2/VISION.md` retains a CLI/control-plane constitution.
- The production ADRs delete the CLI, use one state-gated `/mcp`, and expose management tools.

This is resolved by scope and authority:

1. `AGENTS.md` separates production v1 on `main` from clean-slate v2 on `v2`.
2. `20260729-v2-authority-lives-with-v2.md` makes the v2 branch authoritative for `v2/*`.
3. Both main-resident spec chapters begin with explicit scope notes saying they describe clean-slate `v2/*`, not `packages/*`, and that v2 has already deleted those copies.
4. The 2026-08-05 ADRs explicitly govern production `packages/*`.
5. `origin/v2` confirms its current separate `/register/mcp` clean-slate outcome.
6. The older “exactly start_conversation and reply” statement is the model-output subset; status/search/history are management operations, while production adapters expose only start, turns, and bound replies.

This is not a blocker.

## 6. Implementability and unresolved choices

**Verdict: PASS**

A teammate can implement the production decision without chat or inventing a binding choice. The ADRs, package instructions, architecture checks, public docs, source, and tests identify the complete production behavior.

Deliberate deferrals or explicit non-guarantees:

- Checkpoint file format, fsync policy, cache algorithm, sharding, quota, and corruption recovery.
- Hostile-same-host defense, a local authorization token, dynamic port discovery, attach-to-existing ownership, and a universal daemon supervisor.
- Proactive conversation reuse.
- Registration idempotency and crash recovery.
- Runtime acknowledgment/replay for the checkpoint-to-delivery loss window.
- Exact cross-track compile-time compatibility until v2 assigns its complete signatures and errors.

Accidental evidence gaps, but not implementation gaps:

- No direct human selection event for the complete sole-capability outcome.
- No main-side human source for restart/reply-authority guarantees.
- No recorded human rationale.
- Local source sessions are not independently verifiable.

No accidental gap requiring an implementer to choose wire shape, ownership, trust, compatibility, recovery, or adapter behavior was found.

## Discovery trail

1. Read `/home/tapanc/.codex/skills/nx-workspace/SKILL.md`.
2. Ran `date -u`, `git rev-parse --show-toplevel`, `git rev-parse HEAD`, `git branch --show-current`, `git status --short --branch`, and `git log -1`.
3. Listed the repository, `docs/decisions`, and `docs/decision-evidence`; inspected `git log --oneline --decorate -20` and `git diff --stat origin/main...HEAD`.
4. Read `docs/decisions/README.md` and the three 2026-08-05 ADRs.
5. Read the complete non-quarantined production harness trajectory.
6. Read the Gate 1 daemon ADR, its trust provenance heading, `docs/spec/cli.md`, and `docs/spec/endpoints/daemon.md`.
7. Read `20260729-v2-authority-lives-with-v2.md` and related simulator/gateway lineage.
8. Searched current docs and production packages for CLI, socket, profile, MCP-path, generic-send, adapter, and `HarnessClient` references while excluding all decision-evidence review artifacts.
9. Read `docs/architecture.mdx`, package `AGENTS.md` files, README, SKILL, quickstart, profiles, and OpenClaw documentation.
10. Read the profile, daemon, catalog, registration, MCP handler, subscription, client, checkpoint, child-process, and architecture-boundary implementations.
11. Read candidate `AGENTS.md`, `v2/AGENTS.md`, `v2/VISION.md`, evidence guidance, and the ADR-process decision.
12. After independently discovering the requirement, read `.claude/skills/decisions/SKILL.md`, fixed questions, and the cold-review template.
13. Verified durable GitHub issue-comment and PR locators through `gh api`.
14. Inspected exact safe ADRs on `origin/v2`.
15. Failed path: `packages/client/src/harness/turn-projection.ts` did not exist; the relevant implementation was in `harness-context-projection.ts`, `harness/runtime.ts`, and tests.
16. Failed path: `origin/v2:docs/decisions/20260801-daemon-separates-registration-from-active-tools.md` did not exist; repository search found `20260801-harness-is-one-profile-slot-daemon.md`.
17. Re-read candidate commit/tree and confirmed the worktree remained clean.

## Blockers

None.

## Overall result

**PASS**

All six answers were independently discoverable. Status, production/v2 scope, lineage, assumptions, implementation ownership, compatibility break, and source-event attribution are consistent. The trajectory candidly records its provenance gaps, and no unresolved contradiction or implementation-defining accidental gap remains.

## Maintainer acceptance

Status: **PENDING**
