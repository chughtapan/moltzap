# PR #974 third blind-review record

## Exact reviewer prompt

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

## Completed review (verbatim)

# Blind decision review

Overall result: **FAIL**

Questions 1–4 pass. Questions 5–6 fail because checked-in package instructions and simulator documentation still describe two retired execution/adapter paths.

## Review identity

| Field | Value |
|---|---|
| Review run | `/root/pr974_third_blind_review` |
| Reviewer | Fresh Codex blind-review agent |
| Candidate root | `/home/tapanc/moltzap-pr-974-altitude` |
| Branch | `agent/pr-974-altitude` |
| Candidate commit | `d7c51ce47e00240f868def0ab5641805d268a20c` |
| Candidate tree | `c24464e5c78de5c5194b2205e6150a2b9f03d6ef` |
| Object format | Git SHA-1 |
| Parent commit | `9eae736712ec4b736df4b87c1c6e279d337b4ddb` |
| Review started | `2026-08-11T22:11:41Z` |
| Review finished | `2026-08-11T22:21:43Z` |
| Duration | 10 minutes 2 seconds |
| Budget | One uninterrupted context; under the 45-minute gate |
| Author interventions | None |
| Final worktree | Clean |

## Fresh-context attestation

- [x] I did not author or reconcile the candidate.
- [x] I received no inherited candidate conversation, summary, memory, private state, earlier blind-review output, design tour, file pointer, search term, expected answer, or answer key.
- [x] I independently navigated from the repository root and checked-in entry points.
- [x] I did not ask the author questions or receive interventions.
- [x] I did not modify the candidate.
- [x] I did not open, read, or search any `*-cold-review.md` or invalid-review artifact. A quarantined path appeared in a Git name-only diff; no content was returned.
- [x] Review summaries embedded inside an ordinary candidate trajectory were treated as permitted engineering evidence; no linked quarantined artifact was opened.
- [x] No external source or connected account was used.

## Discovery trail

Commands are grouped in execution order where they were issued together.

