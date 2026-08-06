# Blind teammate review

**Overall result: FAIL**

The candidate leaves a binding cross-process runtime/gateway boundary unresolved. The Kubernetes ADR requires every code/Effect peer to run in its own Sandbox container while the controller receives that peer’s exact native gateway. The retained gateway ADR defines those gateways as in-process values and forbids adding a generic proxy protocol.

## Audit record

- Candidate commit: `1939ee8b92e95151473c323de8dd702e880dbde5`
- Candidate tree: `b2a487141545e4cced7bc7ab0e0d08f344cebea3`
- Branch: `impl/917-main-local-society`
- Worktree: clean at start and end; branch was 15 commits ahead of its tracking branch
- Review start: `2026-08-04T00:32:44Z`
- Review end: `2026-08-04T00:43:38Z`
- Duration: 654 seconds (`00:10:54`)
- Reviewer identity: `/root/candidate_blind_review_2`
- Author interventions: none
- Repository modifications: none
- Mechanical checks:
  - `git diff --check origin/main...HEAD`: passed
  - `pnpm docs:check`: passed with no broken links
- Isolation attestation: I received only the repository root, the fixed questions, and isolation instructions. I did not author or reconcile the candidate, receive a design summary, diff tour, ADR pointer, search term, expected result, or earlier review output. I did not ask questions or accept hints.
- Quarantine attestation: directory/diff listings exposed the path `docs/decision-evidence/20260801-main-kubernetes-society-execution-cold-review.md`, which is explicitly allowed. I never opened it or searched its contents. Every `rg` command excluded `**/*-cold-review.md` and `**/*invalid-review*`; no quarantined answer or verdict content was returned.

## Exact prompt

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

## Independently discovered paths and headings

- `AGENTS.md` → “Architecture decision records”, “Blind teammate review gate”, “Docs”
- `docs/decisions/README.md` → “Canonical reading guidance”, “Records”
- `docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md` → all headings under “Decision Outcome”, “Non-goals”, “Current owners and earlier outcomes”
- `docs/decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md` → “The main simulator runs container societies on Kubernetes”, “Source gaps, stated plainly”
- `docs/decisions/20260727-code-first-simulator-kernel.md` → “Supersession”, “Public Boundary”
- `docs/decisions/20260729-principal-io-uses-runtime-gateways.md` → “One society, two interaction boundaries”, “Runtime contract and keyed gateway types”, “Scenario ownership”, “Normative Owners”, “Consequences”
- `docs/decisions/20260729-effect-native-evaluation-results.md` → “Supersession”, “Trust, availability, and compatibility”
- `packages/simulator/AGENTS.md` → “Boundary”, “Laws”, “Structure”
- `packages/evals/README.md` → “Execution model”
- `packages/simulator/src/runtime/runtime.ts` → `AgentRuntimeDefinition`, `RunningAgent`
- `packages/simulator/src/runtime/effect.ts` → `EffectAgent`, `effectRuntime`
- `packages/evals/src/peer.ts` → `peerRuntime`
- `v2/AGENTS.md` → “Authority and reading order”, “Simulator provenance gate”
- `docs/decisions/20260728-simulator-is-the-system-driver.md` → “Decision Outcome”
- Transitional documentation in the root, simulator, eval, and example READMEs

## Answers

### 1. Current decision, problem, and authority

The candidate makes current a main/v1 production contract in which:

- An experiment is one code-first `RunSpec` containing `id`, events, an exact keyed runtime roster, an infrastructure Layer, and one customer `execute` Effect.
- `Run.execute(spec)` is the new execution entry point.
- Local Kubernetes and GKE are profiles of one private Kubernetes path.
- Each execution creates one society: Temporal starts one coarse workflow, Kueue admits the complete roster, one Agent Sandbox/application container is created per roster entry, the exact roster passes one readiness gate, the in-cluster controller invokes `execute` once, existing simulator evidence is retained, and Temporal drives cleanup.
- Principal control continues through exact runtime-native gateways; social traffic continues through the production MoltZap router.
- The old host `simulator.define(...).run(...)` path and Docker example are transitional and removed only after replacement evidence exists.

