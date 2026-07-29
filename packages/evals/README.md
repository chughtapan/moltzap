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

Checks:

```bash
pnpm nx run @moltzap/evals:build
pnpm nx run @moltzap/evals:typecheck:tests
pnpm nx run @moltzap/evals:test
pnpm nx run @moltzap/evals:lint
```

## Full runtime evaluation

The gated integration target starts one production router and runs OpenClaw,
NanoClaw, an Effect agent, and a customer-defined `defineRuntime` agent backed
by an Effect handler in the same roster. One controlled endpoint completes a
protocol round trip with every runtime, then the test validates readiness,
delivery, durable router commits, customer selection, and program success. It
also requires the runtime-termination streams to remain empty: scope cleanup
is not autonomous termination evidence, and a runtime that exits before the
customer program completes fails the proof.

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
