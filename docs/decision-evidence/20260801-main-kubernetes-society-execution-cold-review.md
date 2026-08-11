# Blind teammate review — main Kubernetes society execution

## Candidate identity

- Repository: `/home/tapanc/moltzap-pr-917-main`
- Branch: `impl/917-main-local-society`
- Candidate commit: `0f152696e588538ffcbfac0162bcd1cf17bbaab3`
- Candidate tree: `0374e97d203e02a8a2b7d001c51f2f5f8958f047`
- Merge base with `origin/main`: `314ece9e115e18d443363d42577d567f087d644d`
- Subject: `WIP: define main Kubernetes society execution`
- Worktree: clean
- UTC start: `2026-08-01T22:01:54Z`
- UTC end: `2026-08-01T22:10:44Z`
- Duration: 8 minutes 50 seconds

## Reviewer and isolation attestation

Reviewer: fresh Codex teammate `/root/candidate_blind_review_1`.

I received only the candidate repository root, isolation rules, and the fixed questions. I had no inherited author conversation, compaction, memory, private state, or earlier blind-review output. I used only the candidate repository, normal navigation, history, search, and repository-local checks. I did not browse external sources.

A path listing exposed the names of existing quarantined review artifacts. I did not open, read, or content-search any `*-cold-review.md` or invalid-review record. No command returned an answer or verdict from one. The review remained in one uninterrupted fresh-agent context.

Author interventions: none. I asked for no hints and received none.

## Exact prompt questions

1. What decision does this candidate make current, what problem does it resolve, and which statements are binding versus context or non-normative explanation?
2. What earlier outcomes does it replace, retain, or leave untouched, and where does the current normative contract live?
3. What must an implementer now do or avoid, which layers or consumers are affected, and under what fault, trust, safety, liveness, and compatibility assumptions?
4. Which humans are named as decision-makers, which source events does the compacted trajectory cite for their calls, alternatives, reversals, and deferrals, and what source gaps does it explicitly record? Report only what the event ledger states; do not infer motives, confidence, urgency, or rationale.
5. Find the strongest apparent contradiction, stale instruction, or broken lineage elsewhere in the repository. Resolve it using the authority order or report it as a blocker.
6. Could a teammate implement the decision without chat or guessing? List every missing link or unresolved choice and classify each as a deliberate deferral or an accidental gap.

## Unedited answers

### 1. Current decision, problem, and authority

The candidate makes `docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md` current with status `accepted`.

It governs main-track v1 society execution in `packages/simulator` and the `packages/evals` consumer. `@moltzap/simulator` remains the single owner of real society execution, but Kubernetes becomes its only real distributed backend. Local kind and GKE use the same schema-bound `RunSpec`, container roster, `Run.execute` path, private kernel, Kueue aggregate admission, Agent Sandbox lifecycle, Temporal orchestration, durable artifacts, and evidence model. Evaluations use that path rather than a separate or host-based executor.

The decision resolves the existing host-process/in-process engine’s lack of reconstructible distributed execution, all-roster admission, durable start-or-attach identity, generation-aware container lifecycle, and fail-closed platform qualification. It also prevents a Kubernetes example or second backend from leaving two execution semantics and allowing evaluations to continue testing the old host engine.

The record explicitly makes the following binding:

- its `Decision Outcome`;
- the public `RunSpec`, `Agent`, `Infrastructure`, and `Run` contract;
- lifecycle, generation, admission, dispatch, cleanup, and evidence invariants;
- security, trust, safety, liveness, and compatibility assumptions;
- normative ownership;
- deliberate deferrals; and
- the main/v1 scope declared in `Scope and authority`.

The context and problem statement explain why the decision exists. The consequences explain its effects. Issue #936 is explicitly non-normative. The source-event trajectory is evidence, not authority. Historical ADR bodies and transition notices describe lineage or current pre-cutover implementation and do not extend the new contract.

The v2 simulator/testbed split, v2 `Simulator.define` port, Gate 1 manifest, `v2/*`, and draft issue #917 decisions are explicitly outside scope.

### 2. Replaced, retained, and untouched outcomes

The new ADR is the primary replacement for three partially superseded main/v1 records.

