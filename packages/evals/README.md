# MoltZap evaluations

This private package is a code-first customer of `@moltzap/simulator`. It
defines behavioral cases, runs mixed OpenClaw and NanoClaw societies through
the simulator's Kubernetes path, grades durable ledger evidence, stores
resumable SQLite reports, and publishes completed results to Phoenix.

The bundled baseline pairs sixteen cases with OpenClaw and NanoClaw target
conditions. Each matrix cell constructs one case-specific `RunSpec` and submits
it through either the repository's local kind profile or its GKE profile. Case
peers run as autonomous application containers. Target-to-peer and
peer-to-target traffic uses the production MoltZap protocol and router.

## Execution model

```text
evaluation sweep
      │
      └── generated per-cell RunSpec
                    │
                    ├── local kind ─┐
                    └── GKE ────────┴── Temporal controller
                                                           │
                               OpenClaw / NanoClaw target ──┤
                               case-owned peer containers ──┴── router
                                                           │
                                            completed ledger artifacts
                                                           │
                                  transcript ── criteria / judge
                                                           │
                                         SQLite report ── Phoenix
```

A native gateway output says what a target runtime returned to its principal.
A router commit says what an agent did on the social network. Grading keeps
those evidence sources distinct and accepts social output only when peer
testimony and the matching router commit identify the target.

Kubernetes, Kueue, Agent Sandbox, and Temporal objects stay outside case
programs. The generated module injects the controller-owned infrastructure
layer, while the case owns only its target runtime, peer plans, deadlines, and
evidence policy.

## Source organization

| Module | Responsibility |
|---|---|
| `src/model.ts` | Branded identities and shared evaluation vocabulary |
| `src/cases.ts` | Ordered case programs, peer definitions, rubrics, and criteria |
| `src/peer.ts` | Closed peer plans, container descriptors, and observation gateways |
| `src/peer-application.ts` | Peer-container entrypoint and result bridge |
| `src/principal.ts` | Evaluation-local adapters over native target gateways |
| `src/events.ts` | Complete evaluation event catalog and ledger projection |
| `src/execution.ts` | Cell `RunSpec` construction, case execution, and result projection |
| `src/submission.ts` | Generated module and local/GKE submission boundary |
| `src/artifacts.ts` | Exact local or Cloud Storage ledger-artifact retrieval |
| `src/transcript.ts`, `src/assessment.ts`, `src/judge.ts`, `src/calibration.ts` | Evidence validation and grading pipeline |
| `src/sweep.ts` | Immutable plans, terminal attempts, reports, and state transitions |
| `src/results.ts` | Report-local SQLite persistence and transactional resume |
| `src/phoenix.ts` | Completed-report publication boundary composed by the CLI |
| `src/cli.ts` | Operator configuration and commands at the application edge |

This package is an executable application, not a customer library. Other
customers compose their own scenario and sweep language directly from
`@moltzap/simulator`.

## Adding a behavioral case

1. Define the case program, exact peer definitions, rubric, slices, and
   nonempty criteria in `cases.ts`.
2. Reuse a closed peer plan or add one in `peer.ts`. Its container uses the
   production protocol client; its controller gateway reports observations
   only.
3. Add new evidence classes to `events.ts` before constructing the `RunSpec`.
4. Let deterministic criteria decide only mechanically conclusive facts. Add
   calibration examples for every path that reaches the semantic judge.
5. Test accepted evidence and the relevant rejection boundaries.

## Static verification

Run package tasks through Nx with the repository Node version:

```bash
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:build
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:typecheck:tests
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:test
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:lint
```

These checks validate the generated modules, peer bridge, artifact identities,
ledger projection, grading, SQLite resume, and Phoenix behavior. They do not
run or qualify a live local or GKE society.

Calibrate the semantic judge separately:

```bash
OPENAI_API_KEY=... \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:calibrate
```

## Running a report

Run and resume require a clean, committed worktree. The report plan records the
exact source revision, model IDs, runtime configuration, profile, controller
and application images, Temporal address, ledger-artifact location, and one
attempt per case-condition cell. Both images below must be immutable lowercase
`@sha256:<64 hex>` references:

- `MOLTZAP_SUPPORT_IMAGE` contains the evaluation peer application and is used
  for every case-owned peer container. The repository-built controller image
  satisfies this contract and may be used for both controller and support.
- `MOLTZAP_NANOCLAW_IMAGE` is the distinct NanoClaw application image that
  implements the shipped NanoClaw container entrypoint and gateway contract.

Create the local cluster with an absolute artifact directory as described in
the [local simulator profile](../simulator/local/README.md), then pass that same
directory to the evaluation process:

```bash
OPENAI_API_KEY=... \
ANTHROPIC_API_KEY=... \
MOLTZAP_CONTROLLER_IMAGE=CONTROLLER_AT_SHA256 \
MOLTZAP_SUPPORT_IMAGE=CONTROLLER_AT_SHA256 \
MOLTZAP_NANOCLAW_IMAGE=NANOCLAW_AT_SHA256 \
MOLTZAP_LOCAL_ARTIFACTS="$PWD/.moltzap/local-artifacts" \
MOLTZAP_TEMPORAL_ADDRESS=127.0.0.1:7233 \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:eval -- \
  --profile local \
  --report-id baseline-2026-08-04 \
  --openclaw-model "$OPENCLAW_MODEL" \
  --nanoclaw-model "$NANOCLAW_MODEL"
```

For GKE, use the [GKE simulator profile](../simulator/gke/README.md), push the
controller/support image to its registry, authenticate `gcloud` for artifact
readback, and provide the selected cluster and retained bucket:

```bash
OPENAI_API_KEY=... \
ANTHROPIC_API_KEY=... \
MOLTZAP_KUBE_CONTEXT=EXPLICIT_KUBE_CONTEXT \
MOLTZAP_GKE_ARTIFACT_BUCKET=ARTIFACT_BUCKET \
MOLTZAP_TEMPORAL_ADDRESS=TEMPORAL_HOST:7233 \
MOLTZAP_CONTROLLER_IMAGE=REGISTRY/CONTROLLER@sha256:DIGEST \
MOLTZAP_SUPPORT_IMAGE=REGISTRY/CONTROLLER@sha256:DIGEST \
MOLTZAP_NANOCLAW_IMAGE=REGISTRY/NANOCLAW@sha256:DIGEST \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:eval -- \
  --profile gke \
  --report-id baseline-2026-08-04 \
  --openclaw-model "$OPENCLAW_MODEL" \
  --nanoclaw-model "$NANOCLAW_MODEL"
```

Omit `--report-id` on `eval` to derive one from the current UTC time. Result
bundles live at `.moltzap/evals/results/<report-id>.sqlite`. Completed ledger
artifacts remain owned by the selected simulator profile:

```text
local: {MOLTZAP_LOCAL_ARTIFACTS}/{namespace}/ledger/{ledgerRef}/{artifact}
GKE:   gs://{MOLTZAP_GKE_ARTIFACT_BUCKET}/{namespace}/ledger/{ledgerRef}/{artifact}
```

Each completed ledger contains `manifest.json`, `records.ndjson`, and
`completion.json`. The evaluation process retrieves those exact artifacts and
validates them against the case catalog, definition, receipt, record sequence,
and digests before grading.

Resume uses the same profile, images, models, and artifact authority:

```bash
OPENAI_API_KEY=... \
ANTHROPIC_API_KEY=... \
MOLTZAP_CONTROLLER_IMAGE=CONTROLLER_AT_SHA256 \
MOLTZAP_SUPPORT_IMAGE=CONTROLLER_AT_SHA256 \
MOLTZAP_NANOCLAW_IMAGE=NANOCLAW_AT_SHA256 \
MOLTZAP_LOCAL_ARTIFACTS="$PWD/.moltzap/local-artifacts" \
MOLTZAP_TEMPORAL_ADDRESS=127.0.0.1:7233 \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:resume -- \
  --profile local \
  --report-id baseline-2026-08-04 \
  --openclaw-model "$OPENCLAW_MODEL" \
  --nanoclaw-model "$NANOCLAW_MODEL"
```

SQLite is the mutable report authority. Each truthful terminal cell commits
atomically, and resume executes only cells missing from an exactly matching
plan. Allocation and controller failures become explicit terminal attempts.
After a completed receipt exists, unavailable or invalid artifacts become an
`EvidenceRejectedAttempt` so the receipt is retained and the society is not
silently rerun. A submission failure before any truthful receipt rolls back the
cell for a later retry. Judge unavailability is also recorded explicitly.

Behavioral `passed`, `failed`, and `undecided` verdicts remain report data.
Operationally incomplete reports return nonzero only after every terminal
attempt that can be recorded has been committed.

## Publishing

Publish a completed report to a self-hosted or managed Phoenix instance:

```bash
PHOENIX_HOST=http://localhost:6006 \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:publish -- \
  --report-id baseline-2026-08-04
```

Set `PHOENIX_API_KEY` when required. Repeated publication reconciles the stable
case dataset, one experiment per condition, and every report attempt before
returning the Phoenix experiment URLs.

This repository has static coverage for both profiles. It does not claim that
a live local or GKE evaluation has completed successfully.