It resolves the gap between an example-only local Docker proof and the requested core simulator path capable of running the same experiment society on local Kubernetes or GKE.

Binding material is:

- The accepted frontmatter and “Scope and authority”.
- The complete “Decision Outcome”, including acceptance gates and “Non-goals”.
- “Current owners and earlier outcomes”.
- The explicit retained/replaced scope in the predecessor ADR’s “Supersession” section.

The `RunSpec.infrastructure` field placement is binding. The trajectory explicitly classifies exact Layer-constructor spelling as implementation detail.

“Context and Problem Statement” and “Consequences” explain the decision. Source trajectories, issue comments, git history, earlier implementation plans, and old ADR context/implementation-plan prose are non-normative.

**Verdict: PASS**

### 2. Replacement, retention, and current normative owners

The candidate replaces only these main/v1 portions of `20260727-code-first-simulator-kernel.md`:

- Public `simulator.define(...).run(...)` naming.
- The host-only concrete execution path.

That predecessor is now `partially-superseded`, names the new ADR as its primary `superseded-by`, and visibly retains:

- Code-first TypeScript/Effect authoring.
- Closed typed EventCatalog.
- Typed RunLedger and producer-bound writers.
- Exact keyed runtime gateways.
- Customer-owned scenario, sweep, completion, and grading policy.
- The single `@moltzap/simulator` package.
- The production v1 router/protocol and absence of social callback shortcuts.

`20260729-principal-io-uses-runtime-gateways.md` remains accepted and governs principal gateways, exact gateway types, social-router traffic, mixed societies, termination policy, and behavioral evidence.

`20260729-effect-native-evaluation-results.md` remains partially current for cases, grading, report resume, SQLite, and Phoenix; its synthetic-sender portions remain replaced by the principal-gateway ADR.

The v2 simulator driver, v2 package ownership, `Simulator.define`, and v2 distributed-execution contracts remain untouched. The apparent v1/v2 naming difference is explicitly scoped by both tracks.

Current normative authority therefore lives in the new main Kubernetes ADR together with the explicitly retained code-first ADR scope and accepted principal-gateway ADR. `packages/simulator/AGENTS.md` repeats the intended package-level implementation laws. Trajectories are provenance, not authority.

The decision index, frontmatter status, visible supersession section, and normative-owner statements agree.

**Verdict: PASS**

### 3. Implementation obligations and assumptions

An implementer must:

- Add `RunSpec` and `Run.execute` to `packages/simulator`.
- Keep the roster, event, ledger, network, outcome, and exact gateway concepts rather than introduce another simulator model.
- Hide Kubernetes, Kueue, Agent Sandbox, Temporal, Helm, Terraform, and cloud-provider objects behind the Effect Layer/private platform boundary.
- Supply local-Kubernetes and GKE profiles through the same execution path.
- Admit the complete roster, create one Sandbox/application container per entry, wait for exact readiness, invoke the customer Effect once without replay, preserve evidence, and clean all run-owned resources.
- Preserve native principal control and production-router social traffic.
- Migrate all 32 OpenClaw/NanoClaw evaluation cells before deleting the host path.
- Prove the fake-platform, two-agent, ten-agent, GKE, evaluation, and zero-residue acceptance gates.

It must avoid compatibility aliases, a Docker backend, warm pools, public Kubernetes objects, generation/rebind/recovery APIs, customer Effect replay, exactly-once external-effect claims, artifact authority, global execution identities, custom serialization grammar, per-agent Temporal workflows, new schedulers, and premature scale claims.

Affected owners are `packages/simulator` and its private platform implementation; `packages/evals` remains a consumer. No `v2/*` contract changes.

The discoverable assumptions are:

