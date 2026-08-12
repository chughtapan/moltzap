# PR #974 sixth isolated blind review

Maintainer acceptance: **PENDING**

## Fixed prompt (verbatim)

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

## Review output (verbatim)

Reviewer identity: Codex, fresh isolated reviewer `/root/pr974_sixth_blind_review`.

Isolation attestation: I received only the candidate repository root and six fixed questions. I had no inherited design summary, diff tour, file pointer, expected result, prior review output, or author intervention. I did not open or search any `*-cold-review.md` or `*-invalid-review.md` content. Their paths appeared only in permitted listings/diff name output.

Candidate identity:

- Repository: `/home/tapanc/moltzap-pr-974-altitude`
- Branch: `agent/pr-974-altitude`
- HEAD: `8b649c42a2355cae22b864262aeb315052fbc8fa`
- Parent: `8c6b6644f01adad20014143d67ee271e4786184a`
- Subject: `docs(decisions): quarantine prior blind verdicts`
- Merge base with `origin/main`: `ff0da6dcec2f9c4c5e07bbda0cfbb1862c909da3`
- Worktree remained clean, branch ahead of `origin/pr/974` by 14 commits.
- Start: `2026-08-12T00:15:20Z`
- End: `2026-08-12T00:21:42Z`
- Duration: 382 seconds / 6 minutes 22 seconds
- Edits: none
- Author interventions: none

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

Verdict: PASS.

The candidate makes three production decisions current for `packages/*`:

1. A profile slot is the unit of local identity. It is `{agentName, mcpPort, agentId?, apiKey?}`; name and port exist before registration, and identity/key appear together at Registry commit. The operator supplies the stable nonzero port. Strict decoding intentionally breaks the prior three-field configuration without a shim or automated migration. Filesystem presentation checkpoints are scoped by profile name.

2. `HarnessClient` is the sole production adapter-facing capability. It owns context projection, local checkpoints, conversation start, the single turn stream, and live-turn-bound replies. Search, history, registration, and status remain daemon MCP management operations. Conversation membership may be projected across the local MCP boundary but is not added to the network wire. Restart presentation is at most once in normal operation, with the documented advance-before-delivery loss window and no reconstruction of reply authority from history.

3. `moltzapd` serves one loopback listener at fixed `/mcp`; the catalog changes with slot state. An unregistered slot exposes exactly `register` and `status`; an active slot exposes the six active tools and no `register`. The CLI, Unix socket, bespoke daemon RPC dialect, and generic adapter send are retired. The client package ships only `moltzapd`.

Problems resolved:

- The old profile lacked a daemon endpoint and persistent checkpoint scope.
- Adapters directly constructed services/transports, leaving competing production routes and no admitted main-side contract.
- Registration was unreachable through MCP before identity creation, while the system retained duplicate CLI/socket and two-path MCP surfaces.

Only the three `Decision Outcome` sections—including `Restart guarantee`, `Accepted loss`, and `Compatibility` subsections—are binding. Context, considered options, consequences, changelog explanations, source-event trajectories, issue bodies, and implementation history are explanatory or non-normative.

Supporting paths/headings:

- `docs/decisions/20260805-profile-slot-is-the-unit-of-local-identity.md` → `Decision Outcome`, `Compatibility`
- `docs/decisions/20260805-harness-client-is-the-production-adapter-contract.md` → `Decision Outcome`, `Restart guarantee`, `Accepted loss`
- `docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md` → `Decision Outcome`
- `docs/decisions/README.md` → `Canonical reading guidance`

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

Verdict: PASS.

For production, it replaces:

- The three-field profile `{agentId, apiKey, agentName}` and caller-supplied daemon ports.
- Direct adapter ownership of `MoltZapService`, `MoltZapChannelCore`, transport discovery, and lifecycle.
- The production CLI/Unix-socket/local-RPC route.
- Production `/register/mcp` plus `/mcp` routing.
- Generic adapter send and proactive reuse of existing conversations.

It retains:

