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
- Runtime subjects receive MCP or an injected `HarnessEndpoint`. Never give a
  runtime Registry admission material, endpoint signing keys, raw Router
  credentials, Router attachment capabilities, endpoint stores, or protocol
  internals.
- The injected Client sends only to explicit `agent:` or `group:` addresses
  with durable host idempotency and emits addressed direct or group deliveries.
  Send returns `void` after local certification. Search, history, status,
  registration, and proof inspection stay on MCP. Simulator evidence may
  observe public effects but cannot obtain `ActionHash`, `RecordHash`,
  certificates, or private recovery state from `HarnessEndpoint`.
- Social traffic uses the same Identity, Router, and Client implementation as
  production. Code agents receive no shortcut around endpoint certification,
  durability, catch-up, or personal trust.
- With no active directed link fault, the Simulator preserves each
  recipient's Router order and exact message bytes. An explicitly activated
  fault may drop, delay, hold, or reorder post-Router delivery to test
  endpoint recovery. Evidence from that path is fault-tolerance evidence, not
  Router-conformance evidence.
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
  compatibility engine, generation selector, runtime-facing or
  general-purpose gateway proxy, command language, actor mailbox, synthetic
  identity scheme, or serialization framework.

Legacy `@moltzap/protocol`, `@moltzap/server-core`, adapter imports, socket
types, and runtime-facing direct Router fixtures are removal inputs. New code
must not deepen those edges. Simulator's private run-scoped infrastructure may
provision the public Router process and capability required by the final graph;
runtime subjects still receive only Client. Extract retained meaning behind
final public capabilities, then delete the legacy dependency rather than
hiding it behind an alias.

## Fault boundary

Directed link faults interpose privately after Router has accepted and ordered
a message and before the recipient Client consumes it. The run controller owns
policy evaluation; private run-scoped infrastructure applies the result. The
interposition must not modify or forge a `SignedMessage`, change Router state,
or add a callback to Registry, Router, Client, or `moltzapd`.

When no fault is active, the path is a transparent pass-through. Application
containers receive no fault-control endpoint, credential, environment value,
mount, raw network capability, or store access. Fault activation and lifecycle
may be Simulator evidence, but `RunLedger` never records a private Router
position or authoritative Router order.

## Five admitted removals

The current four-layer decision removes these incompatible contracts. Delete
them directly; do not preserve them through a semantic shim or reinterpret an
old name or persisted event:

1. Delete content-free conversation open. First explicit addressed send creates
   or reuses deterministic fixed membership and includes nonempty content.
2. Delete unaddressed or inherited-target send. Every visible output names an
   `agent:` or `group:` address through the host's native messaging path.
3. Replace message-only receive and proof-shaped operation results with public
   addressed delivery and `void` completion facts.
4. Remove bearer credentials, signing material, raw Router attachment,
   Registry/Router origins, and endpoint-store handles from runtime inputs. A
   runtime receives only its loopback MCP URL or an injected `HarnessEndpoint`.
5. Delete persisted events that claim durable Router commit or Router-local
   order. `RunLedger` records only simulation lifecycle and public semantic
   effects.

An inert credential field, lazy first-send translation, cached reply closure,
hidden raw Router path, or new meaning under an existing event tag is not
compatibility. The normative cutover contract is
`docs/spec/layer-interfaces.md → Simulator cutover`; the five removals are
current decisions rather than deliberate deferrals.

## Structure during migration

- `src/events/` owns exact simulation evidence and event catalogs.
- `src/ledger/` owns simulation `RunLedger` records, storage, reads, and the
  `./ledger` public barrel at `src/ledger/index.ts`.
- `src/run/` owns definition-bound execution sequencing.
- `src/cluster/` owns private acquisition, fakes, Kubernetes, Kueue, Sandbox,
  and Temporal mechanisms.
- `src/agents/` owns portable runtime definitions, typed principal gateways,
  and the `./agents` public barrel at `src/agents/index.ts`.
- `src/network/` owns the compatible experiment-facing contracts and the
  `./network` public barrel at `src/network/index.ts`. It is transitional where
  it still exposes any of the five admitted removals. Do not add public
  authority there; delete those contracts and move compatible production-stack
  composition behind Identity, Router, and Client as the cutover proceeds.

Only `src/index.ts`, `src/agents/index.ts`, `src/network/index.ts`, and
`src/ledger/index.ts` own the current published facades. Publication/version
policy is separately deferred; do not add or remove a facade merely to answer
it.

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
they do not create negative imports for deleted APIs or force a removed
contract through a fake compatible type.