From `20260727-code-first-simulator-kernel.md`, it retains TypeScript/Effect authoring, the closed `EventCatalog`, typed `RunLedger`, producer-bound evidence, customer-owned scenarios/sweeps/completion/grading, one simulator package, and the production v1 router/protocol. It replaces `Simulator.define`, definition-bound `.run`, `simulatorLayer`, host/mixed runtime acquisition, Docker/process/filesystem execution composition, in-process production runtimes, and the prior restart/replacement deferral.

From `20260729-principal-io-uses-runtime-gateways.md`, it retains runtime-native principal control versus MoltZap social traffic, exact typed gateways, no universal gateway union or correlation ID, no synthetic-principal shortcut, the gateway/social evidence distinction, `replyToId` removal, and the evaluation identities and behavioral intent. It replaces `AgentRuntime.acquire`, `RunningAgent`, `StartedAgent`, host readiness and lifetime, in-process production peers, and the blanket restart/rebinding deferral with stable slots and generation-aware gateways.

From `20260729-effect-native-evaluation-results.md`, it retains the sixteen-by-two evaluation catalog, typed reports, deterministic and semantic grading, sanitized provenance, SQLite authority, Phoenix materialization, and old-report reading. It replaces host runtime snapshots and outcomes, runtime factories/in-process peers, and rerunning missing cells with schema-bound container inputs and `attemptId === executionId` start-or-attach.

The changed frontmatter, visible `Supersession` sections, and decision index agree on these statuses and replacements.

The accepted v2 simulator-system-driver decision, Gate 1 manifest, v2 package split, and v2 specifications remain untouched. Existing ledger format version 1, admitted legacy schemas, existing event tags, legacy event classes, old reports, and UUID ledger references remain only where the new compatibility section says they remain readable.

The current normative main/v1 contract lives in the new ADR until its named implementation owners encode it. `packages/simulator/AGENTS.md` already owns the package boundary and dependency law. The ADR assigns the remaining contracts to `src/definition.ts`, the runtime facade, `src/execution.ts`, events/ledger, kernel, private platform/orchestration/controller/artifact modules, deployment/CLI/Nx assets, and `packages/evals`.

### 3. Implementation obligations and assumptions

An implementer must:

- expose the frozen root namespaces `RunSpec`, `Agent`, `Infrastructure`, and `Run`, without a new export subpath;
- accept schema-bound, finite-JSON input/result/failure values and deterministic, exact, nonempty container rosters;
- support only digest-pinned container descriptors with typed bridges, fixed resource fields, constrained persistence, and exact logical Secret slots;
- keep Kubernetes as the sole real backend, with only local and GKE infrastructure selections, and keep platform/orchestration APIs private;
- create one stable AgentId and direct single-application-container Sandbox per roster slot;
- model Pod UID plus application-container restart count as generations and never replay active calls, turns, subscriptions, streams, or cursors;
- compare-create a durable execution binding, attach exact retries, preserve terminal outcomes and receipts, and reject conflicting execution identities before creating further resources;
- admit the complete homogeneous roster through one manual aggregate Kueue Workload before creating Sandboxes;
- recheck the exact ready generation set and durably fence at most one customer-program invocation;
- use one non-replacing controller and one Temporal Workflow, with controller loss terminal;
- let only the controller append simulator lifecycle events and seal the ledger;
- let the Temporal finalizer clean and verify resources, publish completion, and store terminal artifacts without inventing or rewriting events;
- implement the exact closed outcome, pre-ledger error, receipt, and Kubernetes event contracts;
- fail closed on schema drift, mutation, incomplete observation, residue, or inability to prove qualification;
- cut evaluations over to the same container path, preserving grading/SQLite/Phoenix ownership and attaching resume to the same durable execution; and
- remove executable old runners and aliases without a compatibility executor.

Affected surfaces are the v1 simulator’s definition, runtime bridge, network, ledger, kernel, Kubernetes/Sandbox/Kueue platform, Temporal orchestration, controller, artifact, CLI/deployment, and evaluation-consumer boundaries. The decision does not amend the v2 layers or packages.

Trusted components for the claimed safety properties are submitted ESM, the cluster administrator, simulator controller/worker/finalizer, Kubernetes control plane/API, Kueue and Agent Sandbox controllers, Temporal and its persistence, artifact/binding/ledger storage, registry digest resolution, DNS/policy enforcement, and the v1 router/server. Application containers and their output may be faulty or malicious.

The container boundary depends on a qualified runtime such as gVisor, policy, and the trusted control plane. Local kind assumes a trusted rootful Linux/amd64 host and cannot claim hostile-code or managed-isolation parity before its gates pass. Only a passing managed GKE suite may claim managed isolation qualification.

