# MoltZap evaluations

This private package is one code-first customer of `@moltzap/simulator`. It
defines behavioral cases, runs mixed societies through the production router,
grades durable ledger evidence, stores resumable reports, and publishes
completed results to Phoenix.

The bundled baseline pairs sixteen cases with OpenClaw and NanoClaw target
conditions. Every society also contains autonomous in-process Effect peers.
The target receives principal instructions through its runtime-native gateway;
all target-to-peer and peer-to-target traffic uses the same MoltZap protocol
and router.

## Execution model

```text
principal
   │
   ├── OpenClaw RPC ──────── OpenClaw target ─┐
   └── NanoClaw socket ───── NanoClaw target ─┤
                                              ├── production router
case-owned Effect peers ──────────────────────┘
              │
              └── observation gateways

closed event catalog ── ledger ── transcript ── criteria / judge
                                         │
                                         └── SQLite report ── Phoenix
```

A native gateway output says what a runtime returned to its principal. A
router commit says what an agent did on the social network. Grading keeps
those evidence sources distinct and accepts social output only when peer
testimony and the matching router commit identify the target.

## Source organization

| Module | Responsibility |
|---|---|
| `src/model.ts` | Branded identities and shared evaluation vocabulary |
| `src/cases.ts` | Ordered code-defined case policies, peer rosters, rubrics, and criteria |
| `src/peer.ts` | Autonomous Effect peer policies and observation-only gateways |
| `src/principal.ts` | Evaluation-local adapters over native runtime gateways |
| `src/events.ts` | Complete evaluation event catalog and ledger projection |
| `src/execution.ts` | Mixed-roster acquisition and bounded case execution |
| `src/grading.ts` | Transcript validation, deterministic checks, semantic judging, and calibration |
| `src/sweep.ts` | Immutable plans, terminal attempts, reports, and state transitions |
| `src/results.ts` | Report-local Effect SQL persistence and transactional resume |
| `src/phoenix.ts` | Idempotent materialization into externally managed Phoenix |
| `src/cli.ts` | Operator configuration and commands at the application edge |

This package is a private executable application rather than a customer
library. Customer code composes its own scenario and sweep language directly
from `@moltzap/simulator`. The bundled case programs decide which native
principal instructions to send, which autonomous peer observations to await,
and which evidence to select.

## Adding a behavioral case

1. Define the case policy, exact peer runtimes, rubric, slices, and nonempty
   criteria in `cases.ts`.
2. Reuse a peer policy or add an autonomous policy in `peer.ts`. Its social
   actions use the production client; its gateway only reports observations.
3. Add any new evidence class to `events.ts` before the simulator definition
   is constructed.
4. Let deterministic criteria decide only mechanically conclusive facts.
   Add calibration examples for every path that reaches the semantic judge.
5. Test both accepted evidence and the relevant rejection boundary.

## Verification

Run package tasks through Nx with the repository Node version:

```bash
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:build
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:typecheck:tests
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:test
mise x node@24.18.0 -- pnpm nx run @moltzap/evals:lint
```

Calibrate the full semantic-judge path before a live sweep:

```bash
OPENAI_API_KEY=... \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:calibrate
```

Start the ordered 32-cell OpenClaw/NanoClaw report:

```bash
OPENAI_API_KEY=... \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:eval -- \
  --report-id baseline-2026-07-29 \
  --openclaw-model "$OPENCLAW_MODEL" \
  --nanoclaw-model "$NANOCLAW_MODEL"
```

The command requires a clean worktree and records the exact source revision.
Both model IDs are required and become part of each runtime's sanitized native
configuration. Omit `--report-id` to derive one from the current UTC time.

Result bundles live at
`.moltzap/evals/results/<report-id>.sqlite`; run ledgers live under
`.moltzap/evals/ledgers/`. SQLite is the mutable report authority. Each matrix
cell is committed atomically, and resume executes only cells missing from an
exactly matching plan:

```bash
OPENAI_API_KEY=... \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:resume -- \
  --report-id baseline-2026-07-29 \
  --openclaw-model "$OPENCLAW_MODEL" \
  --nanoclaw-model "$NANOCLAW_MODEL"
```

Behavioral `passed`, `failed`, and `undecided` verdicts are report data.
Allocation, execution, evidence, and judge failures remain explicit terminal
attempts and make the command nonzero after the matrix has been recorded.

Publish a completed report to a self-hosted or managed Phoenix instance:

```bash
PHOENIX_HOST=http://localhost:6006 \
  mise x node@24.18.0 -- pnpm nx run @moltzap/evals:publish -- \
  --report-id baseline-2026-07-29
```

Set `PHOENIX_API_KEY` when required. Repeated publication reconciles the stable
case dataset, one experiment per condition, and every report attempt before
returning the Phoenix experiment URLs.

Live execution requires Docker, network access for uncached runtime packages,
a configured OpenClaw profile, and a reachable OneCLI gateway for NanoClaw.
Runtime failures stay visible in the report.
