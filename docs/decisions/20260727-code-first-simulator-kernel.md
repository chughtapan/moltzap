---
status: partially-superseded
date: 2026-07-27
decision-makers: Tapan Chugh
superseded-by: 20260729-principal-io-uses-runtime-gateways.md
---

# The simulator is code-first with a closed event catalog

Decision provenance: [stored code-first simulator trajectory](../decision-evidence/20260727-code-first-simulator-trajectory.md#code-first-simulator-closed-event-catalog), [stored principal-gateway trajectory](../decision-evidence/20260729-principal-runtime-gateway-trajectory.md#principal-io-uses-each-runtime-gateway), [source-gap report](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#simulator-provenance-source-gap), [Gate 1 simulator-system-driver trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-simulator-is-the-system-driver), [six-package trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-six-deep-packages-one-version), and [Router replacement trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#router-order-is-opaque).

## Supersession

The following scope remains current: the code-first TypeScript/Effect
approach; `Simulator.define`; an immutable closed typed EventCatalog;
the typed run-evidence RunLedger; a scoped runtime roster and lifecycle
kernel; Effect programs and services; customer-owned
scenario languages, sweeps, completion policy, and graders; and the
requirement that OpenClaw, NanoClaw, Effect, and custom runtimes use one
public stack without callback shortcuts.

For the v1 implementation, `20260729-principal-io-uses-runtime-gateways.md`
replaces the private-gateway and router-authentication readiness claims.
Successful acquisition exposes each runtime's exact principal gateway and
termination through the keyed roster alongside the router-issued agent handle.
Network identity remains distinct from runtime lifetime. A behavioral runtime
is ready only when its principal gateway and configured MoltZap capabilities
are usable. Experiment-controlled endpoints remain network participants for
probes and workloads, but do not represent a principal instructing an
autonomous agent. Synthetic-endpoint OpenClaw and NanoClaw runs are network
diagnostics rather than behavioral acceptance.

`20260728-simulator-is-the-system-driver.md` replaces the historical
single-package ownership and source-layout plan with the V2 simulator
as a system driver over public production capabilities and a separate
testbed package. `20260729-router-order-is-opaque.md` replaces
simulator-owned production Router state, public RouterSequence, and
legacy transport-facing types with the `router` package's opaque,
volatile L2 capability. `20260728-six-deep-packages-one-version.md`,
as partially superseded, and `docs/spec/layer-interfaces.md` own the
current package boundary. The accepted
`20260728-simulator-is-the-system-driver.md` record remains unchanged.

## Context and Problem Statement

The testbed simulator currently models scenarios, runtimes, schedules,
termination, network conditions, events, and graders through project-owned
schemas and YAML documents. That forces customer-specific policy into closed
unions, duplicates Effect's control-flow and resource abstractions, and makes
each new experiment vocabulary a simulator-core change.

The simulator should instead provide the reusable substrate for agentic
societies: real agent harnesses, the production MoltZap router, scoped network
capabilities, durable observations, validated opening, and typed analysis.
Customers own the code that defines scenario languages, parameter sweeps, and
grading policy.

## Decision Outcome

The simulator is a TypeScript and Effect library. Customers express scenario
languages, operator commands, completion policy, sweeps, and grading in code
around its network and ledger capabilities.

The simulator is published as one `@moltzap/simulator` package. It owns
definitions, the run kernel, network capabilities, the runtime contract, the
typed ledger, the MoltZap router host, filesystem storage, OpenClaw,
NanoClaw, Effect-agent, installation, and process-hosting implementations.
This makes `@moltzap/simulator` the sole simulator package and retires the
parallel `@moltzap/testbed` public API.

One simulator contains internal capability boundaries. Interface and kernel
modules depend on contracts; concrete implementations sit beside the
capabilities they implement. Every runtime participates in the same run
through the same router and protocol.

Effect Platform services remain the mechanism boundaries. The package
composition Layer provides the concrete Node implementations once at the
application edge. Source folders are named directly for the capabilities they
own: `network`, `runtime`, `ledger`, `events`, and `kernel`.

The evidence subsystem is called the ledger throughout. Live append, durable
storage, completion, validation, and offline analysis are one subsystem. The
public vocabulary is `RunLedger`, `LedgerRecord`, `LedgerRef`,
`LedgerCompletion`, and `openLedger`. Every producer and reader uses this
ledger model.

Each simulator definition declares its complete event universe before a run.
Events are versioned `Schema.TaggedClass` values. Core and customer event
catalogs compose into one immutable readable catalog whose mechanically
derived union is closed for that simulator definition. A separate writable
catalog contains only customer event classes. Exact declared classes are the
only event write, selection, and opening keys. Event catalogs are nominal
values, so their schemas, classes, and tags stay consistent.

Runtime factories own autonomous agent behavior and harness-process
mechanics. The kernel is the sole recorder of infrastructure observations;
scenario Effects record experiment observations through the definition-bound
customer-event service.

OpenClaw processes, NanoClaw processes, in-process Effect agents, and customer
code runtimes implement the same `AgentRuntime` contract.
Every runtime receives the same network identity, credentials, router
attachment, Scope, and readiness contract. In-process implementations use the
wire protocol and run-scoped router rather than a callback shortcut. Runtime
acquisition returns only after readiness, and the implementation owns any
runtime-specific startup deadline.

Roster keys are validated as protocol `AgentName` values once at roster
construction and carried through lifecycle evidence. The kernel does not
re-decode names during readiness, startup failure, or termination recording.
Process-backed runtimes share only a small observation helper for
readiness-versus-exit, redacted startup diagnostics, and platform-independent
termination evidence. Installation, configuration, launch, teardown, ports,
Docker, and workspaces remain owned by each runtime implementation.
Supervised process waits retain Effect Platform's branded exit code and typed
platform failure. A wait failure becomes an unavailable startup exit code or
`RuntimeFailed` termination evidence; teardown treats either fiber outcome as
process completion without inventing a signal or sentinel value.

The runtime contract carries the router attachment used by every participant.
External harness management listeners remain private implementation
resources; router-observed authentication is the single readiness condition
shared by every runtime. The shipped OpenClaw and NanoClaw constructors
acquire their processes directly through `AgentRuntime.acquire`. Process and
installation resources serve those constructors rather than forming another
public runtime layer.

OpenClaw requires a positive private gateway port and does not accept an
OS-selected port or inherited listener. Its host-process implementation asks
Effect's platform socket server for an available loopback port, releases that
probe before process launch, and retains a process-local logical claim through
startup so sibling runtimes cannot select the same candidate. The gateway
address never enters runtime input, roster handles, router capabilities, or
ledger events. Atomic cross-process listener handoff requires future OpenClaw
support for port zero or socket activation; cross-process port claims remain
an OpenClaw host concern.

Port probing keeps external cancellation outside the listener-acquisition
handoff while preserving interruptibility inside Effect Platform's own
startup-versus-error race. A concurrent runtime acquisition failure therefore
cannot strand the temporary listener or delay run teardown.

Node implementations use Effect Platform resources and Effect SQL schemas at
their boundaries. Database rows decode directly into the protocol's branded
identity types; hand-written row normalization and Promise-shaped storage APIs
do not become simulator abstractions. The server exposes the exact PGlite data
directory as a nominal `MessageDatabasePath`, so a volume root cannot reach the
SQL reader. A library that is natively Promise-based is adapted once inside its
driver resource. One `CommittedRouterMessage` schema class is shared by the
router stop report, SQL decoder, and ledger event, and its `RouterSequence` is
branded rather than represented as an interchangeable number.

The production server's public stop Effect succeeds only after container stop
is confirmed and the database is safe to open. Observer cleanup warnings do
not create a false router-stop failure or discard valid traffic evidence;
scope release retries remaining cleanup. The private ownership state machine
retains partial states only where teardown needs them.

Network identity and process lifetime are distinct. In v0 each roster identity
binds once to its declared runtime. A runtime exit leaves that identity
offline, records an exact typed ledger event, and does not determine the run
outcome. Customer Effect policy decides whether the run continues or
terminates. The v0 lifecycle surface covers one binding per identity; restart,
replacement, rebinding, session fencing, and offline-delivery guarantees are
stretch goals.

The simulator definition binds the catalog to live execution and ledger
opening. A completed ledger stores the exact versioned catalog; typed opening
requires the matching code catalog. Event schema evolution uses a new
versioned tag and historical ledgers retain their historical catalog.

Programs are Effects. Program completion determines run completion, and code
uses `Clock`, `Schedule`, `timeout`, `race`, `Deferred`, Streams, and scopes for
timing, coordination, and link outages. Run-scoped Effect services expose the
exact roster handles, network, readable ledger, and customer-event writer.
Layers supply the router factory, ledger storage, Node integrations, and
runtime-specific requirements at the outer boundary. Services expose Streams
rather than registering callbacks or forking consumer fibers. Programs choose
when and how to run, combine, and supervise those Streams.

Graders are ordinary functions over validated typed ledgers. Sweep
concurrency, retries, case matrices, and customer scenario languages remain
outside simulator core.

## Public Boundary

`Simulator.define` accepts a versioned definition id and zero or more nominal
customer event catalogs. It includes the kernel's core events automatically
and returns definition-bound Effect service tags plus catalog-bound `run` and
`openLedger` operations.

The run scope provides:

- an exact keyed roster service containing the acquired agent handles;
- a network service for experiment-controlled endpoints, conversation
  addresses, endpoint-bound conversation sockets, and directed links;
- a readable ledger service whose `events(EventClass)` selects one exact
  declared class and whose `records` stream contains every committed
  envelope;
- a customer-event service whose `emit` accepts only the definition's customer
  event classes.

Conversations address any nonempty set of network participants. A conversation
socket is that address bound to one endpoint. Autonomous runtimes and
experiment-controlled endpoints are both network participants, but only
runtimes are roster-declared and lifecycle-managed.

Infrastructure records use producer-bound kernel capabilities. Customer code
receives its definition-bound event writer, while the kernel holds the
core-event writers.

An authorized producer's typed event is the event the ledger commits. The
ledger validates the exact class, serializes it, decodes the serialized bytes,
and only then appends durably. Run options cannot rewrite whole events between
construction and commit because such a hook could reclassify kernel evidence,
not merely hide a field. Sensitive-data policy belongs in typed event
construction or behind the storage boundary.

Programs that manipulate link state require a `LinkController` service in
their Effect environment. The application provides physical down/up control at
its composition boundary. A link-using program therefore makes its
`LinkController` requirement explicit in its Effect environment.

`run` is the only execution entry point. It owns ledger allocation, one
run-scoped router, the mixed runtime roster, endpoint and link resources,
teardown, router evidence collection, and ledger completion in one internal
scope. The kernel composes failures with Effect `Exit` and `Cause`; it does not
reconstruct causes from booleans, optionals, or arrays of strings. Interruption
uses owned, bounded cleanup and never leaves daemon cleanup mutating a
completed run.

`@moltzap/simulator` exports the customer experiment and shipped-runtime API,
a `./network` router-authoring surface, and the `./ledger` storage and offline
surface. Nominal participant identities and router stop reports can only be
constructed through network-boundary factories; the customer-facing
capability classes expose no constructors. These three entry points are the
complete public package boundary.

## Source Organization

Folders represent capabilities with multiple independently meaningful
implementations or state machines. They are not namespaces. A type and its
construction rules stay together, a service tag stays with the capability it
names, and a kernel file sequences capabilities without redefining their
models. Single-consumer helper files are merged into their owner.

The package uses this shape:

```text
packages/simulator/src/
  index.ts
  network.ts
  ledger.ts
  definition.ts
  layer.ts
  events/
    catalog.ts
    core.ts
  network/
    participant.ts
    conversation.ts
    endpoint.ts
    router.ts
    link.ts
    moltzap.ts
    server.ts
    server-image.ts
    message-store.ts
  runtime/
    runtime.ts
    roster.ts
    effect.ts
    command.ts
    process.ts
    workspace.ts
    packages.ts
    cache.ts
    openclaw/
      runtime.ts
      process.ts
      cache.ts
    nanoclaw/
      runtime.ts
      process.ts
      install.ts
      onecli.ts
  ledger/
    model.ts
    storage.ts
    live.ts
    open.ts
    filesystem.ts
  kernel/
    event-services.ts
    run.ts
    outcomes.ts
    runtimes.ts
    endpoints.ts
    links.ts
    router.ts
```

Cross-runtime installation or process code stays in `runtime/` only when both
runtime families use the same invariant. Runtime-specific ports, workspaces,
installation, launch, and teardown stay within that runtime's folder.
Identity registration uses `@moltzap/client/auth` rather than a simulator
copy. `layer.ts` is the only file that provides the concrete Node service
graph; mechanism files declare Effect Platform requirements instead of
providing `NodeContext` locally.

Server-image scripts, server-image contents, and bundled NanoClaw assets live
at the `packages/simulator/` package root beside the source that owns them.

## Implementation Plan

1. Capture the moving worktree baseline and preserve the existing correctness
   suite while changing structure.
2. Consolidate the nominal event catalog, ledger, network, runtime, kernel,
   router host, filesystem storage, and shipped runtime implementations in
   `@moltzap/simulator`, then delete `@moltzap/testbed`.
3. Replace the parallel live and offline evidence machinery with the ledger.
   Validate and serialize each producer's original typed event before append:
   append acknowledgement means durable, subscribers receive the decoded
   committed value, failed appends are invisible and latched, and every
   sequence is contiguous.
4. Split the readable core-plus-customer catalog from the writable
   customer-only catalog. Replace structural catalog inputs and string-selected
   writers with nominal, producer-bound capabilities.
5. Make the scoped `AgentRuntime` acquisition contract the only runtime
   implementation path. Move model, workspace, installation, startup,
   readiness, process diagnostics, and termination into the relevant runtime
   constructor; delete the lower-level adapter contract and migrate its tests
   to runtime-owned resource tests.
6. Move the MoltZap router, PGlite traffic, filesystem ledger, process,
   OpenClaw, and NanoClaw implementations beside their capability contracts in
   `@moltzap/simulator`. The kernel consumes Effect services and never
   concrete Node resources.
7. Make router acquisition provide endpoint transports and a stopped-router
   evidence capability. Remove raw volume paths, duplicate registration HTTP,
   and production database rows from the kernel.
8. Migrate eval programs and graders to the Effect-service API and exact-class
   ledger selection. Keep scenario builders, sweep matrices, terminal policy,
   graders, and reports in customer code.
9. Replace manual resource, timer, stream, shutdown, and supervision machinery
   with stable Effect primitives. Repeat altitude reviews after every vertical
   slice and remove impossible states before handling them.
10. Run the complete code-first suite with mixed runtimes, then use full
    OpenClaw and NanoClaw evaluations as final design measurements.

Each stage must remain typecheck- and test-green before the old layer it
replaces is deleted.

## Recorded Evidence

The current four-runtime surface passed
`pnpm nx run @moltzap/evals:measure:roster --skip-nx-cache` under Node.js 24.18.0
on 2026-07-28. Its roster contains OpenClaw, NanoClaw, an in-process
`effectRuntime` agent, and a customer-defined `defineRuntime` agent backed by
an Effect handler. All four runtimes became ready and returned nonempty
protocol replies through one production router. Every selected reply had
durable router evidence, the customer program produced one successful
completion event, and no autonomous runtime terminated before the program
completed.

The completed ledger has run id `17a80309-e4b0-4a63-92bc-b8ceaf46010d` and
31 records. Its manifest digest is
`852980bd44d3ffa9599ab214f98ea48cc17154c54e7033811239fbdb5f237931`; its
record digest is
`bf0604558013d57b41229a09b3d5de54bec4467ab3404831c32ae52eb47c1e2d`.

## Correctness Checks

- Undeclared event classes cannot be emitted, selected, written, or opened
  from a completed ledger.
- Kernel event services are the sole infrastructure-event writers; runtime
  factories return lifecycle capabilities.
- Customer event services accept the definition's exact customer classes;
  core event writers remain kernel-bound.
- Event catalogs accepted by definitions are nominal and internally
  consistent.
- Duplicate or unversioned event tags and ledger/catalog mismatches fail.
- Public `emit` accepts only customer events and records producer identity
  `program`; callers cannot claim an infrastructure producer.
- `events(EventClass)` yields payloads of that exact declared class, while
  `records` yields every committed envelope.
- Concurrent producers persist one contiguous sequence.
- Live events equal the producer's validated event decoded from persisted
  bytes; run options cannot transform event truth, and failed appends never
  appear.
- Late and racing subscribers receive complete history and a gapless tail
  exactly once without backpressuring the writer.
- Startup races, partial acquisition, interruption, parallel teardown,
  teardown precedence, traffic collection, completion-record tampering, and
  scoped link-outage overlap have explicit tests.
- Link-using programs require an explicitly provided `LinkController`; no
  no-op or unavailable controller is installed by `run`.
- OpenClaw, NanoClaw, Effect, and custom code runtimes work together
  against the production router without adding simulator-core event variants.
- Runtime exit is ledger evidence and does not become kernel termination
  policy.
- Run-scope teardown cannot create runtime-exit evidence, and a runtime whose
  termination Effect never completes cannot delay router shutdown or ledger
  completion.
- Simulator interface, definition, event, ledger-model, network-contract,
  runtime-contract, and kernel modules depend only on Effect and protocol
  contracts. Concrete capability leaves and `layer.ts` own Node, Docker,
  PGlite, OpenClaw, NanoClaw, filesystem, and client implementations.
- Every eval is a code-defined program and grader, including EVAL-005 through
  the same public simulator surface.

## Consequences

Adding an event means defining a class and composing a new simulator
definition, not editing the kernel. A process cannot introduce an event class
after its run starts. Generic tooling may inspect ledger provenance without
decoding events, but typed evidence access always requires the matching
catalog.

The initial kernel uses wall-clock time because it drives external harness
processes.
Topology, latency/loss/bandwidth, workloads, probes, societal-layer models, and
counterfactual runs can be added as typed classes and scoped capabilities
without recreating a universal serialized scenario language. The design is
accepted only after the same code-first evaluation runs end to end with full
OpenClaw and NanoClaw agents.

Live ledger catch-up and endpoint conversation inboxes retain their run-local
history in memory, and completed-ledger opening materializes one ledger before
typed analysis. That is an explicit v0 scale boundary, not part of the public
model. Production-router traffic collection also materializes committed
message projections in v0. Large virtual-time societies require a
streamed/chunked router-evidence drain, storage-backed cursors, and bounded,
observable ingress buffers behind the same `RunLedger`, `Network`, and
`ConversationSocket` capabilities. A hard timeout for embedded PGlite close
would require isolating that drain in a killable worker because PGlite exposes
no cancellation signal.
