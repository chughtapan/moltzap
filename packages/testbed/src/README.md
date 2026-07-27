# Testbed source boundary

The source root owns connected-agent testbed orchestration and its runtime
adapters, and carries three named boundaries above them: `simulator/` (the
instrument), `grading/` (reading a sealed recording as evidence), and `cli/`
(operating the instrument from a terminal). Knowledge flows one way —
`cli/` → `grading/` → `simulator/` → the root's runtime contract — so the
root never imports from any of the three.

- `runtime.ts`, `errors.ts`, and the readiness and child-process modules define
  the shared runtime contract and lifecycle vocabulary.
- `openclaw-adapter.ts` and `nanoclaw-adapter.ts` are the named adapter
  boundaries. Their supporting modules own runtime installation, channel
  setup, package resolution, process supervision, and logs.
- `testbed.ts` owns coordinated startup, process-signal interruption, and
  reverse-order teardown across the selected runtime.
- The trace-capture modules form the evaluation harness that drives MoltZap
  through dynamically loaded client test modules.
- `simulator/` is the instrument: spec, launch, episode, log, recording, queue.
- `grading/` reads sealed recordings. `grader.ts` is the published `./grader`
  entry; the `cc-judge-*` adapters ship as its dist siblings rather than as
  export-map entries, so no consumer's name reaches the published surface.
- `cli/` is the `moltzap-testbed` verb tree, its document and exit-code
  vocabulary, and the scripted `demo` fixture.

The root `index.ts` curates the published package contract. Runtime-specific
wire behavior remains in the channel packages; only the trace-capture harness
drives MoltZap APIs directly.
