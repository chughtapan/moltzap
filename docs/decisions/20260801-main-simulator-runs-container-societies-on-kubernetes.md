---
status: partially-superseded
date: 2026-08-01
decision-makers: Tapan Chugh
superseded-by: 20260827-addressed-messaging-replaces-openfloor.md
---

# The main simulator runs container societies on Kubernetes

Decision provenance: [stored main-track trajectory](../decision-evidence/20260801-main-kubernetes-society-execution-trajectory.md#main-simulator-runs-container-societies-on-kubernetes), with the retained [code-first simulator](../decision-evidence/20260727-code-first-simulator-trajectory.md#code-first-simulator-closed-event-catalog) and [principal-gateway](../decision-evidence/20260729-principal-runtime-gateway-trajectory.md#principal-io-uses-each-runtime-gateway) trajectories.

## Supersession

`RunSpec`, `Run.execute`, one Kubernetes execution path with local and GKE
profiles, exact runtime gateways, closed events, RunLedger evidence, failure
semantics, and non-conflicting public facades remain the final simulator
preservation baseline. The simulation RunLedger is not the removed product
Ledger and remains owned by `@moltzap/simulator`.

`20260827-addressed-messaging-replaces-openfloor.md` retains the four-layer
record's seven-package cutover and resolves the runtime social interface as
explicit addressed send and addressed inbound delivery through Client. It
continues to remove content-free open, raw Router authority, and persisted
Router-commit/order evidence without an inert or lazy compatibility shim. The
replacement record and `docs/spec/layer-interfaces.md` own the cutover scope;
this record continues to own its retained execution contract.

## Scope and authority

This decision governs the production v1 simulator on `main`, implemented in
`packages/simulator`, and the way `packages/evals` executes experiments through
that simulator. It does not change `v2/*`, the v2 package map, or any v2
normative contract.

The checked-in source-event trajectories are the requirements boundary for
this slice. The outcome below contains only choices made in those conversations
or the minimum mechanics required to connect them. Anything else is a
non-goal, listed explicitly below.

## Context and Problem Statement

The v1 simulator already provides code-first Effect programs, a closed typed
event catalog, mixed runtime rosters, runtime-native principal gateways, one
production router, and a durable run ledger. Its concrete host Layer starts
local processes and Docker containers. A separate example proved that two
OpenClaw containers can join the original simulator, but an example-only
Docker path is not the core simulator and cannot exercise the requested
Kubernetes cohort.

Experiments need one core path that can run the same society on a local
Kubernetes cluster or GKE. The selected stack is Kubernetes, Kueue, Agent
Sandbox, and Temporal. The first useful proof is a small complete society,
then a larger cohort and real evaluations; the earlier 1,000–10,000-agent goal
is deferred until that path works.

## Decision Outcome

### The public model is `RunSpec` and `Run.execute`

An experiment exports one code-first `RunSpec`. It declares the versioned
definition id, closed customer event catalogs, exact keyed runtime roster, and
the customer `execute` Effect. `Run.execute(spec)` is the only new execution
entry point.

```ts
export const runSpec = RunSpec.define({
  id: "acme.echo/v1",
  events: [echoEvents],
  agents: { alice, bob },
  cluster: localKubernetes,
  execute: ({ agents, events, network, ledger }) =>
    Effect.gen(function* () {
      // Instruct agents through their native gateways, observe the society,
      // and return when this experiment is complete.
    }),
});
```

The example receives already-constructed runtime descriptors and an Effect
Layer. It does not select new constructor names for either one.

The `cluster` field contains either the local-Kubernetes or GKE Effect Layer.
It selects the host without exposing Kubernetes, Kueue, Agent Sandbox, or
Temporal objects to the roster or customer Effect. Moving a society between
profiles changes that Layer, not its agents, events, or `execute` program.

This is a small facade over the existing simulator concepts, not a second
simulation model. The existing closed event catalog, typed ledger, exact keyed
gateway roster, network capabilities, Effect failure model, and customer-owned
completion policy remain current. Runtime-specific gateway types remain exact;
the simulator does not add a universal gateway union.

The old `simulator.define(...).run(...)` host entry point is transitional. It
is removed after `packages/evals` and the local/GKE acceptance runs use
`RunSpec` and `Run.execute`; that removal has since happened, and neither the
entry point nor the Docker example remains in the tree. There is no supported Docker execution backend or
compatibility facade after cutover. Docker may still build images and support a
local Kubernetes cluster.

### Container runtimes preserve exact native gateways

On the Kubernetes path, every roster value is a container runtime descriptor.
It preserves the runtime's exact `Gateway` type while privately owning two
runtime-specific pieces: the portable application-container entrypoint and a
controller-side bridge. After the Sandbox application is ready, that bridge
attaches to the runtime and returns the existing `RunningAgent<Gateway>` shape:
the exact gateway plus termination observation. Only then may the slot satisfy
the cohort gate and become a `StartedAgent` for the customer Effect.

Arbitrary JavaScript gateway values, Effect closures, and shared in-process
state do not cross the container boundary. Each runtime implementation owns
both ends of its bridge and may use its own fixed internal transport. The
simulator defines no universal command, request, response, correlation,
session, or model-configuration protocol and does not normalize gateway types.
The kernel knows only the generic acquired shape it already consumes.

For evaluation code peers, this replaces the host-only
`effectRuntime({ build })` realization on the Kubernetes path. The peer policy
runs as the application entrypoint in that peer's Sandbox container, and
`packages/evals` owns the peer-specific observation bridge and its exact
gateway adapter. Peer social behavior still uses the production MoltZap
client and router. The in-process Effect runtime remains transitional host
code until cutover, and has since been removed with it; no public
`scriptedRuntime` constructor or generic scripted-agent protocol is introduced.

### One execution is one experiment society

Each call creates one society for one customer Effect and then tears it down:

1. Temporal starts one coarse workflow for the run.
2. Kueue admits capacity for the complete roster.
3. The controller creates one Agent Sandbox with one application container for
   each roster entry.
4. Each runtime-specific controller bridge attaches, and the controller waits
   until the exact roster is ready at the same cohort gate.
5. The in-cluster controller invokes the `execute` Effect once.
6. The existing simulator ledger and run outcome retain the experiment and
   infrastructure evidence.
7. Temporal drives cleanup of the run-owned Kubernetes resources.

The society is not a warm pool and is not reused by another experiment.
Kueue owns capacity admission; it does not decide simulator readiness.
Kubernetes and Agent Sandbox own container placement and lifecycle; they do
not run customer policy. The controller owns the exact readiness gate,
customer Effect, and simulator evidence. Temporal owns the coarse operational
lifecycle and cleanup; it does not run agent logic, append simulator evidence,
or replay the customer Effect.

One roster entry means one logical agent in one Agent Sandbox application
container. Infrastructure containers are not agents. Real agents and
code/scripted agents may share one society, but every agent's social traffic
uses the production MoltZap router. The experiment controls an agent through
that runtime's native principal gateway and does not impersonate an agent with
a synthetic MoltZap participant.

The controller uses a stable simulator image and loads the experiment module
late, so changing an experiment does not require building a new agent image.
The stock digest-pinned OpenClaw image is the compatibility baseline; a
prebuilt MoltZap image may only be an optimization. The exact bundle transport
and cache are private profile details, not a public artifact protocol.

### Failure and evidence retain the existing simulator semantics

Dispatch requires the complete roster to be ready together. A backing Pod
restart before dispatch simply keeps that slot outside the gate until its
current application and controller bridge are usable; no generation API is
exposed. An unrecoverable or never-ready agent or bridge fails acquisition and
starts cleanup. After dispatch, runtime termination remains typed ledger
evidence and the customer Effect's existing policy decides whether to finish,
fail, or keep observing the run.

The controller invokes `execute` once for a run and never automatically
replays it. Controller loss or infrastructure failure fails the run and starts
cleanup. This is not an exactly-once guarantee for external side effects;
customer code owns any application-level retry or idempotency it needs.

The run returns the same kind of program `Exit` and completed-ledger receipt
already owned by the simulator. Infrastructure failure uses the existing
infrastructure-outcome model. Temporal history and Kubernetes status are
operational observations, not replacements for the simulator ledger.

### Local and GKE are two profiles of one path

The repository owns one local Kubernetes profile for development and CI and
one GKE profile for cloud qualification. Both install or connect to the same
required components and invoke the same `Run.execute` path. A small
repository-local CLI accepts a RunSpec entrypoint and calls that same library
path; it does not define a separate execution protocol.

The local profile uses a repository-owned local cluster and a development
Temporal deployment. The GKE reference is regional GKE Standard and uses
Agent Sandbox. Terraform and Helm own reproducible GKE and add-on setup.
Production Temporal hosting and high availability remain deliberately
unselected; GKE qualification may use a test deployment or a configured
Temporal endpoint.

The Kubernetes implementation stays behind the existing Effect Layer
boundary. That boundary is sufficient for a possible future scheduler; this
slice does not implement Nomad, Slurm, or another backend.

### Acceptance is experiment evidence, not platform completeness

The slice is complete only when all of the following use the core
`packages/simulator` path:

- unit tests with a private fake platform prove cohort-gate ordering, one
  customer-Effect invocation, post-dispatch termination policy, outcomes, and
  cleanup;
- a local-cluster two-agent smoke proves Kueue admission, one Sandbox/container
  per agent, native gateway readiness, execution, ledger evidence, and zero
  run-owned residue;
- one end-to-end experiment, sized by its run rather than by its source, proves
  the same complete-roster path at larger cohorts before any scale claim;
- all 32 OpenClaw/NanoClaw evaluation cells invoke `Run.execute` through
  Kubernetes and record their real outcomes, including honest operational or
  behavioral failures rather than forced passes;
- the same small smoke and at least one OpenClaw evaluation run on GKE through
  the same authoring contract; and
- the transitional Docker example and host execution path are removed only
  after the replacement evidence exists.

### Non-goals

The following are not part of this decision or its first implementation:

- generation identifiers or streams, a customer-visible restart/recovery API,
  or post-dispatch replacement, rebinding, rejoin, and recovery of in-flight
  work;
- replay or resume of the customer Effect, exactly-once external effects, or a
  customer-visible distributed transaction protocol;
- a durable artifact authority, start-or-attach binding database, global
  execution-id namespace, synthetic UUID scheme, or normative Kubernetes-name
  hashing algorithm;
- a new immutable-data grammar, JCS contract, universal input/result/failure
  schema, or serialization rules beyond the simulator's existing schemas and
  the fixed runtime-specific bridge schemas and checksums needed to move an
  experiment module or pinned image;
- a public Kubernetes object model, arbitrary Pod templates, per-agent
  Temporal workflows, or simulator APIs for Kueue, Sandbox, or Temporal
  internals;
- a universal gateway proxy, command language, actor mailbox, cross-runtime
  correlation model, or serialization of arbitrary JavaScript/Effect values;
- warm societies, multi-run scheduling policy, fairness, borrowing, preemption,
  simulator-owned autoscaling of a run's cohort, router high availability, or
  production Temporal high availability. A profile may let its node pool
  autoscale, which is the cluster's own capacity mechanism and the simpler one
  to operate;
- a 100-, 1,000-, 5,000-, or 10,000-agent qualification claim before the
  two-agent and larger-cohort gates pass;
- a Nomad, Slurm, managed-batch, or GKE Autopilot implementation;
- exact Secret-provider protocols, persistent-agent-state recovery, exhaustive
  NetworkPolicy design, or a general multi-tenant security platform; and
- any implementation or contract change under `v2/*`.

### Current owners and earlier outcomes

`packages/simulator` owns `RunSpec`, `Run.execute`, the private Kubernetes
implementation, profile assets, controller, and its use of Kueue, Agent
Sandbox, and Temporal. `packages/evals` continues to own cases, runtime
conditions, grading, reports, resume policy, and Phoenix publication. It is a
consumer, not a second execution platform.

[`20260727-code-first-simulator-kernel.md`](./20260727-code-first-simulator-kernel.md)
remains current for its code-first Effect model, closed typed event catalog,
typed ledger, runtime roster, customer-owned scenario/sweep/completion/grading
policy, and single-package boundary. This decision replaces only the v1
`simulator.define(...).run(...)` public naming and the host-only concrete
execution path.

[`20260729-principal-io-uses-runtime-gateways.md`](./20260729-principal-io-uses-runtime-gateways.md)
remains current for exact runtime-native gateway types, agent social traffic,
termination policy, mixed societies, and behavioral-evaluation evidence. This
decision replaces only its host-bound realization of code agents as
`effectRuntime({ build })` closures sharing in-process state with their
gateway. Container runtime implementations now own runtime-specific bridges;
the ban on a simulator-wide gateway union or generic command protocol remains.

[`20260729-effect-native-evaluation-results.md`](./20260729-effect-native-evaluation-results.md)
remains current for cases, grading, report resume, SQLite, and Phoenix. This
decision changes where an evaluation run executes, not how evaluation truth is
defined or published.

The distributed-execution ADRs on the v2 branch remain v2 authority. Their
checked-in source trajectories inform this main-track decision, but their v2
process map, package ownership, generation model, and trust contracts are not
copied into v1.

## Consequences

Experiment authors get one small code-first contract and one execution path
from laptop-scale Kubernetes to GKE. The core simulator, rather than an
example, owns container-society execution. The strict cohort gate and
one-container-per-agent boundary match the experiment requirements without
turning the simulator into a general execution platform.

The design accepts startup latency and a stable controller/bundle mechanism in
exchange for avoiding per-experiment agent images. It also accepts that a
controller or agent failure may end a run; automatic recovery is intentionally
outside the first experiment-infrastructure slice.

## Record changelog

Point corrections that leave the Decision Outcome intact. A change that alters
the outcome is a supersession, not a row here.

| Date | Change |
|---|---|
| 2026-08-06 | Renamed the `RunSpec` field `infrastructure` to `cluster`, matching the implementation and the orientation docs. |
| 2026-08-06 | Replaced the fixed four-agent acceptance gate with one end-to-end experiment sized by its run. Removes the earlier ten- and four-agent wording, which the record, the ledger, and the profile tooling had never agreed on. The scale-claim non-goals are unchanged: no source event addresses them. |
| 2026-08-06 | Corrected the stale subpath in the simulator overview from `/runtime` to `/agents`, the export the package actually publishes. |
| 2026-08-06 | Corrected the illustrative snippet from `export default` to the named `runSpec` export the controller admits. |
| 2026-08-06 | Scoped the `autoscaling` non-goal to a run's cohort. A profile's node pool may autoscale; it was selected because it is the simpler thing to operate. |
| 2026-08-11 | Recorded that the transitional host entry point and in-process Effect runtime are gone. Both were described in the present tense after the cutover that removed them, leaving a reader unable to tell whether either still existed. The Decision Outcome and its removal condition are unchanged. |
| 2026-08-27 | Recorded the addressed Client and native-session adapter replacement in the visible supersession. The Kubernetes society-execution Decision Outcome is untouched. |