- Autonomous agents may ignore instructions, misbehave, terminate, or remain unavailable.
- Gateway adapters and simulator evidence machinery are trusted evaluation instruments.
- Controller or platform loss is an infrastructure failure and starts cleanup.
- Service availability affects progress and operational results, not behavioral truth.
- Complete-roster readiness is the pre-dispatch safety gate.
- Post-dispatch runtime termination is evidence interpreted by customer policy.
- The controller does not replay `execute`; this is not exactly-once safety for external effects.
- Temporal/Kubernetes status is operational observation, not simulator evidence authority.
- Production Temporal HA, router HA, autoscaling, recovery, and scale beyond ten agents are not claimed.
- The v2 Byzantine/fault assumptions do not silently apply to this v1 decision.

However, the implementation obligations are not mutually satisfiable for current code/Effect runtimes. The retained exact in-process gateway contract has no selected cross-container representation, described under question 5.

**Verdict: FAIL**

### 4. Decision-makers, events, alternatives, reversals, deferrals, and source gaps

The sole human named in ADR frontmatter is **Tapan Chugh**. The event ledger identifies stored actors as `user`, `assistant`, absent, or mechanical accounts; it does not independently map each stored `user` event to Tapan. I do not infer such a mapping.

The main trajectory cites:

- Codex session `019fbbdd-7cff-7753-8541-4f66f0248d43`:
  - `msg_019fbbe1-770d-7d11-8475-0f2f7b3bd7b1` and `msg_019fbdeb-1743-7470-be76-7ed53d7f2420`: target main first and make the work part of the core simulator.
  - `msg_019fbded-2372-72b0-b859-61f6fe80ac47`: plan the final shape before implementation.
  - Assistant `msg_0141f487830063b4016a6e17e648d481939b073eea4e50a234`, followed by user `msg_019fbe0e-7474-7e53-9f4e-40faac7ac654`: one `RunSpec`, one customer `execute` callback, and `Run.execute`; the user reply is `okay do this`.
  - `msg_019fbe84-b81b-7312-ad62-03432f57cdf2` and `msg_019fbe88-7cd4-7c62-9b8c-e9060c44f8d8`: pull GKE Sandbox into the core and use Kubernetes, Kueue, Temporal, and local/GKE targets.
  - `msg_019fbe9a-2e94-7430-8da7-f71f0e533f15` and `msg_019fbe9c-4f9a-7970-adb5-15463aea8686`: main and `packages/simulator`, not v2.
  - Assistant `msg_0141f487830063b4016a6e40cd78048193bca36ecb2c05a8a2`, immediately followed by user `msg_019fbf10-e051-75d0-92d7-bfb32174edfb`: the overbuilt issue-plan summary and contextual reply `start`.
  - `msg_019fbf11-b878-7e83-902a-db4e3868e856`: work on issue #936, keep issue notes, and run evaluations end to end through the new path.
- Earlier Codex session `019fab08-15ca-7a10-a9af-f2a8441a45f5`:
  - `call_vlz2QouoKyvTCXhmbDB9Hiny`: selected one single-run society.
  - `call_PU6nJTGPlpeJ3PATixSc2ef8`: selected a strict cohort gate.
  - Direct user event at `2026-07-29T00:03:38.313Z`: one container per agent.
  - `call_J4GjN5U25rt7aNh4Jo8eY8L9`: rejected the offered larger-scale gates and deferred them until ten agents.
  - Direct user events at `2026-07-29T00:14:21.664Z` and `00:16:16.056Z`: general Kubernetes, stock OpenClaw compatibility, and prebuilt images only as optimization.
  - `call_SnFa3x3617eQul6H1zPNZeCm`: Temporal plus Kueue.
  - `call_mbMK8n64ZfjzAGVA69nzjhIw`: local Temporal first, production hosting unselected.
  - `call_8Tj66rC9ATIk5wZqXIiFtRia`: regional GKE Standard.
  - `call_0HQBCkj6yDpE4i7yXzEsTp8g`: in-cluster controller.
  - `call_0OO9tWVFfZHYPNu61PoPXcqN`: CLI plus library.
  - `call_z5VtaeUzaAe4BaD0DJh3UnVU`: Terraform plus Helm.
  - `call_wGDKczyyYEXYTVNWIhEoXYbN`: Agent Sandbox.