- Fixed `127.0.0.1:<mcpPort>/mcp`, nonzero stable operator-selected ports, no port-zero allocation or bind fallback.
- The trusted-local-process boundary, Origin/Host validation, and absence of a local authorization token.
- Management operations on MCP rather than `HarnessClient`.
- Network-wire closure: local membership projection does not change canonical network `Conversation`.
- Backing-specific production reply authority and combined inbound turns.
- The production WebSocket protocol and server/router behavior.

It leaves untouched:

- The clean-slate v2 two-path daemon contract on `origin/v2`.
- V2 content/grant separation, TxnId/action authority, Registry bootstrap, Ledger, and recovery mechanics.
- Direct client/app SDK surfaces such as `MoltZapService`; “sole capability” is scoped to runtime adapters.
- Lower-layer production RPC and network representations.

None of the three records formally supersedes the v2 records because their scopes differ. The production contract lives in the three accepted 2026-08-05 ADR outcomes on `main`; the v2 contract remains branch-local on `v2`. The main-resident `docs/spec/cli.md` and `docs/spec/endpoints/daemon.md` explicitly state that they describe v2 and do not govern `packages/*`.

Supporting paths/headings:

- `docs/decisions/20260729-v2-authority-lives-with-v2.md` → `Binding outcome`
- The three 2026-08-05 ADRs → `Context and Problem Statement`, `Decision Outcome`
- `docs/spec/cli.md` → `Scope`
- `docs/spec/endpoints/daemon.md` → `Scope`
- `origin/v2:docs/decisions/20260801-harness-is-one-profile-slot-daemon.md` → `Decision Outcome`
- `origin/v2:docs/decisions/20260801-harness-client-owns-runtime-context.md` → `Decision Outcome`
- `origin/v2:docs/decisions/20260801-inbound-notifications-separate-content-from-grants.md` → `Decision Outcome`

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

Verdict: PASS.

An implementer must:

- Persist strict profile slots with required `agentName`/`mcpPort` and all-or-neither `agentId`/`apiKey`.
- Bind only the persisted nonzero port on `127.0.0.1`; never allocate, scan, hash, increment, bind port zero, or fall back.
- Bind the MCP listener before identity activation and serve only fixed `/mcp`.
- Switch from `{register,status}` to the six active tools after commit and notify subscribed clients of the catalog change.
- Keep API key material on disk and out of the registration result.
- Route OpenClaw and NanoClaw solely through `HarnessClient`; adapters must not import or construct daemon machinery.
- Keep search/history internal to context reconstruction and keep reply authority bound to the live inbound turn.
- Store presentation checkpoints below the MoltZap config directory under the profile name.
- Ensure the server’s message ordering makes checkpoint advancement safe across rollback/restart/concurrent server processes.
- Ship only the `moltzapd` client binary and remove CLI/socket/generic-send paths.

An implementer must avoid:

- Adding membership to the production network wire.
- Exposing management search/history/status/registration as `HarnessClient` methods.
- Creating a second transport, backing discriminator, generation selector, reply token, transaction handle, or historical reply authority.
- Claiming registration idempotence, crash recovery, acknowledgment, replay, hostile-host isolation, or migration compatibility.

Affected consumers and layers:

- `packages/client`
- `packages/openclaw-channel`
- `packages/nanoclaw-channel`
- Simulator adapter composition/tests
- Operators maintaining profile files
- The daemon/runtime loopback MCP boundary

The production network wire is otherwise unaffected; v2 contracts are unaffected.

Assumptions and limits:

- Local processes are trusted; same-host hostile-process defense is explicitly absent.
- Host and Origin validation protect only the HTTP boundary.
- Any process reaching the user’s loopback listener can invoke its tools.
- Registration response loss is unrecoverable for that agent name.
- Presentation is at most once only while checkpoints survive. Lost/corrupt checkpoints cause re-presentation.
- A crash after checkpoint advance but before runtime delivery loses that context; there is no acknowledgment or replay.
- History never recreates reply authority.
- A duplicate slot port fails binding.
- Two independently acquired clients for one slot conflict by construction.
- Existing three-field configs fail strict decode; pre-launch compatibility is intentionally broken without automated migration.

