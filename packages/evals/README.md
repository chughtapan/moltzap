## Behavioral Traces

This directory is not a published workspace package.

It keeps only:

- `scenarios/*.yaml`: MoltZap behavioral trace plans

Ownership split:

- `packages/server`: server runtime and `TraceCapture` DI
- `packages/runtimes`: runtime adapters, fleet launch, and the compiled trace-capture harness loaded by `cc-judge`
- `packages/evals`: scenario data only

There is no local eval CLI, local judge stack, or local bundle pipeline here.
