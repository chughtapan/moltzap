# @moltzap/simulator

Code-first simulator for agentic societies.

## Boundary

This package owns:

- nominal, schema-bound `RunSpec` definitions and exact keyed container
  rosters;
- closed `Agent.container` descriptors, logical Secret references, and typed
  runtime bridges;
- the exact readable event catalog and customer-only writable catalog;
- the live and completed ledger contract;
- durable execution bindings, outcomes, receipts, module artifacts, and
  independently resolvable ledger references;
- network participant, endpoint, conversation-address, socket, and link
  capabilities;
- the private generation-aware run kernel and internal fake backend;
- the Kubernetes, Kueue, Agent Sandbox, and Temporal implementations;
- the non-replacing controller, finalizer, artifact authority, run-scoped v1
  router/server, and exact owner-first cleanup;
- local kind and GKE cluster profiles, the CLI, deployment assets, Nx targets,
  and simulator controller/worker/support images; and
- generic, OpenClaw, and NanoClaw container bridge implementations on the
  existing `./runtime` facade.

`packages/evals` owns only its cases, peer policy/application image and bridge
configuration, grading, reports, SQLite state, and Phoenix publication. It is
a consumer of the same execution path, not a platform implementation.

Definition, event, ledger-model, network-contract, runtime-bridge-contract,
and kernel modules import only Effect and protocol contracts. They contain no
Kubernetes, Kueue, Agent Sandbox, Temporal, Helm, Terraform, cloud-provider,
or Docker types. Private concrete capability files may import Effect Platform,
Node, the official Kubernetes client, Temporal SDKs, and the MoltZap
client/server packages. Composition occurs at CLI, controller, worker, and
test application edges; no public Layer selects a second execution engine.

## Laws

- One execution binding has one source/input/roster/profile identity, one
  Temporal Workflow, one RunLedger, one non-replacing controller, one
  run-scoped v1 router/server, and one exact container roster.
- Kubernetes is the only real distributed backend. Docker supports image
  builds, kind, and the local registry only. Unit tests use the private fake.
- One roster key is one stable AgentId and direct Sandbox with one application
  container. Infrastructure Pods do not count as agents.
- One aggregate Kueue Workload admits the complete homogeneous roster before
  any Sandbox. Kueue admission is logical quota, not physical gang scheduling.
- A generation changes when backing Pod UID or application-container restart
  count changes. Generation loss invalidates readiness immediately.
- The program starts only after the exact current-generation barrier and its
  immediate recheck. The durable dispatch fence permits at most one invocation
  attempt. Pre-dispatch loss reacquires; post-dispatch replacement never
  replays the program, active call, turn, subscription, or volatile cursor.
- Controller loss is terminal. Temporal finds the same controller or cleans
  deterministic resources; it never replaces the controller, runs customer
  code, or appends simulator records.
- The controller seals records and exits. The Temporal finalizer deletes and
  verifies run-owned resources, writes cleanup/proof artifacts, and only then
  publishes completion. Success requires confirmed zero run-owned residue.
- Every event class is declared before the run. The definition's exact catalog
  is the complete event universe for emission, selection, and typed opening.
- Core events are readable and kernel-only writable. Customer emission accepts
  only the definition's customer event classes.
- Event catalogs and network handles are nominal values.
- Infrastructure writers are producer-bound capabilities; callers never pass
  an emitter string.
- `RunSpec` input/result/failure boundaries use strict context-free Effect
  Schemas with finite JSON encodings. Customer `execute` has no Effect
  requirements.
- Every real participant, including a deterministic eval peer, is a container
  using its native typed bridge and the same production protocol/router path.
  Controlled endpoints remain probes, not agent principals.
- Agent descriptors expose only a digest image, typed bridge, positive numeric
  resources, run-scoped or ephemeral state, and exact Secret references. They
  expose no process or platform escape hatch.
- Secret bytes enter one owning slot through one immutable read-only Secret
  volume. Simulator-owned manifests, CLI JSON, ledgers, logs, and proof
  collection do not intentionally serialize them.
- The root API has one real path: `Run.execute(RunSpec,
  Infrastructure.kubernetes(...))`. Do not preserve executable
  `simulator.define(...).run(...)`, `simulatorLayer`, host `AgentRuntime`, or
  in-process runtime aliases.

## Structure

- `src/events/` — exact event catalogs and core event classes.
- `src/ledger/` — records, live ledger, storage ports, authority-aware opening,
  legacy filesystem reading, and artifact validation.
- `src/network/` — participant, conversation, endpoint, router, transport,
  link-driver, MoltZap router, server, message store, and nominal
  capability-construction contracts.
- `src/runtime/` — nominal container bridge contracts and generic, OpenClaw,
  and NanoClaw bridge implementations.
- `src/kernel/` — platform-free lifecycle, generations, exact barrier,
  dispatch fence, evidence, and record sealing.
- `src/platform/` — private backend normal form and Kubernetes/Kueue/Sandbox
  implementation.
- `src/orchestration/temporal/` — private one-Workflow orchestration,
  observation, finalization, and cleanup.
- `src/controller/` — one in-cluster trusted customer-program executor.
- `src/artifacts/` — source bundles, execution bindings, outcomes, proof
  bundles, and storage authority.
- `src/cli/` — module loader, commands, JSON output, signals, and exit mapping.
- `src/definition.ts` — `RunSpec` and `Agent` public definition assembly.
- `src/execution.ts` — `Infrastructure`, `Run`, public outcomes, errors, and
  receipts.
- `deploy/` and `images/` — local/GKE installation and published simulator
  images.

Only `src/index.ts`, `src/runtime.ts`, `src/network.ts`, and `src/ledger.ts`
are published facades. Programs use the root and `./runtime`; protocol/router
implementations use `./network`; offline and legacy tooling uses `./ledger`.
Do not export platform, orchestration, controller, artifact-authority, kernel,
or provider lifecycle modules.

Folders are capability boundaries, not namespaces. Keep a type with its
construction rules and merge single-consumer helpers into their owner. Do not
add compatibility barrels or preserve obsolete export names.

Capability names form the directory vocabulary. Keep one backend-normal-form
contract and two declarative profiles. Do not duplicate lifecycle state across
Kubernetes, Temporal, the controller, or the CLI.

## Tests

Use Nx targets from the workspace root:

```bash
pnpm nx run @moltzap/simulator:build
pnpm nx run @moltzap/simulator:typecheck:tests
pnpm nx run @moltzap/simulator:lint
pnpm nx run @moltzap/simulator:test
```

Type-level invariants belong in positive `*.types-check.ts` canaries.