Supporting paths/symbols:

- `packages/client/src/profile.ts` → `profileRecordSchema`, `writeProfile`
- `packages/client/src/moltzapd.ts` → `serveProfileSlot`, `acquireMoltzapd`
- `packages/client/src/moltzapd-catalog.ts` → `makeDaemonPhaseState`, `makeActiveTools`
- `packages/client/src/harness-mcp-wire.ts` → `makeSlotServer`, `makeActiveServer`
- `packages/client/src/harness-mcp-server.ts` → `makeHarnessMcpRequestListener`
- `packages/client/src/moltzapd-child.ts` → `harnessClientForProfile`
- `packages/client/src/harness-client.ts` → `HarnessClientService`, `acquireHarnessClient`
- `packages/client/src/harness-context-projection.ts` → `reconstructHarnessContext`
- `scripts/architecture/check-boundaries.js` → `adapter containment`
- `packages/server/src/message/message.service.ts`
- `packages/server/src/message/ordered-insert.test.ts`

## 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

Verdict: FAIL.

All three ADRs name Tapan Chugh as decision-maker. The trajectory explicitly warns that stored roles/accounts do not authenticate a person.

Cited profile-slot events:

- Agent message `3fdf75a2-5707-40e7-8403-e95dee71ac83`, with parent and timestamp, raises required-port compatibility and proactive-DM behavior.
- User message `846eb3e5-3a93-4b6e-b33c-213102377717` says required `mcpPort` is not a concern because pre-launch and proactive DMs can be handled later.
- PRs #954 and #955 are separate mechanical events.

Cited HarnessClient events:

- User message `39159e1d-a69f-466b-82a3-028d01816ee8`: “why are we keeping the legacy stuff?”
- Agent message `836728c5-1a19-41e2-bbd2-51145b0ab17c` describes management-method separation and open status/docker questions.
- User message `5a444536-1723-4d8b-8633-9b0af7c78166` retains status as a tool.
- User message `6ca4d0c9-07b1-446d-80e6-11aebd3c3c7e` says reviews should be checked in and ADR wins on confusion.
- PRs #959, #960, and #972 are mechanical events.
- Issue comment `5185240471` is agent-authored classification evidence.

Cited daemon events:

- User question `97d842db-f24b-4912-8b82-3b829ce509d5`.
- Agent description `657c5378-0317-4399-b01d-9dce2c410bf4`.
- User messages `0ed9a11f-...` and `4b93bb9e-...` state one server and that two MCPs were not accepted.
- Codex-session turns at `2026-07-31T21:57:09Z`, `23:54:09Z`, and `23:54:40Z` record the separate-path proposal, reversal to one server, and “daemon can handle both”.
- Agent options message `6dcea6f6-a3c2-4522-af24-224ef1c6760f`.
- User reply `8fd049fd-2f65-4f29-bde8-76e2a4700643` accepts the correction.
- User reply `5a444536-...` retains status.
- PR #961 is a mechanical event.
- The retained Gate 1 trajectory cites the HTTP-MCP reversal, user trust deferral “assume trusted”, and the one-active-adapter exchange.

Explicit source gaps:

1. Session transcripts remain local-only; the durable transcription is agent-authored. The later stored reply is literally `hes`, conditionally read as affirmation.
2. Three earlier quotation defects are recorded; first-hand Codex events supersede them.
3. No retained user event states a reason for any call.
4. Restart and reply-authority guarantees have no main-side human source and are adopted from a clean-slate record.
5. Checkpoint durability properties are undecided and were not deferred by a cited human event.