- Mechanical events:
  - Merge commit `2d3fc41295ae66b95d19c0df2d448a41781c9b07`.
  - GitHub issue comments `5153357233`, `5153393832`, `5153770731`, and `5173168998`, all expressly classified as agent/mechanical artifacts rather than independent human rationale.

The retained code-first trajectory cites session `019fa613-7f9a-7103-99b0-a42fda0754de` for code-first customer policy, a closed event universe, mixed societies, customer-owned runtime-termination policy, ledger terminology, Effect services/SQL, branded types, and one simulator package.

The retained principal-gateway trajectory cites the same session, principally turn `39d5505f-efa9-417d-b97f-14af5a270f73` and attachment `f4eee480-6d7d-4bb2-b8e7-0d6c57e60b6e` with SHA-256 `23a57ba9d5b83e186006dcfa43960e70d734fec3b3cf3fc25f2be98008b71622`, for exact native gateways, no gateway union, no synthetic principal, native evidence correlation, `replyToId` removal, and behavioral-evaluation reclassification. Later cited events place restart/replacement outside v0, reject compatibility preservation, request Effect SQL/evaluation-result tooling, and state that a code agent’s Effect API is already its native gateway.

The reversal is explicit:

- The contextual `start` followed an agent-authored plan containing exact generations, start-or-attach machinery, and exactly-once invocation language.
- Two later live user messages, retained only in the source-gap report, rejected the overcomplicated design and made checked-in requirement conversations the boundary.
- A later assistant prompt presented the simplified shape, including no generations/artifact authority/start-or-attach/recovery and controller failure with no replay.
- The unlocated user reply was `accept this ADR`.

Explicit source gaps include:

- Current Codex events have no parent locator.
- Several earlier events have no separate message ID or stored actor role; the available session, turn/call, event kind, and timestamps are retained.
- Terse replies are meaningful only with their immediately preceding retained prompts.
- The final Layer-constructor spelling was never selected.
- Reasons were not separately stated for every resource shape, failure variant, security control, or mechanism.
- Versions, upstream API schemas, provider/chart choices, timeouts, storage mechanisms, generation protocols, artifact authorities, identity derivations, and recovery schemes were not human decisions in the excerpts.
- The two overcomplication-rejection messages and final acceptance exchange could not be recovered from workspace-readable session logs, so they have no native IDs, timestamps, parent locators, or stored actor-role record.
- The GitHub issue and comments are agent-authored mechanical artifacts; one comment has no exposed creation timestamp.
- The principal-gateway handoff does not locate its preceding conversations and does not choose concrete gateway APIs, commands, transports, or response shapes.

These gaps are stated rather than silently repaired.

**Verdict: PASS**

### 5. Strongest contradiction or broken lineage

The strongest contradiction is between two current main-track contracts.

`20260729-principal-io-uses-runtime-gateways.md` says:

- A code agent’s in-process Effect API is itself its native gateway.
- `effectRuntime({ build })` returns the exact customer gateway and autonomous behavior, which may share scoped Effect state.
- The simulator must not add a generic command queue, actor mailbox, second request protocol, or universal gateway normalization.
- Evaluation peers remain ordinary `effectRuntime({ build })` policies.

The new Kubernetes ADR says:

- Every roster entry, including real and code/scripted agents, is one Agent Sandbox application container.
- Infrastructure containers are not agents.
- A controller invokes the one customer `execute` Effect.
- That Effect retains the exact keyed runtime gateways.
- All 32 evaluation cells move through this path.

The checked-in implementation confirms the collision:

- `packages/simulator/src/runtime/effect.ts → EffectAgent` places `gateway` and `behavior` in the same acquired in-process runtime.
- `packages/evals/src/peer.ts → peerRuntime` uses a shared in-process `Deferred` as the peer’s observation gateway.
- `packages/evals/README.md` says every one of the 32 societies contains autonomous in-process Effect peers.
- `scriptedRuntime` appears only in the new ADR example; it has no checked-in contract or symbol.

