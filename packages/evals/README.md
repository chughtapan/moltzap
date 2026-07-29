# MoltZap evaluations

This private workspace package owns executable society programs, typed case
definitions, code graders, and the narrow `defineEvaluationSuite` builder.
Evaluation teams compose model, persona, environment, sweep, and reporting
policy around those code values.

`openClawEvaluations` runs the sixteen behavioral cases with OpenClaw.
`effectEvaluations` runs the same programs with an in-process Effect agent
that still communicates through the production MoltZap protocol.
`defineEvaluationSuite(runtime)` creates the cases for any customer runtime,
model, persona, or environment sweep.

Each case owns:

- a versioned `Simulator.define` definition with its complete typed event
  catalog;
- an Effect program that opens conversations, sends messages, and awaits
  target responses;
- eval-owned response-selection events that attach grading semantics to core
  network evidence;
- a reusable run Effect;
- a code grader over exact event streams from a validated completed ledger.

Platform resources are supplied once at the application boundary:

```ts
import { Duration, Effect } from "effect";
import { effectEvaluations } from "@moltzap/evals";
import { simulatorLayer } from "@moltzap/simulator";

const Platform = simulatorLayer({
  ledgerDirectory: "./eval-results",
  router: {
    startupTimeout: Duration.minutes(2),
  },
});

const evaluation = effectEvaluations.eval005;

const program = Effect.gen(function* () {
  const run = yield* evaluation.run;
  return yield* evaluation.grade(run.ledger);
}).pipe(Effect.provide(Platform));
```

Runtime constructors own model, workspace, installation, and readiness
configuration. The run Effect requires only the runtime's declared services
plus the router and ledger Layers.

The run result contains the customer program `Exit`. Ledger completion proves
durability and integrity; `ProgramSucceeded` separately proves the experiment
program succeeded. Graders refuse incomplete or unsuccessful evidence rather
than turning infrastructure failure into a behavioral score.

Every grading report contains at least one named check and derives its verdict
from those checks:

- `passed` means every check established its property;
- `failed` means at least one check established a violation;
- `undecided` means no check failed, but code did not establish every property.

Mechanical properties such as word limits and exact-answer prompts decide in
both directions. A scenario-specific detector can establish a direct
disclosure, but a miss stays `undecided` because the same information may be
paraphrased. Semantic checks also stay `undecided` until evaluation-owned
Effect code resolves them. Infrastructure refusal remains a typed error and is
never a behavioral verdict.

Reports include a versioned grader id, so regrading a durable ledger under new
code produces distinguishable evidence. Most bundled behavioral cases cannot
report `passed` from the mechanical tier alone; a final measurement requires
semantic grading code tested against known-good and known-bad responses.

Checks:

```bash
pnpm nx run @moltzap/evals:build
pnpm nx run @moltzap/evals:typecheck:tests
pnpm nx run @moltzap/evals:test
pnpm nx run @moltzap/evals:lint
```

## Live runtime measurements

The uncached `measure:live` target runs three live measurements serially:

1. A mixed-roster protocol measurement starts OpenClaw, NanoClaw, an Effect
   agent, and a customer-defined `defineRuntime` agent against one production
   router. Exact per-runtime replies establish readiness, delivery, durable
   router commits, customer selection, and program success.
2. A behavioral measurement runs the existing two-turn EVAL-021 episode
   independently against real OpenClaw and NanoClaw, opens each completed
   ledger, and grades it with the versioned code grader. Infrastructure
   success and a valid grading report are required; `passed`, `failed`, and
   `undecided` verdicts are all result data rather than test-runner verdicts.
3. A shared-conversation measurement puts OpenClaw, NanoClaw, and an Effect
   witness in one conversation for a verified arithmetic task. NanoClaw
   proposes the total without receiving the answer, the Effect runtime
   validates that exact message and only then generates an approval receipt,
   and OpenClaw returns the expected checksum with both the receipt and
   NanoClaw's actual message id. One typed customer event records the
   selection policy's consumed responses and either the selected sequence or
   the elapsed observation window. The report derives OpenClaw's expected and
   observed protocol reply target from that atomic measurement. Neither a
   behavioral miss nor a missing reply target becomes an infrastructure
   failure.

The mixed-roster and shared-conversation measurements require the
runtime-termination streams to remain empty. Scope cleanup is not autonomous
termination evidence, and a runtime that exits before the customer program
completes is an infrastructure failure.

```bash
pnpm nx run @moltzap/evals:measure:behavior
pnpm nx run @moltzap/evals:measure:conversation
pnpm nx run @moltzap/evals:measure:roster
pnpm nx run @moltzap/evals:measure:live
```

### Recorded live measurements — 2026-07-29

The sanitized grading reports, observed response sequences, ledger metadata,
completion digests, and incomplete-trial snapshot are committed in
[`evidence/2026-07-29-live.json`](./evidence/2026-07-29-live.json).

Real OpenClaw and NanoClaw each completed and were graded on EVAL-021. Both
returned `OK` followed by the exact answer `BANANA7`; the versioned
`moltzap.eval-021.grader/v1` report passed every check.

| Runtime | Ledger ref | Run id |
|---|---|---|
| OpenClaw | `9c9288da-3e43-41d3-9b16-6dae68ad44e5` | `32f78c29-e7a6-447c-a3c1-5067ed50a2d5` |
| NanoClaw | `a15cb23c-b8f2-41b0-947a-f838c7115ded` | `26002731-52d7-4aa8-a724-50006d59934c` |

The shared-conversation measurement completed the exact NanoClaw proposal →
Effect approval → OpenClaw final content sequence in one four-participant
conversation. Ledger `8913951a-6a76-473e-b300-9fce8b7cb059`, run
`428cb265-565f-4e20-9a16-4c129b808d1a`, contains 16 records. Its manifest and
record digests are
`94b7292b0799e4b3939fab2f3993063e07d2e0b4d0087604ebb0efc3959252a9`
and `e6b16b6d99d12a8b3d7767640ecc231391d9aca38f96b9ab4312f070dcc1e5cf`.
The OpenClaw reply target was observed as `null` rather than the witness
message id; [#904](https://github.com/chughtapan/moltzap/issues/904) tracks
that transport defect.

A complementary OpenClaw proposal → Effect approval → NanoClaw final trial
showed a second transport defect. Operator-observed runtime diagnostics showed
that NanoClaw generated the exact final response, but an earlier standby
response consumed the newer dispatch lease and the final response was not
delivered. Its incomplete ledger snapshot is
`e6427600-8745-45dd-9804-c6dff00f6709`; it has no completion artifact or
program terminal event.
[#903](https://github.com/chughtapan/moltzap/issues/903) records that result
and the required turn-correlation behavior.

This requires:

- a reachable Docker daemon;
- network access while the router and runtime caches are cold;
- model credentials in the operator OpenClaw profile;
- a local OneCLI gateway configured for NanoClaw.

Set `MOLTZAP_OPENCLAW_EVAL_MODEL` or `MOLTZAP_NANOCLAW_EVAL_MODEL` to override
the corresponding runtime's default model. The measurement targets do not read
or log credential contents.
