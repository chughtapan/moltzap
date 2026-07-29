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

## Full runtime evaluation

The gated integration target owns three distinct acceptance results:

1. A mixed-roster protocol proof starts OpenClaw, NanoClaw, an Effect agent,
   and a customer-defined `defineRuntime` agent against one production router.
   Exact per-runtime replies prove readiness, delivery, durable router commits,
   customer selection, and program success.
2. A behavioral measurement runs the existing two-turn EVAL-021 episode
   independently against real OpenClaw and NanoClaw, opens each completed
   ledger, and grades it with the versioned code grader. Infrastructure
   success and successful grading are acceptance conditions; the observed
   behavioral verdict is result data rather than a test-runner verdict.
3. A shared-conversation proof puts OpenClaw, NanoClaw, and an Effect witness
   in one conversation. OpenClaw contributes a workspace-private value, the
   Effect runtime acknowledges that exact message, and NanoClaw must reply to
   the witness with the derived consensus value. A typed customer event binds
   the three message identities and reply edges in the completed ledger.

The mixed-roster and shared-conversation proofs also require the
runtime-termination streams to remain empty. Scope cleanup is not autonomous
termination evidence, and a runtime that exits before the customer program
completes fails the proof.

```bash
pnpm nx run @moltzap/evals:test:agents
```

This requires:

- a reachable Docker daemon;
- network access while the router and runtime caches are cold;
- model credentials in the operator OpenClaw profile;
- a local OneCLI gateway configured for NanoClaw.

Set `MOLTZAP_OPENCLAW_EVAL_MODEL` or `MOLTZAP_NANOCLAW_EVAL_MODEL` to override
the corresponding runtime's default model. The gate does not read or log
credential contents.