Once such a peer runs in its own Sandbox container, the controller cannot receive the same in-process gateway value. Resolving that requires one of:

1. A remote proxy/serialization protocol for arbitrary gateway values.
2. Co-locating the code peer with the controller.
3. Removing or replacing `effectRuntime` peers from the Kubernetes path.

Each option violates or changes a current binding statement.

The authority order cannot resolve this. The new ADR expressly says the principal-gateway ADR remains current and replaces only public naming and the host execution path. Root ADR law prohibits silently replacing an accepted outcome. `packages/simulator/AGENTS.md` repeats both sides instead of selecting a reconciliation.

Other apparent contradictions are resolved:

- Old main documentation and Docker code are explicitly marked transitional until acceptance evidence exists.
- v2 continues to use `Simulator.define`, but both tracks explicitly scope that contract to v2.

The runtime/gateway collision remains a blocker.

**Verdict: FAIL**

### 6. Implementability and unresolved choices

No. A teammate cannot implement all binding requirements without inventing a new public or private contract that changes retained semantics.

Accidental gaps:

- No contract maps the existing executable `AgentRuntime.acquire` closure to a remotely deployed Sandbox application container.
- No contract transports an arbitrary exact `Gateway` and `termination` Effect from an agent container to the controller.
- No decision explains how `effectRuntime` builder closures and their shared scoped state execute remotely.
- `scriptedRuntime` is used in the normative example but is neither defined nor reconciled with the retained decision against a generic scripted-agent gateway.
- The required 32-cell migration cannot preserve the current in-process Effect peers without resolving those boundaries.
- Consequently, the “one container per roster entry”, “exact native gateway”, “controller invokes execute”, and “reuse rather than replace the existing runtime model” requirements cannot all be implemented simultaneously.

Deliberate deferrals/non-goals:

- Generation/rebind/rejoin/replacement/recovery APIs.
- Customer Effect replay and exactly-once external effects.
- Artifact authority, start-or-attach storage, global execution IDs, and normative Kubernetes naming.
- New serialization grammar and universal input/result/failure schemas.
- Public Kubernetes objects, arbitrary Pod templates, and per-agent Temporal workflows.
- Warm pools, multi-run scheduling, fairness, borrowing, preemption, autoscaling, router HA, and production Temporal HA.
- Scale qualification above ten agents.
- Nomad, Slurm, managed batch, and GKE Autopilot.
- Exact Secret-provider protocols, persistent state recovery, exhaustive NetworkPolicy, and general multi-tenant security.
- Exact upstream versions, API schemas, chart/provider selection, cache/transport details, timeouts, and storage mechanisms.
- Exact production Temporal hosting.

Explicit provenance limitations, not silent design gaps:

- Missing native locators/timestamps for the later rejection and final acceptance exchange.
- Missing independent human rationale for most private mechanisms.

The accidental runtime/gateway gaps are architectural, not ordinary private Kubernetes mechanics.

**Verdict: FAIL**

## Blockers

1. Define and admit how a separately containerized `effectRuntime` or customer code runtime exposes its exact gateway and termination observation to the controller without violating the retained prohibition on a generic second protocol.
2. Decide whether `scriptedRuntime` is a new public runtime contract, remove it from the binding example, or explicitly supersede the retained `effectRuntime` evaluation-peer requirement.
3. Update the ADR lineage, normative ownership, package instructions, and evaluation transition together once that choice is made, then freeze a new candidate for a different blind reviewer.

## Discovery trail and commands

All commands ran read-only from `/home/tapanc/moltzap-pr-917-main`.