| Order | Navigation step | Paths/headings discovered |
|---:|---|---|
| 1 | `sed -n '1,240p'` and `sed -n '241,520p' /home/tapanc/.codex/skills/nx-workspace/SKILL.md` | Required read-only Nx navigation procedure |
| 2 | `date -u`; `git rev-parse --show-toplevel`; `git rev-parse HEAD`; `git status --short --branch`; `git log -1 --format=...` | Candidate root, commit, parent, branch and start time |
| 3 | `ls -la`; `sed -n '1,260p' AGENTS.md` | `AGENTS.md` → Decisions, Code, Verify, Docs |
| 4 | `wc -l` and `sed` on `.claude/skills/decisions/SKILL.md` | Decision-record procedure and blind gate |
| 5 | `sed` on `.claude/skills/cold-read/references/questions.md`, `.claude/skills/decisions/references/provenance.md`, and `docs/decision-evidence/cold-review-template.md` | Fixed questions, quarantine, provenance, review-record fields |
| 6 | `pnpm check:agent-setup` | Node, pnpm, Codex and gbrain available |
| 7 | `git branch --show-current`; tree/merge-base queries; `git diff --name-status origin/pr/974..HEAD`; `git diff --name-status HEAD^..HEAD` | Candidate scope and changed records |
| 8 | `git diff --name-status origin/v2...HEAD` and `origin/main...HEAD` | Three new production ADRs, changed simulator ADR, implementation/docs footprint; quarantined artifact path seen by name only |
| 9 | `sed -n '1,320p' docs/decisions/README.md` | Canonical reading guidance, status meanings, Records |
| 10 | `wc -l` and full `sed` reads of the three 2026-08-05 ADRs and the 2026-08-01 simulator ADR | Decision Outcomes, compatibility, restart/loss, trust, lineage, non-goals |
| 11 | Full read of `docs/decision-evidence/20260805-production-harness-cutover-trajectory.md` | Three production decision trajectories and Source gaps |
| 12 | Targeted `rg` and `sed` on `20260728-gate-1-engineering-review-trajectory.md` | `The endpoint daemon exposes modern MCP over loopback HTTP` |
| 13 | Read `20260728-endpoint-daemon-speaks-modern-mcp.md`, `20260729-v2-authority-lives-with-v2.md`, `v2/AGENTS.md`, and relevant `v2/VISION.md` sections | V2 scope, authority, trust/failure envelope, local runtime surface |
| 14 | Read `docs/spec/cli.md` and `docs/spec/endpoints/daemon.md` | Explicit v2-only scope notes |
| 15 | Read `packages/client/AGENTS.md`, `packages/openclaw-channel/AGENTS.md`, `packages/nanoclaw-channel/AGENTS.md` | Package entry-point instructions and adapter ownership |
| 16 | Inspect `packages/client/package.json`, `src/index.ts`, `src/channel-base/index.ts`, and adapter containment code | Actual exports and forbidden daemon-side adapter symbols |
| 17 | Read `docs/architecture.mdx`, `docs/concepts/profiles.mdx`, client README/MODULE, root `SKILL.md`, root README, OpenClaw and two-agent guides | Production orientation and release-facing contracts |
| 18 | Targeted source inspection of profile, daemon, MCP listener/catalog, registration, HarnessClient, checkpoint projection and child acquisition | Implementation alignment with the three production ADRs |
| 19 | Search/read `CHANGELOG.md` | Breaking profile rewrite instructions, CLI removal, restart semantics |
| 20 | Read supersession portions of the code-first simulator, principal-gateway and evaluation-result ADRs | Retained/replaced simulator lineage |
| 21 | Full read of `20260801-main-kubernetes-society-execution-trajectory.md` | Simulator calls, alternatives, deferrals, corrections and source gaps |
| 22 | Safe, path-restricted `git diff origin/pr/974..HEAD -- ...` | Exact candidate corrections without opening quarantine |
| 23 | Inspect and run `pnpm exec tsx scripts/docs/adr/check-shape.ts` | `PASS — 53 record(s) well-formed` |
| 24 | Inspect `scripts/architecture/check-boundaries.js` → adapter containment | Known adapters must use HarnessClient; daemon symbols forbidden |
| 25 | Search acceptance/current-runtime wording across simulator/evals | Open GKE evaluation gate and stale host/runtime descriptions |
| 26 | Read `packages/simulator/AGENTS.md`, `packages/evals/AGENTS.md`, `packages/evals/src/README.md`, `docs/simulator/overview.mdx` | Contradictory current instructions |
| 27 | Search current source for `effectRuntime`, `interceptInbound`, `RunSpec`, and `Run.execute` | No production `effectRuntime`; container path is current |
| 28 | Final UTC time, clean status, commit and tree verification | Candidate identity unchanged |

## 1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?

**Verdict: PASS**

This candidate makes a bundle of three production-harness decisions current and records one point correction to an already-current simulator decision:

1. A profile slot is `{agentName, mcpPort, agentId?, apiKey?}`. The required name and stable operator-supplied port exist before registration; identity and credential appear together at Registry commit.
2. `HarnessClient` is the sole production adapter-facing capability. It owns context reconstruction, file-backed presentation checkpoints and live-turn-bound replies.
3. Production `moltzapd` binds one loopback listener at fixed `/mcp`; its catalog changes from `{register,status}` to six active tools. The CLI, Unix socket, bespoke local RPC dialect and generic adapter send are retired.
4. The simulator’s already-accepted `RunSpec`/`Run.execute` decision now records that the transitional host entry point and in-process Effect runtime have actually been removed.

The problems resolved are the inability to derive a daemon endpoint from a profile, duplicate production adapter/network lifecycles, unreachable pre-registration MCP onboarding, two competing local control surfaces, and stale simulator transition wording.

Binding material is the accepted ADRs’ `Decision Outcome` sections, including nested compatibility, restart, accepted-loss, trust/failure and simulator subheadings. The simulator’s `Scope and authority`, explicit ownership and non-goals constrain that outcome. Context, considered options, consequences, examples and changelog receipts are explanatory or historical. Source trajectories are explicitly non-normative.

Supporting paths/headings:

- `docs/decisions/README.md` → `Canonical reading guidance`, `Records`
- `20260805-profile-slot-is-the-unit-of-local-identity.md` → `Decision Outcome`, `Compatibility`
- `20260805-harness-client-is-the-production-adapter-contract.md` → `Decision Outcome`, `Restart guarantee`, `Accepted loss`
- `20260805-daemon-serves-one-loopback-mcp-path.md` → `Decision Outcome`
- `20260801-main-simulator-runs-container-societies-on-kubernetes.md` → `Scope and authority`, `Decision Outcome`, `Record changelog`

## 2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?

**Verdict: PASS**

For production `packages/*`:

- The profile decision replaces the three-field production record and caller-supplied daemon port. It borrows fixed-port precedent from the Gate 1 endpoint record without importing its V2 SharedCore/Ledger machinery.
- The HarnessClient decision replaces adapters directly constructing `MoltZapService`, `MoltZapChannelCore` and network clients. Management operations remain daemon MCP tools, not HarnessClient methods.
- The daemon decision replaces `/register/mcp`, the CLI, Unix socket, local RPC dialect and generic adapter send. It retains the trusted-local/no-token boundary and fixed `/mcp`.
- None of these three changes supersedes the clean-slate V2 contract. The retained `docs/spec/cli.md` and `docs/spec/endpoints/daemon.md` copies explicitly say they govern `v2/*`, not production packages.

For the simulator:

- `RunSpec`/`Run.execute` and Kubernetes replace `simulator.define(...).run(...)`, host-only acquisition and `effectRuntime({build})`.
- The code-first Effect model, closed event catalog, typed ledger, exact runtime-native gateways, customer completion policy, behavioral evidence rules, evaluation reports and Phoenix publication remain current.
- V2 simulator/package/process decisions remain untouched.

The current production contract lives in these accepted ADR outcomes. The current simulator contract lives in the 2026-08-01 ADR plus the expressly retained portions of its partially superseded predecessors. The V2 normative contract lives on the V2 track under `AGENTS.md`, `v2/VISION.md`, V2-current ADRs and V2 specs.

Supporting paths/headings:

- `20260729-v2-authority-lives-with-v2.md` → `Binding outcome`
- Both scoped specs → `Scope`
- The four candidate ADRs → `Decision Outcome`
- `20260801-main-simulator...md` → `Current owners and earlier outcomes`
- `20260727-code-first-simulator-kernel.md` → `Supersession`
- `20260729-principal-io-uses-runtime-gateways.md` → `Supersession`
- `20260729-effect-native-evaluation-results.md` → `Supersession`

## 3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?

**Verdict: PASS**

An implementer must:

- Strictly decode profile slots, require a nonzero stable operator-selected `mcpPort`, require both-or-neither identity fields, derive only `http://127.0.0.1:<port>/mcp`, and fail bind collisions without discovery, scanning, port zero or fallback.
- Start `moltzapd` from `--profile` only and bind before identity exists.
- Serve exactly `register` and `status` pre-commit; after commit, serve the active six-tool catalog without `register`, on the same URL, and signal catalog change.
- Bind only loopback, validate localhost Host and Origin, add no local token, and avoid claiming hostile-same-host isolation.
- Keep key material on disk. Registration is non-idempotent; do not add retry, operation-ID or crash-recovery guarantees.
- Give adapters only HarnessClient start/turn/bound-reply behavior. Search/history remain internal reconstruction or daemon management operations.
- Advance presentation checkpoints immediately before emitting a turn. Preserved checkpoints provide normal-operation at-most-once presentation; lost checkpoints may re-present; post-advance failure may lose presentation. History must never recreate reply authority.
- Keep membership enrichment on the local endpoint boundary and off the closed network wire.
- Run simulator/evaluation societies through one container per roster entry, full-cohort readiness, one customer Effect invocation and no automatic replay. Keep exact runtime-specific gateways; do not introduce a universal bridge protocol.
- Keep Kubernetes/Kueue/Sandbox/Temporal private behind the cluster Layer. Controller/infrastructure loss fails and cleans up; external effects are not exactly once.

