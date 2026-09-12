# Shared eval pilot

The pilot offers one Effect process boundary for the existing MoltZap,
propagation and SocietyCoordBench tools. It preserves their CLI and grader
semantics, records exact source revisions, streams logs to disk, and retains
failed attempts. It does not equate process success with a behavioral PASS.

Run `pnpm nx run @moltzap/evals:pilot -- --plan /absolute/path/plan.json`.
The authored plan is trusted executable configuration: review its command before
running it, especially for live model runs. Existing commands remain unchanged.

```json
{
  "suite": "propagation",
  "source": {
    "repository": "chughtapan/moltzap-bench",
    "revision": "FULL_40_CHARACTER_SHA",
    "root": "/path/to/clean/bench-checkout"
  },
  "operation": "grade",
  "executable": "python3",
  "args": ["release/grade.py", "/absolute/path/to/run"],
  "output": "/absolute/path/to/new-attempt"
}
```

Use `society-coord` with its Python environment and
`-m coordbench.harness evaluate --task TASK --calendars CALENDARS`. Its native
JSON remains the grade; its oracle is not translated to TypeScript.
Use `moltzap` with the native Nx eval target and a single selected case, or its
case tests for offline verification. The shared runner does not cache live runs.

A source root must be the clean Git checkout root at the declared revision. Output
must be a new directory outside that checkout. Each bundle retains the plan and
terminal receipt or failure; runner provenance is written to `runner.json` before
launching the native process, whose stdout/stderr are streamed to disk. Cancelled
runs exit nonzero and retain failure evidence. Before a live run, inspect the
suite's native dry-run or plan, supply its existing runtime prerequisites, and
limit it to one case/run and concurrency one. Do not run a full sweep as a smoke.

File completed bundles in docs-internal with `records artifact import` and verify
checksums there. Source credentials are not copied. Existing published evidence
is retained in its original repository. The first pilot integrates existing
entrypoints; package extraction follows demonstrated common behavior, not a new
universal suite abstraction.