Failure reason: the compacted trajectory does not retain the direct membership-projection user event in the HarnessClient section. The durable [issue comment `5198672021`](https://github.com/chughtapan/moltzap/issues/926#issuecomment-5198672021) contains the `2026-08-04T07:51:13Z` directive, “we can include participants in conversation passed by mcp to harness client but not on the main wire,” but the checked-in ledger only says the membership material was omitted from agent message `836728c5`. The ADR makes membership projection binding, so the relevant direct source event should be retained and attributed in that section.

The same section also has no explicit human selection event for “HarnessClient is the sole production adapter-facing capability”; it retains a question, agent analysis, mechanical PRs, and an adopted v2 record. Its source-gap list acknowledges only the restart/reply guarantees, not this broader adoption gap.

Supporting paths/headings:

- `docs/decision-evidence/20260805-production-harness-cutover-trajectory.md` → all three ADR headings, `Source gaps`
- `docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md` → `The endpoint daemon exposes modern MCP over loopback HTTP`
- [Issue #926, comment 5198672021](https://github.com/chughtapan/moltzap/issues/926#issuecomment-5198672021)
- [Issue #926, comment 5185240471](https://github.com/chughtapan/moltzap/issues/926#issuecomment-5185240471)

All cited PR number/title/timestamp locators #954, #955, #959, #960, #961, and #972 resolved correctly.

## 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

Verdict: FAIL.

The strongest contradiction is in `CHANGELOG.md` → `Unreleased` → `Removed: the moltzap CLI and its Unix socket`.

It says:

> Everything the CLI did is an MCP tool on the daemon's one fixed `/mcp` path

The same section and the authoritative daemon ADR say generic send is removed. The deleted CLI did have `moltzap send conv:<id> ...`, verified from the merge-base version of `packages/client/src/cli/commands/send.ts`. The active catalog has no generic send tool.

Authority resolves the implementation direction: the accepted daemon ADR wins, so generic send remains retired. But the release note is materially false and directly contradicts the same candidate’s published operator guidance. It should say that all retained operator workflows moved to MCP while generic send was intentionally removed.

A second stale instruction appears at `docs/architecture.mdx` → `Server core`: it tells readers to consume server-core through the `moltzap` bin. The package manifest and `packages/server/AGENTS.md` name the binary `moltzap-server`; the client-side `moltzap` CLI is retired. This is lower-authority orientation prose, but it remains an incorrect current instruction.

The apparent v2 CLI/two-path contradictions are successfully resolved by explicit scope notes and branch-local authority. They are not blockers.

Supporting paths/headings:

- `CHANGELOG.md` → `Removed: the moltzap CLI and its Unix socket`
- `docs/decisions/20260805-daemon-serves-one-loopback-mcp-path.md` → `Decision Outcome`
- Merge-base `packages/client/src/cli/commands/send.ts` → `sendCommand`
- `packages/client/src/moltzapd-catalog.ts` → `makeActiveTools`
- `docs/architecture.mdx` → `Server core`
- `packages/server/package.json` → `bin`
- `packages/server/AGENTS.md` → package boundary

## 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

Verdict: PASS for implementation sufficiency, but the candidate remains blocked from landing by Questions 4 and 5.

The binding implementation contract is sufficiently concrete: profile shape, port provenance, catalog states, tool ownership, adapter boundary, checkpoint behavior, local trust, failure window, and compatibility are all discoverable without chat.

Deliberate deferrals or explicit limitations:

- Checkpoint file format
- Fsync policy
- Cache algorithm
- Sharding
- Quota
- Corruption recovery
- Hostile same-host defense
- Future local authorization token
- Registration operation IDs/idempotency/crash recovery
- Presentation acknowledgment/replay
- Proactive one-to-one conversation reuse
- Compatibility shim/automated profile migration
- Recovery of lost or corrupted checkpoint stores

Accidental gaps:

- The direct membership-projection source event is not retained in its trajectory section.
- The trajectory does not explicitly record the absence of a human selection event for the complete sole-production-`HarnessClient` adoption.
- `CHANGELOG.md` falsely claims every former CLI operation has an MCP replacement despite generic send being retired.
- `docs/architecture.mdx` names the nonexistent/retired `moltzap` server binary instead of `moltzap-server`.

These do not require invention of a code mechanism because authority resolves the intended implementation, but they do violate the candidate’s provenance and documentation consistency requirements.

## Blockers

1. Add the durable membership-projection event to the HarnessClient trajectory section with its session locator, timestamp, role, and literal excerpt; explicitly account for the source status of the sole-capability adoption.
2. Correct the changelog’s “Everything the CLI did” claim to acknowledge removal of generic send.
3. Correct `docs/architecture.mdx` from `moltzap` to `moltzap-server`.
4. Freeze a new semantic candidate and run the gate with another fresh reviewer.

Overall result: FAIL.

## Discovery trail

Chronological commands and paths used:

```text
date -u +'%Y-%m-%dT%H:%M:%SZ'
pwd
git status --short --branch
git rev-parse HEAD
git show -s --format='%H%n%P%n%an%n%aI%n%s' HEAD
git branch --show-current
git remote -v

git log --oneline --decorate --no-renames origin/pr/974..HEAD
git diff --name-status --no-renames origin/pr/974...HEAD
git log --oneline --decorate -20

git merge-base origin/main HEAD
git log --oneline --decorate --first-parent $(git merge-base origin/main HEAD)..HEAD
git diff --name-status --no-renames $(git merge-base origin/main HEAD)..HEAD
git ls-tree -r --name-only HEAD docs/decision-evidence docs/decisions

sed -n ... three 20260805 ADRs
sed -n ... docs/decisions/README.md
sed -n ... docs/decision-evidence/20260805-production-harness-cutover-trajectory.md

sed -n ... docs/decisions/20260729-v2-authority-lives-with-v2.md
sed -n ... docs/decisions/20260728-endpoint-daemon-speaks-modern-mcp.md
sed -n ... docs/spec/cli.md
sed -n ... docs/spec/endpoints/daemon.md
sed -n ... AGENTS.md
find . -path './.git' -prune -o -name AGENTS.md -print

sed -n ... .claude/skills/decisions/SKILL.md
sed -n ... .claude/skills/decisions/references/provenance.md
sed -n ... .claude/skills/cold-read/references/questions.md

rg ... /register/mcp, CLI/socket, MoltZapService, MoltZapChannelCore,
       HarnessClient, mcpPort, checkpoints
sed -n ... CHANGELOG.md, README.md, docs/quickstart.mdx,
           docs/concepts/profiles.mdx, docs/architecture.mdx,
           package AGENTS.md files
sed -n ... guides, integrations, simulator docs
node -e ... packages/client/package.json and packages/server/package.json

rg ... adapter imports
sed -n ... scripts/architecture/check-boundaries.js
sed -n ... safer-architecture configs and client barrels

sed/rg ... profile.ts, moltzapd.ts, moltzapd-catalog.ts,
           moltzapd-registration.ts, moltzapd-child.ts,
           harness-client.ts, harness-context-projection.ts,
           harness-mcp-wire.ts, harness-mcp-server.ts, harness/runtime.ts

rg/sed ... docs/decision-evidence/20260728-gate-1-engineering-review-trajectory.md
git diff ... origin/pr/974..HEAD on ADRs and trajectory
git log -p --follow ... daemon ADR

web open/find ... GitHub issue #926
gh api ... issue comments 5198672021 and 5185240471
gh api ... PRs 954, 955, 959, 960, 961, 972

git ls-tree/show origin/v2 ... three 20260801 harness ADRs
git show $(git merge-base origin/main HEAD):packages/client/src/cli/commands/send.ts
git show $(git merge-base origin/main HEAD):packages/client/src/cli/index.ts

date -u
git rev-parse HEAD
git status --short --branch
```

Independently used headings:

- `Decision Outcome`, `Restart guarantee`, `Accepted loss`, `Compatibility`
- `Canonical reading guidance`
- All three production trajectory ADR headings and `Source gaps`
- `Binding outcome`
- `The endpoint daemon exposes modern MCP over loopback HTTP`
- `Scope` in both retained v2 specification copies
- `Removed: the moltzap CLI and its Unix socket`
- `Server core`

No prior blind-review content was read.