Safety depends on durable binding, dispatch fencing, storage, and controller/finalizer behavior. It is at-most-once program dispatch, not exactly-once customer side effects. Controller loss, partitions, or deletion cannot authorize replay or weaker admission.

Liveness additionally requires Temporal, storage, registry, DNS, router, Kubernetes/controllers, quota, physical capacity, all current agent generations, bridges, and any provider proxy to remain available. Their loss may stop progress.

Compatibility keeps ledger format 1 and existing tags, adds a separate exact Kubernetes catalog, keeps legacy readers read-only, requires a new evaluation definition version, and intentionally makes the execution cut source-breaking.

### 4. Decision-makers, source events, and source gaps

The ADR names one human decision-maker: Tapan Chugh.

The trajectory identifies Codex session `019fbbdd-7cff-7753-8541-4f66f0248d43` and cites these stored events:

- User message `msg_019fbbe1-770d-7d11-8475-0f2f7b3bd7b1`, turn `0a25724d-258f-41b3-a256-f8c95db5bd3a`, at `2026-08-01T05:52:23.309Z`: target main first with the original simulator.
- User message `msg_019fbdeb-1743-7470-be76-7ed53d7f2420`, turn `019fbdeb-1371-7be3-8e61-babd80ff5ffc`, at `2026-08-01T15:22:08.579Z`: make it part of the core simulator rather than one example and ask for the next slice.
- User message `msg_019fbded-2372-72b0-b859-61f6fe80ac47`, turn `019fbded-227b-70a3-9d9e-9a52a461b990`, at `2026-08-01T15:24:22.771Z`: plan the final shape first.
- Assistant proposal `msg_0141f487830063b4016a6e17e648d481939b073eea4e50a234`, turn `019fbdeb-1371-7be3-8e61-babd80ff5ffc`, at `2026-08-01T15:59:39.573Z`: one `RunSpec` with a customer `execute` callback.
- Directly following user message `msg_019fbe0e-7474-7e53-9f4e-40faac7ac654`, turn `019fbe0e-71e3-76e0-9b67-78ce9cab69e0`, at `2026-08-01T16:00:46.197Z`: “okay do this.”
- User message `msg_019fbe84-b81b-7312-ad62-03432f57cdf2`, turn `019fbe84-b775-7542-94b0-788b9b0a79d7`, at `2026-08-01T18:09:56.763Z`: pull the GKE sandbox work into the core.
- User message `msg_019fbe88-7cd4-7c62-9b8c-e9060c44f8d8`, turn `019fbe88-7c3a-7c10-a1af-ec026b6309e2`, at `2026-08-01T18:14:03.732Z`: use Kubernetes, Kueue, Temporal, and the complete setup, targeting local Kubernetes or GKE.
- User message `msg_019fbe9a-2e94-7430-8da7-f71f0e533f15`, turn `019fbe9a-2ddc-7cd1-b15b-c1447e2310aa`, at `2026-08-01T18:33:23.349Z`: land on main.
- User message `msg_019fbe9c-4f9a-7970-adb5-15463aea8686`, turn `019fbe9c-4ede-7d12-ae11-e054cf83a684`, at `2026-08-01T18:35:42.874Z`: target `packages/simulator`, not v2.
- User directive `msg_019fbf11-b878-7e83-902a-db4e3868e856`, turn `46fbcdbe-0654-4ba4-8e69-d2de6baaa959`, at `2026-08-01T20:43:57.432Z`: work on issue #936, keep agent-maintained issue notes, and run evaluations end to end through the new path.
- Separate mechanical events record the main merge, baseline checks, and agent-published issue comments.

The events show the alternatives “core versus example” and “main/packages/simulator versus v2.” The trajectory records no explicit human reversal. The movement of infrastructure selection from the accepted assistant example’s `RunSpec` into `Run.execute` is explicitly identified as a later agent-proposed refinement, not a retained human choice.

The trajectory explicitly records these source gaps:

- Codex supplied no parent locators.
- “okay do this” has meaning only relative to the directly preceding assistant proposal.
- No separate user event chooses the final infrastructure-field placement.
- The retained human messages do not separately decide every resource shape, failure variant, security control, event field, or platform mechanism.
- Exact versions, schemas, providers, timeouts, storage mechanisms, scale limits, and cost budgets are not human decisions in the excerpts.
- The issue plan and checkpoint prose are agent-authored mechanical artifacts.
- Private instructions, hidden reasoning, irrelevant output, private URLs, and credentials are omitted.

