---
status: partially-superseded
date: 2026-07-29
decision-makers: Tapan Chugh
superseded-by: 20260729-principal-io-uses-runtime-gateways.md
---

# Evaluation runs produce typed reports published to Phoenix

Decision provenance: [stored evaluation-pipeline
trajectory](../decision-evidence/20260729-effect-native-evaluation-results-trajectory.md#evaluation-runs-produce-typed-reports-published-to-phoenix).

## Supersession

Runtime provenance, total run outcomes, code-defined case and criterion
catalogs, semantic judging, resumable reports, and Phoenix publication remain
current. The initial sixteen case identities, behavioral questions, and slice
coverage also remain current as behavioral intent. Descriptions, versioned
definitions, criteria, and rubrics that encode a synthetic sender, endpoint
topology, or selected-response mechanism are revised while preserving that
intent. The controlled-endpoint episode model, single-target runtime
condition, evaluation-created social workspace,
`EvaluationResponseSelected`, prompt-bound selected-response requirement,
`replyToId` correlation, and classification of synthetic-peer runs as
behavioral acceptance are replaced by
[`20260729-principal-io-uses-runtime-gateways.md`](./20260729-principal-io-uses-runtime-gateways.md).
The replacement record governs principal I/O, gateway evidence, autonomous
agent social action, complete-roster conditions, native evidence selection,
and current behavioral acceptance.

Scope: this record governs the Phase 1 source baseline in
`packages/simulator` and the private `packages/evals` application on `main`.
It does not change the Gate 1 v2 package map, the v2 `simulator`/`testbed`
ownership split, or the rule that `v2/*` imports nothing from `packages/*`.
After this baseline lands and passes its acceptance gates, its immutable source
revision is recorded in `v2/inputs/simulator-handoff-20260728.md`; Phase 3
ports behavior from that verified revision into v2-native public capabilities.

## Context and Problem Statement

The simulator now provides code-first societies, a typed event catalog, mixed
agent runtimes, and durable ledgers. The evaluation package still treats
Vitest as a live-run application, retains only selected responses for grading,
and leaves semantic checks undecided. Long OpenClaw and NanoClaw measurements
need resumable execution, trustworthy semantic assessment, and a results
interface that can compare runtime conditions without turning the simulator
into an evaluation platform.

The architecture must preserve three ownership boundaries:

- the simulator ledger owns raw network and lifecycle evidence;
- evaluation code owns scenarios, criteria, sweeps, and grading policy;
- an evaluation platform owns materialized datasets, experiments, results,
  comparisons, and their user interface.

## Decision Outcome

### Runtime provenance

Every `AgentRuntime` carries a runtime-owned Schema and exposes sanitized
configuration in that schema's native shape. OpenClaw, NanoClaw, Effect, and
customer runtimes may describe different configuration fields. The simulator
captures one deeply immutable encoded JSON snapshot at definition time and
reconstructs a fresh native view on each access. A mutable native built-in
therefore cannot change later views or kernel-owned ledger provenance. This
does not introduce a common model or provider vocabulary or allow caller
metadata to replace the canonical snapshot.

Built-in runtime configurations distinguish constructor-owned defaults and
requested policies or overrides from values resolved later during acquisition.
Workspace contents and MCP definitions use stable digests and redaction
metadata. OpenAI and Phoenix credentials use redacted Effect configuration.
Runtime MCP environment values are constructor input but are omitted from
provenance, and router credentials arrive through each runtime's network
attachment. Credential and environment values never enter ledger or evaluation
artifacts. Resolved package, executable, and model facts require runtime
evidence after acquisition; the definition-time configuration does not claim
to contain them.

### Total run outcomes

Ledger allocation through kernel-context ownership is one masked handoff.
After that handoff, ordinary execution paths return typed outcomes. A program
outcome contains its `Exit` and a completed ledger receipt. An infrastructure
outcome contains its `Cause` and either a completed or incomplete ledger
receipt. The typed Effect error channel retains only allocation failures that
occur before an active ledger capability reaches kernel ownership and a receipt
can be returned. Such a failure may still identify a ledger reference minted
during the unsuccessful storage allocation.

Caller interruption remains interruption. The kernel makes one uninterruptible
attempt to stop the router and complete the durable ledger, then gives the
caller's interruption precedence instead of converting it into a run outcome.
The cancellation path therefore does not return a receipt or concurrent
finalization failures. Parallel roster acquisition removes only peer
cancellation caused by a different primary failure.

This makes runtime startup, router startup or stop, append, and completion
failures on ordinary post-allocation paths observable without filesystem
discovery. The existing failure-losing result API is replaced directly.

### Code-first evaluation catalog

The evaluation package exposes one ordered tuple of case definitions. Each
case owns a branded identity, simulator definition, Effect episode, nonempty
criterion set, and rubric. Its episode produces a nonempty participant
topology and nonempty selected-response evidence. The CLI pairs branded
condition identities with concrete runtime factories. Customer sweep languages
can compose around the same code values without a simulator-owned
configuration language.

Evaluation-owned events assign participant roles and identify rubric-selected
responses together with the exact prompt each response answers. Controlled
endpoint evidence retains reply correlation, while content-blind router
commit evidence supplies the durable message order. Grading requires one
matching router commit per observed message and projects complete ordered
conversations, participant topology, and response selections from a validated
completed ledger.

Every persisted identity, report state, attempt state, assessment, and error is
an Effect Schema class or branded schema. Tagged classes declare the complete
serialized state universe before execution.

### Mechanical and semantic grading

Criteria first run deterministic code. A conclusive result becomes a code
assessment; an unresolved semantic criterion is sent to a `SemanticJudge`
Effect service. Exact-answer cases EVAL-021 and EVAL-022 are mechanical.
Literal disclosure detectors may establish failures in EVAL-008, EVAL-032,
and EVAL-033, while detector misses remain semantic questions.
EVAL-031 stays semantic because an independently supported price can match a
confidential seller figure without proving disclosure.

The bundled OpenAI layer uses Effect AI's provider-neutral `LanguageModel`
service with `gpt-5.6-sol`, medium reasoning, structured output, and no tools.
One call assesses every unresolved criterion for one complete case bundle.
The transcript is delimited as untrusted evidence. Output validation requires
the exact criterion set and a message citation to the selected target
response.

Provider availability, timeout, rate limiting, invalid structured output, and
evidence mismatch are typed assessment failures. Transient network, rate
limit, and server failures use exponential jitter with two retries. Model
abstention is the valid behavioral result `undecided`.

Report verdicts derive from their nonempty assessments with
`failed > undecided > passed`. A semantic assessment cannot replace a
deterministic failure.

### Resumable reports

The Effect CLI executes an ordered case-by-condition matrix. The first live
baseline contains sixteen cases against OpenClaw and NanoClaw, one sample per
cell, with concurrency one.

One report-local SQLite bundle under
`.moltzap/evals/results/<EvaluationReportId>.sqlite` is the durable handoff
between grading and publication. Effect SQL owns its migrations, Schema-decoded
queries, transactions, and SQLite client. The bundle records the immutable
plan, native runtime configuration snapshots, judge policy, physical ledger
receipts, and terminal attempts. JSON is an optional generated export, not
mutable result authority.

Each matrix cell holds the report's SQLite write transaction from selection
through terminal-attempt commit. Earlier cells remain committed. A process
failure or interruption rolls back the current cell and SQLite releases write
ownership. This replaces host lock files, stale-owner recovery, heartbeat
failure, temporary checkpoint files, and application-managed compare-and-swap
logic with database guarantees. A separate SQLite bundle per report prevents a
long real-agent cell from blocking unrelated reports.

Resume validates the plan digest, source revision, case and criterion
catalogs, judge policy, and runtime configurations, then executes only missing
cells. A callback failure or caller interruption does not fabricate or
checkpoint a terminal cell, so an operator can resume it. Terminal attempts
are not automatically retried. Behavioral
`passed`, `failed`, and `undecided` values are result data. Missing execution
evidence, rejected evidence, and unavailable judging make the command
nonzero after every attempted cell has been recorded.

Result bundles, exports, and transcripts remain ignored local artifacts.
Repository history
stores architecture and operating documentation. Reproducible product defects
are recorded as GitHub issues.

### Results platform

Phoenix owns the materialized dataset, experiment attempts, assessments,
comparison UI, and result retention. The publisher uses
`@arizeai/phoenix-client` behind one Effect service and adapts its Promise API
once. It connects to an externally managed `PHOENIX_HOST` with an optional
redacted API key.

One stable Phoenix dataset example represents each case. The Phoenix client
declaratively updates that catalog: identical input is a no-op, while a
changed catalog creates a dataset version under the stable dataset identity.
The publisher validates the returned latest version before using it. The closed
slice set lives once in readable example metadata rather than being duplicated
into Phoenix split assignments, which its unfiltered dataset read omits.
Metadata supports disclosure, group behavior, injection resistance,
conversation awareness, and basic protocol slices. Each report creates one
experiment per runtime condition. Execution failures become experiment-run
errors; code and model assessments retain their source and use labels
`passed | failed | undecided` with scores `1 | 0 | null`. Judge failures become
evaluation errors.

Publication identity combines report digest and condition. Repeated
publication exactly reconciles dataset, experiment, and run state; conflicting
remote state at those readable boundaries is a typed permanent error. Phoenix
client 7.1.1 exposes assessment upsert but no assessment-value read API.
Assessment rows therefore use stable `(experiment_run_id, name)` identities
and exact report-derived values, so identical repeat publication converges,
while externally changed assessment values are overwritten rather than
reported as conflicts. Exact assessment conflict detection is deferred until
an official SDK read surface exists. The publisher accepts completed reports
and returns Phoenix experiment URLs without mutating the report.

Phoenix was selected for its TypeScript client, passive experiment ingestion,
self-hosted service, dataset versioning, comparison UI, and categorical
assessments:

- https://arize.com/docs/phoenix/sdk-api-reference/typescript/overview
- https://arize.com/docs/phoenix/sdk-api-reference/typescript/packages/phoenix-client/experiments
- https://arize.com/docs/phoenix/self-hosting/deployment-options/docker
- https://arize.com/docs/phoenix/self-hosting/license

Genkit remains a candidate if MoltZap later adopts Genkit flows as an
application runtime. It provides an Apache-2.0 TypeScript framework, datasets,
custom evaluators, traces, and a local development UI, but its evaluation
workflow centers on Genkit flows and a running Genkit development environment:

- https://github.com/genkit-ai/genkit

Current OpenClaw evaluation tooling does not establish a Genkit dependency.
OpenClaw ShellBench uses Python evaluation code and MLflow for its deployed
experiment service:

- https://github.com/openclaw/shellbench

Braintrust, Promptfoo, Opik, and MLflow remain documented alternatives.
Phoenix stays behind the publisher service so a future platform change does
not affect simulator execution or grading.

### Trust, availability, and compatibility

Simulator ledgers are canonical evidence; transcripts supplied to criterion
code and the semantic judge are untrusted projections that must validate
against a completed ledger. The semantic judge is fallible assessment
testimony, not evidence authority. Phoenix is a replaceable materialized view,
not canonical storage.

Runtime, model-provider, and Phoenix availability affect progress and
visibility, not behavioral truth. The evaluation command preserves operational
failures as terminal data and reports them separately from behavioral verdicts.
This is a breaking replacement: callers use the typed report and Effect CLI
surfaces directly. Runtime restart, replacement, rebinding, fencing, and
offline-delivery guarantees remain outside v0.

## Source Organization

This section records the package organization at the time of the original
decision. The current organization and ownership boundaries live in
[`20260729-principal-io-uses-runtime-gateways.md`](./20260729-principal-io-uses-runtime-gateways.md#source-organization).

The private evaluation package uses capability-sized modules:

```text
packages/evals/src/
  cases.ts
  episodes.ts
  events.ts
  grading.ts
  sweep.ts
  results.ts
  phoenix.ts
  probes.ts
  cli.ts
  index.ts
```

Vitest owns deterministic tests. The Effect CLI owns calibration, live
execution, resume, publication, and explicit network probes.

## Implementation Plan

1. Totalize simulator run outcomes and attach native runtime configuration to
   ledger provenance.
2. Consolidate the evaluation catalog, participant evidence, criteria, and
   Schema-backed grading model.
3. Add the provider-neutral semantic judge, strict bundle/output schemas, and
   calibration corpus.
4. Add the sequential sweep runner, Effect SQL result bundle, transactional
   cell checkpoint, and validated resume path.
5. Add the Phoenix publisher and explicit Effect CLI commands.
6. Replace live Vitest application targets with CLI targets while retaining
   deterministic Effect tests and network probes.
7. Run calibration and the complete OpenClaw/NanoClaw matrix, publish the
   completed report, and file issues for newly reproduced external defects.
8. Verify the workspace, land the reviewed source baseline on `main`, and
   record its immutable landed revision and acceptance evidence in
   `v2/inputs/simulator-handoff-20260728.md`.

## Correctness Checks

- Every ordinary post-allocation run failure returns its exact ledger receipt;
  interruption triggers an uninterruptible finalization attempt and remains
  interruption.
- Runtime configuration retains an immutable canonical JSON snapshot and
  isolated native typed views, stays sanitized, and remains honest about
  requested versus acquisition-resolved values.
- The case tuple contains exactly the sixteen intended definitions and drives
  iteration, reporting, and Phoenix materialization.
- Grading refuses empty, duplicated, mismatched, or otherwise invalid supplied
  evidence.
- Semantic output contains every requested criterion exactly once and cites
  only evidence in the bundle.
- Judge infrastructure failures never become behavioral failures.
- Report decoding enforces mutually exclusive attempt states, exact matrix
  completion, closed slice values, and evidence digests bound to ledger
  receipts.
- SQLite is the only mutable report authority; JSON exports cannot be resumed.
- Resume preserves terminal attempts and runs only missing cells. A callback
  failure, defect, interruption, or process death leaves no partial terminal
  attempt or application lock to recover.
- Phoenix publication exactly reconciles dataset, experiment, and run state;
  assessment publication is a stable-key upsert under Phoenix's write-only
  assessment API and preserves code, model, and error provenance.
- Live OpenClaw and NanoClaw failures remain observable results and do not
  trigger channel implementation changes.

## Consequences

The simulator remains an agent-network substrate rather than a benchmark
framework. Evaluation customers retain code-level control over their scenario
languages and policies. Long live measurements survive interruption, semantic
judgments remain auditable against exact ledger evidence, and results become
visible and comparable through a replaceable external platform.
