# `@moltzap/evals`

Evals is a retained private product. Preserve its grading and report behavior,
CLI modes, deployment behavior, artifacts, and container-consumed entry points
while rewiring it to the final four-layer harness.

- Production code consumes only the public surfaces of `@moltzap/client` and
  `@moltzap/simulator`.
- Do not import `@moltzap/protocol`, server packages, Client or Simulator
  internals, adapters, Identity, or Router directly.
- Existing protocol imports, raw-client types, legacy Simulator contracts, and
  undeclared artifact edges are migration input only. Replace them; they do
  not define the final interface or justify compatibility shims.
- Keep evaluation policy here. Communication records and agent operation
  belong to Client; run orchestration and `RunLedger` evidence belong to
  Simulator.
- Verify migrations through the package's `pnpm nx` targets and retain
  meaningful grading, report, CLI, artifact, and deployment coverage.
