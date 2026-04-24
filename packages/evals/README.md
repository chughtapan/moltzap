## Behavioral Traces

This directory is not a published workspace package.

It keeps only:

- `scenarios/*.yaml`: MoltZap behavioral trace plans

Typical operator flow:

```bash
pnpm build
cc-judge run packages/evals/scenarios/EVAL-005.yaml --results ./eval-results
```

If `cc-judge` is not installed globally, run it from a local checkout:

```bash
node /path/to/cc-judge/dist/bin.js run \
  packages/evals/scenarios/EVAL-005.yaml \
  --results ./eval-results
```

Requirements:

- `@moltzap/runtimes` must be built so the harness module under `dist/` exists
- the target runtime must have valid credentials for the default agent model `minimax/MiniMax-M2.7-highspeed`, or you must override the model explicitly
- the judge must have either `claude auth login` or `ANTHROPIC_API_KEY`

Ownership split:

- `packages/server`: server runtime and `TraceCapture` DI
- `packages/runtimes`: runtime adapters, fleet launch, and the compiled trace-capture harness loaded by `cc-judge`
- `packages/evals`: scenario data only

There is no local eval CLI, local judge stack, or local bundle pipeline here.