The repository does not retain an event in which Tapan Chugh reviews or accepts the comprehensive 571-line final outcome after these agent refinements. The trajectory identifies stored actors only as `user`; it does not establish that the session account is the named decision-maker. Under the repository’s provenance law, the frontmatter and Git identity do not themselves prove human acceptance of the detailed binding choices.

### 5. Strongest apparent contradiction or stale instruction

The strongest repository-local stale instruction is the newly added `examples/simulator/README.md` and root `simulator:example` command. They present a host-Node/Docker three-container runner using `simulator.define`, `simulatorLayer`, and `openClawRuntime`, while the accepted ADR says Kubernetes is the only real backend and prohibits a Docker executor, host executor, or compatibility runner. Generated `docs/modules/simulator/src.mdx` and `packages/simulator/src/MODULE.md` also still expose `simulatorLayer` without a transition banner.

The authority chain resolves the semantic conflict:

1. The accepted new ADR explicitly owns the current main/v1 execution decision.
2. `packages/simulator/AGENTS.md` repeats the one-Kubernetes-path law and forbids preserving the old executable aliases.
3. Root and package simulator guides label the old APIs as pre-cutover implementation rather than extension points.
4. The example calls itself the “original simulator” and a precursor.

Therefore these files describe current implementation state, not the target contract. They must not guide new implementation. The example and generated API pages should receive an explicit transition pointer or be removed at cutover, but they do not override the accepted ADR.

The accepted v2 simulator ADR’s preservation of `Simulator.define` is another apparent conflict, but it is fully resolved by the repository’s two-track authority: that record governs v2, while this candidate explicitly governs main/v1 and leaves v2 untouched.

### 6. Implementability and unresolved choices

No. A teammate can understand the intended architecture, but cannot implement every binding guarantee without making unrecorded public or persistence choices.

Accidental gaps and blockers:

1. **Execution authority contradicts its binding key.** The immutable binding is keyed by `(infrastructure authority, definition id, executionId)`, and cluster recreation intentionally creates a different authority. The ADR nevertheless requires a changed authority to return `RunExecutionConflict` and create no new binding or resource. Changing authority changes the lookup key, so the stated compare-create cannot discover the old binding without an additional cross-authority uniqueness index or a differently scoped key. Neither is specified. The decision must choose whether execution identity is authority-scoped or globally conflicts across authorities.

2. **The comprehensive accepted outcome lacks final human-accountable source approval.** The retained user accepts a much smaller one-`RunSpec` proposal and later directs the platform scope. The trajectory itself says the final infrastructure placement and detailed lifecycle, persistence, event, security, and error mechanics are agent refinements without separate human events. No retained event admits or approves the final outcome, and no explicit delegation gives the agent decision authority. This leaves binding choices attributed only through frontmatter, which repository law says is insufficient proof.

3. **The declared public interface is incomplete.** The ADR calls the names, fields, and semantics binding but does not provide complete Effect signatures and closed shapes for `Run.execute`, `Run.open`, slot/generation stream values, bridge unavailability types, receipts, or all namespace inventories. The future owner files do not yet encode the replacement contract. An implementer must make public type decisions.

4. **The public CLI contract is missing.** The ADR says the package owns the public CLI and specifies signal exits 130/143, but gives no command names, arguments, input/output JSON schemas, ordinary exit mapping, attachment/query behavior, or error rendering. Issue #936 is explicitly non-normative, so it cannot fill this contract.

5. **Durable cross-process identifier encoding is incomplete.** The Workflow ID is a domain-separated SHA-256 over three values, but the domain separator and byte encoding of the tuple are not frozen. Stable AgentId allocation and the exact resolved-roster projection shared by submitter and controller are also not assigned a complete persisted encoding. These choices affect durable attachment and compatibility rather than only private code structure.

6. **Pre-cutover documentation remains inconsistently marked.** The active Docker example and generated simulator API pages lack the new transition pointer present in the primary guides. Authority resolves the target, but a cold implementer can still encounter an apparently supported forbidden runner.

Deliberate deferrals, clearly identified by the ADR:

