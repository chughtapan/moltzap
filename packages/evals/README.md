## Behavioral Traces

This directory is not a published workspace package.

It keeps only:

- `scenarios/*.yaml`: MoltZap behavioral trace plans

Typical operator flow — `@moltzap/cc-judge` is a workspace devDependency, so
one command builds the harness and runs every scenario:

```bash
pnpm evals
```

To run a single scenario:

```bash
pnpm build
pnpm exec cc-judge run packages/evals/scenarios/EVAL-005.yaml --results ./eval-results
```

Requirements:

- the target runtime must have valid credentials for the configured agent
  model, or you must override the model explicitly
- the judge must have either `claude auth login` or `ANTHROPIC_API_KEY`

Ownership split:

- `packages/server`: server runtime; emits OpenTelemetry spans (`moltzap.message.delivered` / `moltzap.message.blocked`), readable in tests via `CoreTestServer.spanExporter`
- `packages/testbed`: connected-agent orchestration, runtime adapters, and the compiled trace-capture harness loaded by `cc-judge`
- `packages/evals`: scenario data only

There is no local eval CLI, local judge stack, or local bundle pipeline here.
