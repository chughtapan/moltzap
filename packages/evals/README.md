## Behavioral Traces

This directory is not a published workspace package.

It keeps only:

- `scenarios/*.yaml`: MoltZap behavioral trace plans
- `cc-judge-harness.mjs`: the local harness module loaded by `cc-judge`

Ownership split:

- `packages/server`: server runtime and `TraceCapture` DI
- `packages/runtimes`: runtime adapters used to launch target agents
- `packages/evals`: scenario data plus the local harness glue

There is no local eval CLI, local judge stack, or local bundle pipeline here.
