# MoltZap evaluations

This private package runs code-first behavioral evaluations over public
`@moltzap/client` and `@moltzap/simulator` contracts. The retained catalog
contains `EVAL-019`, which asks a target about its current conversations through
the runtime's native principal gateway. It does not create raw protocol peers,
interpret router traffic, or synthesize social-network evidence.

Each OpenClaw or NanoClaw matrix cell constructs a `RunSpec`, submits it through
the repository's local or GKE Simulator profile, validates completed ledger
artifacts, grades normalized gateway evidence, stores a resumable SQLite report,
and can publish the result to Phoenix.

## Source organization

| Module | Responsibility |
|---|---|
| `src/model.ts` | Evaluation identities and report vocabulary |
| `src/cases.ts` | Ordered native-gateway case, rubric, and criterion |
| `src/principal.ts` | Adapters over native target gateways |
| `src/events.ts` | Gateway event catalog and ledger projection |
| `src/execution.ts` | Cell `RunSpec` construction and result projection |
| `src/transcript.ts`, `src/assessment.ts`, `src/judge.ts`, `src/calibration.ts` | Evidence validation and grading |
| `src/sweep.ts`, `src/results.ts` | Immutable plans and resumable SQLite reports |
| `src/submission.ts`, `src/artifacts.ts` | Simulator submission and artifact retrieval |
| `src/phoenix.ts` | Completed-report publication |
| `src/cli.ts` | Operator configuration and commands |

## Verification

```bash
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:build
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:typecheck:tests
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:test
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:lint
```

Live runs require digest-pinned `MOLTZAP_CONTROLLER_IMAGE` and
`MOLTZAP_NANOCLAW_IMAGE` values, the selected Simulator profile's artifact
location and Temporal address, model credentials, and a clean committed
worktree. Run `eval`, `resume`, `calibrate`, or `publish` through the package's
Nx targets.

SQLite is the mutable report authority. Resume executes only cells missing from
an exactly matching plan. Completed Simulator artifacts remain the evidence
authority and are validated before grading.