Affected surfaces are production profile/config storage, the local MCP runtime boundary, `@moltzap/client`, OpenClaw, NanoClaw, simulator-owned adapter use, `packages/simulator`, and `packages/evals`. The V1 WebSocket/network wire and V2 contracts are not changed.

Assumptions and failures:

- Local processes are trusted; any same-user process reaching loopback can invoke tools.
- Host/Origin checks narrow HTTP exposure but do not authenticate local callers.
- Bind conflict fails startup.
- Network/service unavailability can stop progress; these ADRs do not import the V2 Byzantine network fault model into V1.
- Registration response ambiguity has no recovery guarantee.
- Presentation safety is at-most-once only while checkpoints survive; liveness/replay is explicitly weaker.
- Simulator readiness requires the whole roster; controller or unrecoverable runtime failure ends acquisition/run cleanup.
- Existing three-field profile files fail strictly. There is no shim or automated migration; the changelog tells operators how to rewrite them.
- Production loses the CLI and Docker/host simulator backend compatibility. V2 remains compatible with its separately scoped CLI/daemon design.

Supporting paths/headings:

- Three production ADRs → `Decision Outcome`, `Compatibility`, `Restart guarantee`, `Accepted loss`, `Consequences`
- Simulator ADR → `Container runtimes preserve exact native gateways`, `One execution is one experiment society`, `Failure and evidence retain...`, `Non-goals`
- `v2/VISION.md` → `Trust and failure envelope`, `Local runtime surface`
- `packages/client/src/profile.ts` → `profileRecordSchema`
- `packages/client/src/harness-mcp-server.ts` → `makeHarnessMcpRequestListener`
- `packages/client/src/harness-client.ts` → `HarnessClientService`, `acquireHarnessClient`
- `packages/simulator/AGENTS.md` → `Laws`

## 4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.

**Verdict: PASS**

All four reviewed ADRs name **Tapan Chugh**.

Production-harness trajectory:

- Profile: assistant message `3fdf75a2-5707-40e7-8403-e95dee71ac83` presents the compatibility and proactive-DM concerns; user message `846eb3e5-3a93-4b6e-b33c-213102377717` says required `mcpPort` is not a concern pre-launch and proactive DMs can be handled later. PRs #954 and #955 are mechanical events.
- HarnessClient: user `39159e1d-a69f-466b-82a3-028d01816ee8` asks why legacy remains; assistant `836728c5-1a19-41e2-bbd2-51145b0ab17c` distinguishes settled management-operation scope from open status/docker questions; user `5a444536-1723-4d8b-8633-9b0af7c78166` retains status and asks for simplification; user `6ca4d0c9-07b1-446d-80e6-11aebd3c3c7e` says checked-in reviews and ADR precedence. PRs #959, #960 and #972 and issue #926 comment `5185240471` are agent-authored mechanical/classification events.
- Daemon: user `97d842db-f24b-4912-8b82-3b829ce509d5` asks about `/register/mcp`; assistant `657c5378-0317-4399-b01d-9dce2c410bf4` describes the two-path implementation; users `0ed9a11f-...` and `4b93bb9e-...` say one MCP server and that two were not accepted. Codex-session turns at `2026-07-31T21:57:09Z`, `23:54:09Z`, and `23:54:40Z` record the separate-path proposal, reversal to one server, and “daemon can handle both.” Assistant `6dcea6f6-...` presents three options; user `8fd049fd-...` accepts the correction. The repeated `5a444536-...` event retains status. PR #961 is mechanical.
- Local trust: Gate 1 turn `019fa6f1-23f2-7ee3-a905-2689082dd942` states local-process security is deferred and local processes assumed trusted. The associated assistant event records loopback MCP. The trajectory separately records the one-adapter-per-daemon exchange.
- Source attestation: assistant `14af5fc6-...` asks the maintainer to confirm the twelve blocks; user `434933a2-...` replies literally `hes`. The ledger records its affirmative reading and warns that a misread prompt invalidates it.

Production source gaps explicitly recorded:

- Original Claude/Codex sessions remain local-only.
- Issue #926 comment `5198672021` is agent-authored under the maintainer account; that account does not independently authenticate the person.
- The `hes` attestation is not normalized and is not independently verifiable.
- The earlier one/two-path quotation contained three recorded defects.
- No retained event states a reason for any call.
- Restart and reply-authority guarantees have no main-side human source; the production ADR adopts clean-slate text.
- Checkpoint durability properties are undecided and have no retained human event.
- Registration non-idempotence is recorded as an existing property, not a human choice.

Simulator trajectory:

- Main/core/target events: `msg_019fbbe1-...`, `msg_019fbdeb-...`, `msg_019fbded-...`, `msg_019fbe84-...`, `msg_019fbe88-...`, `msg_019fbe9a-...`, and `msg_019fbe9c-...`.
- `RunSpec` proposal and acceptance: assistant `msg_0141f487...b073eea4e50a234`; user `msg_019fbe0e-7474-7e53-9f4e-40faac7ac654`.
- Issue-plan/start events: assistant `msg_0141f487...bca36ecb2c05a8a2`; user `msg_019fbf10-e051-75d0-92d7-bfb32174edfb`; work directive `msg_019fbf11-b878-7e83-902a-db4e3868e856`.
- Recorded option calls select single-run society, strict cohort gate, one container per agent, deferred scale, Kubernetes, Temporal+Kueue, local Temporal first, regional GKE Standard, in-cluster controller, CLI+library, Terraform+Helm and Agent Sandbox. Native call locators include `call_vlz2...`, `call_PU6...`, `call_J4G...`, `call_SnF...`, `call_mbM...`, `call_8Tj...`, `call_0HQ...`, `call_0OO...`, `call_z5V...`, and `call_wGDK...`.
- The later simplification and `accept this ADR` exchange is retained literally but has no native locator.
- The later varying-cohort/point-correction exchange is retained literally but likewise has no native locator.

Simulator source gaps explicitly recorded:

- Retained Codex entries supply no parent locator.
- The terse acceptance does not independently choose every later mechanism.
- No source chooses bridge transport/schema or many exact platform mechanisms.
- The overcomplication and final-acceptance messages could not be found in readable session logs.
- No retained event chose the `cluster` field spelling.
- The varying-cohort exchange has no native locator.
- The hundred-agent exported ledger is not retained in the repository.
- No source event supports the specific removal of `100-` from the scale-claim non-goal.

Supporting paths/headings:

- All four ADR frontmatters
- `20260805-production-harness-cutover-trajectory.md` → the three ADR headings, `Source gaps`
- `20260728-gate-1-engineering-review-trajectory.md` → `The endpoint daemon exposes modern MCP over loopback HTTP`
- `20260801-main-kubernetes-society-execution-trajectory.md` → main decision heading, `Source gaps, stated plainly`, `Later corrections`

## 5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.

**Verdict: FAIL**

The strongest contradiction is the simulator/evaluation execution boundary:

- `packages/evals/AGENTS.md` says every society contains autonomous **in-process Effect peers**.
- `packages/evals/src/README.md` still says host acquisition describes an implementation “being replaced.”
- `docs/simulator/overview.mdx` → `Policy applies at the receiver` lists `effectRuntime` roster agents as a current in-process receiver.
- The accepted simulator ADR says peer policy runs in its own Sandbox application container and the in-process Effect runtime has been removed.
- `packages/simulator/AGENTS.md` requires one application container per roster entry.
- Current source has no production `effectRuntime`; `packages/evals/README.md` describes container peers and per-cell RunSpecs.

The accepted ADR and current source make the intended behavior clear: container peers and no host compatibility path. That resolves runtime behavior, but it does not reconcile the repository. `packages/evals/AGENTS.md` is itself a checked-in agent instruction, while the public simulator guide gives executable-looking semantics for a removed runtime. A cold teammate must disregard a current instruction to follow the ADR. This is a blocker.

A second stale instruction exists in `packages/client/AGENTS.md`:

- Its surface table says `MoltZapChannelCore` is available via `@moltzap/client/channel-base` and recommends that subpath for building adapters.
- The HarnessClient ADR says adapters do not construct a channel core.
- `src/channel-base/index.ts` explicitly calls `MoltZapChannelCore` daemon-side and does not export it.
- `scripts/architecture/check-boundaries.js` forbids adapters from importing that symbol.

