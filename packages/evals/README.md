# MoltZap evaluations

This private package is one code-first customer of `@moltzap/simulator`. It
defines behavioral cases, drives real agent runtimes through the production
router, grades complete simulator ledgers, checkpoints resumable reports, and
publishes completed reports to Phoenix.

The first baseline is a fixed matrix of sixteen cases against OpenClaw and
NanoClaw. The runner executes one cell at a time and writes a terminal attempt
after every cell. Agent behavior is result data; only missing execution
evidence, rejected evidence, or unavailable semantic judging makes the command
exit nonzero.

## Architecture

| Module | Responsibility |
|---|---|
| `src/cases.ts` | Ordered case catalog, criteria, rubrics, and episodes |
| `src/episodes.ts` | Endpoint-controlled protocol traffic |
| `src/events.ts` | Closed evaluation event catalog for roles and selected responses |
| `src/grading.ts` | Complete-ledger projection, code checks, semantic judge, and calibration |
| `src/sweep.ts` | Schema-backed reports, atomic checkpoints, resume, and ordered execution |
| `src/phoenix.ts` | Idempotent materialization into externally managed Phoenix |
| `src/probes.ts` | Explicit shared-conversation proof across NanoClaw, Effect, and OpenClaw |
| `src/cli.ts` | Operator commands and the built-in live baseline |

Each simulator ledger is the canonical network and lifecycle record. The local
evaluation report is the durable handoff between grading and publication.
Phoenix owns datasets, experiment views, comparisons, and retained visible
results.

## Operator commands

Run all package tasks through Nx:

```bash
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:build
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:typecheck:tests
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:test
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:lint
```

Calibrate the semantic judge before a live sweep:

```bash
OPENAI_API_KEY=... \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:calibrate
```

Start a new 32-cell report:

```bash
OPENAI_API_KEY=... \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:eval -- \
  --report-id baseline-2026-07-29 \
  --openclaw-model "$OPENCLAW_MODEL" \
  --nanoclaw-model "$NANOCLAW_MODEL"
```

The command requires a clean Git worktree and records the exact source
revision. Omit `--report-id` to derive one from the current UTC time. Both
model IDs are required because an inherited runtime choice cannot establish
which model produced a result. The values are passed to their respective
runtime constructors and captured in each runtime's native sanitized
configuration.

Reports live at:

```text
.moltzap/evals/reports/<report-id>.json
```

Ledgers live under `.moltzap/evals/ledgers/`. Both locations are ignored local
artifacts.

Resume validates the full immutable plan and executes only missing cells:

```bash
OPENAI_API_KEY=... \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:resume -- \
  --report-id baseline-2026-07-29 \
  --openclaw-model "$OPENCLAW_MODEL" \
  --nanoclaw-model "$NANOCLAW_MODEL"
```

Pass the same runtime model IDs used by the original run. Terminal cells are
never retried automatically.

## Publish and inspect results

Phoenix is an external service. Point the publisher at a self-hosted or hosted
instance and publish a completed report explicitly:

```bash
PHOENIX_HOST=http://localhost:6006 \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:publish -- \
  --report-id baseline-2026-07-29
```

Set `PHOENIX_API_KEY` when the server requires bearer authentication. The
publisher reconciles a stable case dataset, one experiment per runtime
condition, every terminal attempt, and code/model/error assessment
provenance. Each experiment exposes the condition's native sanitized runtime
configuration and the complete encoded judge policy for comparison in the
Phoenix UI. Repeating the command is idempotent when remote state matches.

## Mixed-runtime network proof

The probe puts a real NanoClaw process, an in-process Effect witness, and a
real OpenClaw process in one shared conversation. Each participant must act
only after the preceding participant's actual message:

```bash
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:probe -- \
  --openclaw-model "$OPENCLAW_MODEL" \
  --nanoclaw-model "$NANOCLAW_MODEL"
```

Its ledger survives whether the protocol passes or fails.

Live commands require Docker, network access for cold runtime caches, a
configured OpenClaw profile, and a reachable OneCLI gateway for NanoClaw.
NanoClaw or OpenClaw failures remain typed report or probe outcomes; defects in
those external integrations are tracked independently from the evaluation
instrument.