- exact upstream versions, digests, checksums, served Sandbox schemas, and aggregate Kueue projection;
- one-container OpenClaw and NanoClaw bootstrap and bridge wire envelope;
- local runtime/CNI behavior and regional GKE add-on behavior;
- durable Temporal deployment, artifact-authority schemes, timeouts, and profile limits;
- production Temporal hosting/HA, fairness, borrowing, preemption, physical gang scheduling, multicluster dispatch, hostile submitted-module isolation, automatic execution-ID reuse, non-Linux/rootless local support, at-rest certification, and exactly-once external effects;
- persistent-agent storage and artifact design above the 100-agent gate; and
- 1,000/5,000/10,000-agent feasibility and latency/resource/throttling/cost budgets.

Those deliberate deferrals block a profile when its spike fails and do not authorize a fallback executor or weaker lifecycle. They are not the reason for the review failure; the accidental contract, provenance, and identity gaps are.

## Independently discovered paths and headings

- `AGENTS.md`
  - `Project`
  - `Architecture decision records`
  - `Decision provenance`
  - `Lifecycle and landing`
  - `Blind teammate review gate`
- `docs/decisions/README.md`
  - `Canonical reading guidance`
  - `Records`
- `docs/decisions/20260801-main-simulator-runs-container-societies-on-kubernetes.md`
  - `Scope and authority`
  - `Decision Outcome`
  - `Start-or-attach identity and durable artifacts`
  - `Security, trust, safety, and liveness assumptions`
  - `Compatibility and evaluation cutover`
  - `Normative owners`
  - `Deliberate deferrals`
  - `Earlier outcomes replaced and retained`
- `docs/decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md`
  - `The main simulator runs container societies on Kubernetes`
  - `Source gaps, stated plainly`
- The `Supersession` sections of the three changed earlier ADRs
- `packages/simulator/AGENTS.md`
  - `Boundary`
  - `Laws`
  - `Structure`
- `v2/VISION.md`
  - `Authority`
  - `Packages and versions`
- `docs/decisions/20260728-simulator-is-the-system-driver.md`
- `docs/decisions/20260729-v2-authority-lives-with-v2.md`
- Transition notices in root, simulator, evaluation, and development guides
- `examples/simulator/README.md`
- `docs/modules/simulator/src.mdx`
- `packages/simulator/src/MODULE.md`

## Discovery trail

1. Identified the clean candidate commit, tree, merge base, history, and changed paths.
2. Read repository ADR law and the decision index.
3. Read the complete new ADR and its complete source-event trajectory.
4. Compared all three superseded ADRs and the index against the new lineage.
5. Read package law, transition documentation, current v2 authority, and the v2 simulator decision.
6. Searched non-quarantined repository content for old and new simulator public APIs.
7. Inspected the active Docker example and generated simulator API documentation.
8. Checked the binding-key and authority language across all non-quarantined sources.
9. Ran `pnpm docs:check`; Mint reported `success no broken links found`.
10. Reconfirmed the worktree remained clean and the candidate identity unchanged.

## Per-question verdicts

1. **PASS** — The current decision, problem, scope, and binding/non-binding distinction are explicit and discoverable.
2. **PASS** — Supersession, retained scope, v2 exclusion, index status, and normative ownership are consistent and discoverable.
3. **PASS** — Implementation duties and fault/trust/safety/liveness/compatibility assumptions are unusually detailed and discoverable.
4. **FAIL** — The trajectory is source-faithful, but it does not contain final human approval of the comprehensive accepted outcome or establish that the stored `user` is the named decision-maker. It explicitly identifies major agent-proposed refinements.
5. **PASS** — The strongest stale main example/generated-doc conflict and the v2 API conflict can be resolved through the accepted ADR, package law, transition notices, and two-track scope.
6. **FAIL** — The authority/key contradiction and incomplete public API/CLI/durable identity contracts require guessing; the provenance gap also prevents treating the detailed choices as admitted human decisions.

## Blockers

- Resolve the execution-binding authority/key contradiction.
- Obtain and retain human review or acceptance of the complete candidate outcome, or narrow the accepted outcome to the choices actually supported by retained events.
- Freeze the missing public API, CLI, and durable identity encodings, or explicitly classify and bound them as non-public implementation choices or deliberate deferrals.
- Re-run the blind gate with a different fresh reviewer after any semantic correction.

## Overall result

**FAIL — blocks landing.**

Mechanical links pass and the decision’s broad architecture, scope, lineage, and assumptions are discoverable. The source-attribution failure and unresolved binding/authority contract prevent an overall PASS.
