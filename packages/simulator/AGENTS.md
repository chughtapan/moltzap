# @moltzap/simulator

Extends the workspace-root `AGENTS.md`. This package is the one final
production-stack driver and run-evidence owner. Its current implementation is
also migration input: preserve compatible public behavior, but do not expand a
legacy protocol, server, adapter, or raw-Router dependency.

## Current boundary

The final package consumes public `@moltzap/identity`, `@moltzap/router`, and
`@moltzap/client` capabilities. It owns:

- `RunSpec`, `Run.execute`, and the definition-bound run kernel;
- exact agent rosters and runtime-native principal gateways;
- the closed event catalog and customer event declarations;
- live and completed simulation `RunLedger` evidence;
- production-stack acquisition, fault control, and run-scoped fixtures;
- local-Kubernetes and GKE execution through Kubernetes, Kueue, Agent
  Sandbox, and Temporal; and
- the compatible root, `./network`, `./ledger`, and `./agents` facades.

`RunLedger` records simulation configuration, events, and outcomes. It is not a
product Ledger, conversation store, durability certificate, global offset, or
privileged view of endpoint-private history.

`@moltzap/evals` owns cases, runtime conditions, grading, reports, resume
policy, application state, and Phoenix publication. It consumes Client and the
one simulator execution path; it does not implement another production stack.

Root workspace tooling owns multi-package image and artifact assembly. Do not
create runtime `simulator -> evals`, `simulator -> openclaw-channel`, or
`simulator -> nanoclaw-channel` edges by reading another package's source.

## Cutover law

- Preserve every latest-`main` public declaration and behavior that is
  compatible with the four-layer constitution. Freeze all four packed facade
  inventories and downstream compile/runtime probes before internal rewiring.
- Runtime subjects receive MCP or an injected `HarnessClient`. Never give a
  runtime Registry admission material, endpoint signing keys, raw Router
  credentials, Router attachment capabilities, endpoint stores, or protocol
  internals.
- Social traffic uses the same Identity, Router, and Client implementation as
  production. Code agents receive no shortcut around endpoint certification,
  durability, catch-up, personal trust, or bound reply authority.
- Keep infrastructure types out of public definitions, event models, and
  customer Effects. Concrete cluster integration stays private and composes at
  the application edge.
- One execution creates one society, invokes one customer Effect, records
  typed evidence, and tears the society down. It is not a warm pool and does
  not replay customer code.
- A roster entry maps to one autonomous application container. Infrastructure
  containers are not agents. Runtime-specific controller bridges expose only
  that runtime's typed principal gateway and termination observation.
- Event classes are declared before execution. Core events are run-only
  writable; customers may emit only declared customer events. Producer-bound
  writers carry attribution without caller-supplied emitter names.
- Temporal owns coarse run lifecycle and cleanup only. It does not run agent
  logic, append endpoint history, create per-agent workflows, or replay a
  customer Effect.
- Preserve `Run.execute(RunSpec)` as the one execution path. Do not add a
  compatibility engine, generation selector, simulator-wide gateway proxy,
  command language, actor mailbox, synthetic identity scheme, or serialization
  framework.

Legacy `@moltzap/protocol`, `@moltzap/server-core`, adapter imports, socket
types, and direct Router fixtures are removal inputs. New code must not deepen
those edges. Extract retained meaning behind final public capabilities, then
delete the legacy dependency rather than hiding it behind an alias.

## Five blocked contracts

Do not change, preserve through a semantic shim, or reinterpret these
authority-bearing contracts until a separately admitted decision selects their
replacement and any persisted-evidence migration:

1. conversation open without initial content and a certified START result;
2. generic established-conversation send;
3. message-only receive/results without certified record evidence and bound
   reply authority;
4. bearer credentials or raw Router attachment exposed to runtimes; and
5. persisted events that claim a durable Router commit or Router-local order.

An inert credential field, lazy first-send translation, cached reply closure,
hidden raw Router path, or new meaning under an existing event tag is not
compatibility. Work that reaches one of these boundaries stops and points to
`v2/VISION.md → Deliberate deferrals` and
`docs/spec/layer-interfaces.md → Simulator compatibility gate`.

## Structure during migration

- `src/events/` owns exact simulation evidence and event catalogs.
- `src/ledger/` owns simulation `RunLedger` records, storage, and reads.
- `src/run/` owns definition-bound execution sequencing.
- `src/cluster/` owns private acquisition, fakes, Kubernetes, Kueue, Sandbox,
  and Temporal mechanisms.
- `src/agents/` owns portable runtime definitions and typed principal gateways.
- `src/network/` is transitional where it exposes the five blocked contracts.
  Do not add public authority there; move compatible production-stack
  composition behind Identity, Router, and Client as the cutover proceeds.

Only `src/index.ts`, `src/agents.ts`, `src/network.ts`, and `src/ledger.ts` are
current published facades. Publication/version policy is separately deferred;
do not add or remove a facade merely to answer it.

## Tests

Run targets through Nx from the workspace root:

```bash
pnpm nx run @moltzap/simulator:build
pnpm nx run @moltzap/simulator:typecheck:tests
pnpm nx run @moltzap/simulator:lint
pnpm nx run @moltzap/simulator:test
```

Preserve unit, integration, local/GKE, Temporal, cluster, fault, packaging, and
eval-facing behavior for compatible contracts. Type canaries pin what remains;
they do not create negative imports for deleted APIs or force a blocked
contract through a fake compatible type.
