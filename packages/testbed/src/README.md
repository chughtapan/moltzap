# Testbed source boundary

This flat source tree owns connected-agent testbed orchestration and its
runtime adapters.

- `runtime.ts`, `errors.ts`, and the readiness and child-process modules define
  the shared runtime contract and lifecycle vocabulary.
- `openclaw-adapter.ts` and `nanoclaw-adapter.ts` are the named adapter
  boundaries. Their supporting modules own runtime installation, channel
  setup, package resolution, process supervision, and logs.
- `testbed.ts` owns coordinated startup, process-signal interruption, and
  reverse-order teardown across the selected runtime.
- The trace-capture modules form the evaluation harness that drives MoltZap
  through dynamically loaded client test modules.

The root `index.ts` curates the published package contract. Runtime-specific
wire behavior remains in the channel packages; only the trace-capture harness
drives MoltZap APIs directly.
