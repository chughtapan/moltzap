# @moltzap/simulator

Code-first simulator for agentic societies.

## Boundary

This package owns:

- `RunSpec` definitions and `Run.execute`;
- exact keyed agent rosters and runtime-native gateways;
- the closed readable event catalog and customer-only writable catalog;
- live and completed run ledgers;
- network participant, endpoint, conversation, socket, and link capabilities;
- the private run and the private fake cluster used by tests;
- the Kubernetes, Kueue, Agent Sandbox, and Temporal integration used by that
  run; and
- local-Kubernetes and GKE Effect Layers plus their setup assets.

`packages/evals` owns cases, runtime conditions, grading, reports, resume
policy, SQLite state, and Phoenix publication. It consumes this package's one
execution path and does not implement another simulator backend.

Keep Kubernetes, Kueue, Agent Sandbox, Temporal, Helm, Terraform, and
cloud-provider types out of public definitions, event models, network
contracts, and customer Effects. Concrete integrations stay private and are
composed at the application edge.

## Laws

- One execution creates one experiment society, runs one customer Effect, and
  tears the society down. It is not a reusable warm pool.
- Kubernetes is the only execution backend. Local Kubernetes and GKE are two
  cluster Layers for the same controller and run path.
- One roster entry maps to one Agent Sandbox application container.
  Infrastructure containers do not count as agents.
- Kueue admits capacity for the complete roster before Sandboxes are created.
  Kueue admission does not establish simulator readiness.
- The customer Effect starts only after the exact roster is ready at one
  cohort gate. A pre-gate backing-Pod restart delays readiness without adding a
  public generation model. An unrecoverable loss or deadline fails acquisition
  and starts cleanup.
- The controller invokes the customer Effect once and does not replay it.
  Controller or infrastructure loss fails the run and starts cleanup; this is
  not an exactly-once guarantee for external side effects.
- After dispatch, runtime termination remains typed ledger evidence. Customer
  Effect policy decides whether that observation ends the run.
- Temporal owns one coarse workflow for run lifecycle and cleanup. It never
  runs agent logic, appends simulator evidence, creates per-agent workflows,
  or replays customer code.
- Every event class is declared before execution. The definition's catalog is
  the complete event universe for emission, selection, and typed opening.
- Core events are readable and run-only writable. Customer emission accepts
  only the definition's declared customer event classes.
- Event catalogs and network handles are nominal values. Infrastructure
  writers are producer-bound capabilities; callers never pass emitter names.
- Principal control uses each runtime's native typed gateway. Agent social
  traffic uses the production MoltZap router. Controlled endpoints remain
  diagnostics and must not impersonate an autonomous agent's principal.
- A distributed runtime descriptor owns one application-container entrypoint
  and one runtime-specific controller bridge. The bridge yields that runtime's
  exact gateway and termination observation after readiness; arbitrary
  JavaScript gateways, Effect closures, and shared state never cross the
  process boundary.
- Runtime bridges may use fixed runtime-specific transports. Never add a
  simulator-wide gateway proxy, command language, actor mailbox, correlation
  model, or gateway union.
- Real and code-driven agents may share one society. Code agents receive no
  social shortcut around the production router. Their policy runs inside
  their own application container and their bridge exposes only the exact
  controller-side gateway owned by that runtime.
- The stock digest-pinned OpenClaw image is the compatibility path. Experiment
  code and instructions are late-bound; a prebuilt MoltZap image is only an
  optimization.
- `RunSpec.cluster` carries the selected local-Kubernetes or GKE Effect Layer.
  Its roster and customer Effect never receive raw Kubernetes, Sandbox, Kueue,
  or Temporal objects.
- Do not add generation streams, customer-visible restart/rebind/rejoin APIs,
  post-dispatch recovery guarantees, customer Effect replay, artifact
  authorities, global execution identities, synthetic identity schemes, or a
  new serialization framework.
- The root public execution path is `Run.execute(RunSpec)`. Do not add another
  execution model or compatibility alias.

## Structure

- `src/events/` — exact event catalogs and core event classes.
- `src/ledger/` — records, append, storage, reading, and filesystem
  implementation.
- `src/network/` — participant, conversation, endpoint, router, transport,
  link, and router-server-process capabilities.
- `src/agents/` — portable container runtime definitions, exact gateway
  contracts, and shipped OpenClaw and NanoClaw implementations.
- `src/run/` — definition-bound services and mechanism-neutral execution
  sequencing.
- `src/cluster/` — private cluster code: the smallest interface needed by the
  run, its fake, and the Kubernetes/Kueue/Sandbox/Temporal implementation.
- `src/definition.ts` — public definition assembly, including `RunSpec`.

Only `src/index.ts`, `src/agents.ts`, `src/network.ts`, and `src/ledger.ts`
are published facades. Do not add a package or public export for cluster,
controller, Temporal, Kueue, or Sandbox internals.

Folders are capability boundaries, not namespaces. Keep a type with its
construction rules and merge single-consumer helpers into their owner. Reuse
the existing EventCatalog, RunLedger, roster, gateway, and run concepts
instead of rebuilding them for Kubernetes.

## Tests

Use Nx targets from the workspace root:

```bash
pnpm nx run @moltzap/simulator:build
pnpm nx run @moltzap/simulator:typecheck:tests
pnpm nx run @moltzap/simulator:lint
pnpm nx run @moltzap/simulator:test
```

Type-level invariants belong in positive `*.types-check.ts` canaries.