```text
date -u +'%Y-%m-%dT%H:%M:%SZ'
git rev-parse HEAD
git rev-parse HEAD^{tree}
git branch --show-current
git status --short --branch

sed -n '1,280p' AGENTS.md
sed -n '281,560p' AGENTS.md
git log --oneline --decorate --graph -30
git diff --name-status origin/main...HEAD
git diff --stat origin/main...HEAD

sed -n '1,280p' docs/decisions/README.md
sed -n '1,340p' docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md
sed -n '1,460p' docs/decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md
sed -n '1,360p' docs/decisions/20260727-code-first-simulator-kernel.md
sed -n '361,720p' docs/decisions/20260727-code-first-simulator-kernel.md
sed -n '1,360p' docs/decisions/20260729-principal-io-uses-runtime-gateways.md
sed -n '1,340p' docs/decisions/20260729-effect-native-evaluation-results.md

rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*' '^## |^Source gaps' docs/decision-evidence/20260727-code-first-simulator-trajectory.md docs/decision-evidence/20260729-principal-runtime-gateway-trajectory.md
sed -n '1,190p' docs/decision-evidence/20260727-code-first-simulator-trajectory.md
sed -n '1,330p' docs/decision-evidence/20260729-principal-runtime-gateway-trajectory.md

rg -n --hidden --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*' --glob '!node_modules/**' --glob '!.git/**' 'simulator\.define|Simulator\.define|RunSpec|Run\.execute|Docker execution backend|Kubernetes' .
sed -n '1,240p' packages/simulator/AGENTS.md
sed -n '140,230p' README.md
sed -n '1,130p' packages/simulator/README.md
sed -n '1,260p' docs/simulator/running.mdx
sed -n '1,140p' examples/simulator/README.md

sed -n '1,180p' v2/AGENTS.md
sed -n '1,280p' docs/decisions/20260728-simulator-is-the-system-driver.md
sed -n '1,220p' v2/inputs/simulator-handoff-20260728.md

rg -n --hidden --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*' --glob '!node_modules/**' --glob '!.git/**' 'start-or-attach|generation (API|stream|identifier)|exactly-once|at-most-once|artifact authority|execution-id|Temporal.*replay|replay.*Temporal' .
rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*' 'docs:check|check:links|mermaid' package.json tools packages -g 'package.json' -g 'project.json' -g '*.ts' -g '*.mjs'
sed -n '1,320p' .github/workflows/ci.yml

git diff --check origin/main...HEAD
pnpm docs:check
git status --short --branch
git rev-parse HEAD
git rev-parse HEAD^{tree}

rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*' 'decision-evidence|decision-makers|partially-superseded|MADR|ADR' scripts tools package.json -g '*.ts' -g '*.mjs' -g '*.json'

rg -n --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*' 'effectRuntime|defineRuntime|scriptedRuntime' packages/simulator/src packages/evals/src docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md packages/simulator/AGENTS.md
sed -n '200,320p' packages/simulator/src/runtime/runtime.ts
sed -n '1,330p' packages/simulator/src/runtime/effect.ts
sed -n '430,530p' packages/evals/src/peer.ts

git diff origin/main...HEAD -- docs/decisions/20260729-principal-io-uses-runtime-gateways.md docs/decisions/20260729-effect-native-evaluation-results.md
git rev-parse origin/main
git merge-base origin/main HEAD
git diff --name-status origin/main..HEAD -- docs/decisions/20260729-principal-io-uses-runtime-gateways.md docs/decisions/20260729-effect-native-evaluation-results.md
git diff --name-status origin/main...HEAD -- docs/decisions/20260729-principal-io-uses-runtime-gateways.md docs/decisions/20260729-effect-native-evaluation-results.md
git diff --name-status origin/main...HEAD

sed -n '1,120p' packages/evals/README.md
sed -n '1,130p' packages/evals/src/README.md
sed -n '1,130p' packages/simulator/src/runtime/runtime.ts

rg -n --hidden --glob '!**/*-cold-review.md' --glob '!**/*invalid-review*' --glob '!node_modules/**' --glob '!.git/**' '\bscriptedRuntime\b|\beffectRuntime\b' .

review_end=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
review_start_epoch=$(date -u -d '2026-08-04T00:32:44Z' +%s)
review_end_epoch=$(date -u -d "$review_end" +%s)
review_duration_seconds=$((review_end_epoch-review_start_epoch))
printf '%s\n' "$review_end" "$review_duration_seconds"
git status --short --branch
git rev-parse HEAD
git rev-parse HEAD^{tree}
```
