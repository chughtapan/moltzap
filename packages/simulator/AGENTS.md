# @moltzap/simulator

Code-first simulator for agentic societies.

## Boundary

This package owns:

- nominal simulator definitions and keyed agent rosters;
- the exact readable event catalog and customer-only writable catalog;
- the live and completed ledger contract;
- network participant, endpoint, conversation-address, socket, and link
  capabilities;
- the scoped `AgentRuntime` contract;
- the private run kernel;
- the MoltZap router host and filesystem ledger;
- Effect, OpenClaw, and NanoClaw runtime implementations;
- the process, installation, and package assets those implementations require.

Interface, definition, event, ledger-model, network-contract,
runtime-contract, and kernel modules import only Effect and protocol
contracts. Concrete capability files may import Effect Platform, Node, Docker,
PGlite, the MoltZap client/server packages, and external agent packages.
`layer.ts` provides the concrete host service graph once at the application
edge.

## Laws

- One run has one router, one ledger, one Effect `Clock` environment, and any
  mixture of runtime implementations.
- Runtime acquisition returns only after readiness. Runtime exit is typed
  ledger evidence; customer Effect policy decides whether it ends the run.
- Every event class is declared before the run. The definition's exact catalog
  is the complete event universe for emission, selection, and typed opening.
- Core events are readable and kernel-only writable. Customer emission accepts
  only the definition's customer event classes.
- Event catalogs and network handles are nominal values.
- Infrastructure writers are producer-bound capabilities; callers never pass
  an emitter string.
- In-process and customer-defined code runtimes use the same protocol and
  router as external processes.
- Restart, replacement, rebinding, fencing, and offline-delivery guarantees
  are outside v0.
- Kernel resources are scoped Effect acquisitions. Cleanup fibers remain
  children of the run scope and finish before run completion.

## Structure

- `src/events/` — exact event catalogs and core event classes.
- `src/ledger/` — records, live ledger, storage port, opening, and filesystem
  implementation.
- `src/network/` — participant, conversation, endpoint, router, transport,
  link-driver, MoltZap router, server, message store, and nominal
  capability-construction contracts.
- `src/runtime/` — roster, autonomous runtime contracts, and shipped runtime
  implementations.
- `src/kernel/` — definition-bound event services, private acquisition,
  execution, evidence, and finalization.
- `src/definition.ts` — public definition assembly.
- `src/layer.ts` — the single concrete host composition boundary.

Only `src/index.ts`, `src/network.ts`, and `src/ledger.ts` are
published facades. Programs use the root; platform implementations use
`./network`; offline tooling uses `./ledger`. Do not export kernel
implementation modules.

Folders are capability boundaries, not namespaces. Keep a type with its
construction rules and merge single-consumer helpers into their owner. Do not
add compatibility barrels or preserve obsolete export names.

Capability names form the directory vocabulary. Concrete implementations live
beside the capability they implement. Mechanism modules require Effect
Platform services; `src/layer.ts` provides their Node implementations.

## Tests

Use Nx targets from the workspace root:

```bash
pnpm nx run @moltzap/simulator:build
pnpm nx run @moltzap/simulator:typecheck:tests
pnpm nx run @moltzap/simulator:lint
pnpm nx run @moltzap/simulator:test
```

Type-level invariants belong in positive `*.types-check.ts` canaries.