Required reconciliation:

1. Remove the in-process peer/host-transition descriptions from evals instructions and simulator orientation, and document current container-agent link-shaping limits.
2. Correct the client surface table so HarnessClient is the adapter contract and `channel-base` is only shared presentation primitives.
3. Freeze a new candidate and use a different fresh reviewer.

Supporting paths/headings:

- `packages/evals/AGENTS.md`
- `packages/evals/src/README.md` → `Evaluation application boundary`
- `docs/simulator/overview.mdx` → `Policy applies at the receiver`
- Simulator ADR → `Container runtimes preserve exact native gateways`
- `packages/simulator/AGENTS.md` → `Laws`
- `packages/client/AGENTS.md` → surface table
- HarnessClient ADR → `Decision Outcome`
- `packages/client/src/channel-base/index.ts`
- `scripts/architecture/check-boundaries.js` → `adapter containment`

## 6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

**Verdict: FAIL**

The binding ADR outcomes are detailed enough to implement, but the contradictory checked-in instructions above force a teammate to choose which current source to ignore.

Deliberate deferrals or scope exclusions:

- Profile/checkpoint file format, fsync policy, cache algorithm, sharding, quota and corruption recovery. The trajectory notes these are not stated human choices.
- Proactive one-to-one conversation reuse.
- Presentation acknowledgement/replay; the advance-before-delivery loss window is accepted.
- Hostile same-host defense and any local authorization token.
- Registration operation IDs, idempotency and crash recovery.
- Simulator generation/rebind/rejoin/recovery APIs, customer Effect replay, exactly-once external effects, artifact authority, global execution IDs, universal serialization, public Kubernetes objects, per-agent Temporal workflows, generic gateway protocols, warm societies, multi-run scheduling/fairness/preemption, router HA, production Temporal HA, larger scale claims, alternative schedulers, general secret/recovery/network-policy systems and V2 changes.
- The GKE evaluation qualification half remains open, but its required evidence is stated; this is outstanding acceptance work, not an undecided contract.

Accidental gaps:

- Stale in-process Effect-peer and host-transition instructions in `packages/evals/AGENTS.md`, `packages/evals/src/README.md` and `docs/simulator/overview.mdx`.
- Stale/nonexistent `MoltZapChannelCore` adapter guidance in `packages/client/AGENTS.md`.
- Explicit provenance gaps: local-only source sessions, ambiguous `hes` attestation, missing native locators for later simulator exchanges, no retained source for the `cluster` spelling, no repository-retained hundred-agent ledger, and no source event for one scale non-goal edit. These do not leave the binding code shape unknown, but they remain missing source links/evidence.

Supporting paths/headings:

- All four ADRs → explicit deferrals/non-goals
- Both source trajectories → `Source gaps`, `Later corrections`
- `packages/simulator/gke/README.md` → `Qualification`
- The contradictory paths identified under question 5

## Blockers

| ID | Finding | Required reconciliation |
|---|---|---|
| B1 | Current evals agent instructions and simulator orientation still describe the removed in-process/host execution path. | Align `packages/evals/AGENTS.md`, `packages/evals/src/README.md`, and `docs/simulator/overview.mdx` with container peers and the current link-shaping boundary. |
| B2 | Client package instructions advertise daemon-side `MoltZapChannelCore` as an adapter surface even though the ADR, export barrel and architecture gate prohibit it. | Correct `packages/client/AGENTS.md` to name HarnessClient as the adapter contract and describe `channel-base` accurately. |

Mechanical ADR shape and provenance-anchor checks pass for all 53 records, but semantic consistency does not.

## Overall result

**FAIL**

The candidate’s decisions, lineage, assumptions and source gaps are discoverable. Landing is blocked by current checked-in instructions that contradict the accepted simulator and HarnessClient outcomes.

## Maintainer acceptance

| Field | Value |
|---|---|
| Maintainer | PENDING |
| Reviewed result | `/root/pr974_third_blind_review` |
| Candidate identity matches | PENDING |
| Gate decision | PENDING |
| Decision time | PENDING |
| Rationale | PENDING |
