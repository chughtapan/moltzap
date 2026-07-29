---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# One container per agent gates distributed runs

Decision provenance: [compacted trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-one-container-per-agent-gates-distributed-runs).

## Context and Problem Statement

The code-first simulator acquires a scoped runtime roster before it evaluates
the customer's Effect program. At laptop scale, acquiring one runtime at a
time is sufficient. At 1,000–10,000 agents, capacity admission, container
startup, identity bootstrap, daemon readiness, and runtime-bridge readiness
finish at different times. Dispatching after every agent has merely been
ready at some earlier instant can start a different, already-degraded society.

Packing several logical agents into one container would reduce scheduler
pressure, but it would also share a crash, credential, resource, and tool
execution boundary between peers that the simulator may model as faulty or
malicious.

## Decision Outcome

Chosen: **a distributed container cohort maps one expected AgentId to one
container, and the customer Effect program starts only after one exact
full-roster readiness barrier**.

Each container owns exactly one logical agent: one runtime bridge and the one
`moltzap-agentd` process for that AgentId. It contains no second agent and uses
no agent sidecar. Each submission acquires one run-scoped production stack:
independent Registry, Router, and Ledger processes serving only that run,
plus one independently supervised daemon per AgentId. Acquisition is
phased: the testbed first acquires the Registry, Router, and Ledger core,
resolves the AgentId roster, and then materializes the cohort whose containers
start the per-AgentId daemons and runtime bridges. It collects execution
evidence before releasing the cohort and core, then records cleanup outcomes
and finalizes the run artifacts.

That stack and cohort serve exactly one invocation of one customer Effect
program for one simulator run, then tear down. Reusable warm societies and
multiple later program dispatches are outside this profile.

Agent ServiceAccounts receive no Kubernetes RBAC. Containers share a node
kernel: this profile assumes a correct Kubernetes control plane, node, and
container runtime and does not claim tolerance of a container or kernel
escape. The one-container invariant does not itself decide Pod-to-Pod network
isolation. Whether the GKE profile denies direct agent traffic and which
service edges it permits remains an implementation-scope decision.

A distributed run establishes its immutable expected AgentId roster during
run resolution, after ordinary Registry registration or validation of every
declared slot and before Pod materialization. The testbed binds each container
instance to exactly one resolved roster slot. The controller maintains an
exact set of scoped readiness handles for the run-stack core and roster slots
and latches every observed service loss, container exit, deletion,
replacement, and identity mismatch. It may declare the roster ready only when:

- the run-stack core acquisition handle remains current;
- every expected slot holds one current readiness handle bound to one
  container instance;
- the testbed has accepted or provisioned each slot's profile and key,
  performed ordinary Registry registration or validation outside the agent
  container, and resolved the resulting immutable card;
- the testbed has bound the expected `EndpointProfileRef` and daemon discovery
  reports the expected AgentId;
- each runtime bridge has completed its harness-specific daemon supervision,
  including the required loopback MCP subscription; and
- no failure transition has been latched and no slot has acquired a second
  container identity.

Each slot handle is backed by authenticated readiness observations bound to
the enrolled Pod UID and slot. Those observations establish matching daemon
discovery and acquisition of the OpenClaw bridge's sole subscription. An
observation that becomes stale or unavailable invalidates the handle. This
operational status path is not Router presence, a MoltZap network plane, or
proof that the agent will behave honestly. Whether it uses a session, poll,
lease, or another transport—and its schema, freshness rule, and authentication
envelope—is selected with the implementation scope.

Capacity admission is necessary but not sufficient. Kubernetes Pod phase,
container health, Registry contents, and Router transport state are inputs to
their owning checks; none alone is semantic roster readiness. In particular,
Router gains no registration, presence, or runtime-readiness operation.

Roster readiness linearizes at the durable RunLedger append of the
full-roster-ready evidence after those controller-owned conditions hold. The
controller rechecks that the run-stack core and every slot handle remain
current before it appends program-dispatch evidence and attempts to invoke the
Effect program. That append is the durable authorization and attempt boundary,
not proof that the first customer instruction executed. A failure observed
between the ready and dispatch appends aborts without invoking customer code;
a failure first observed after the dispatch append is post-dispatch typed
runtime or infrastructure evidence for customer policy. The controller itself
can fail between that append and invocation. This is an observable
control-plane guarantee; an external process can crash immediately before
either check without its failure notification having reached the controller
yet.

Exact event tags and schemas are selected with the implementation scope and
versioned through the closed EventCatalog.

Any observed core-service loss, container exit, deletion, identity mismatch,
duplicate slot, bootstrap failure, or readiness timeout before the barrier
fails acquisition and tears down the whole cohort. After dispatch, an
autonomous runtime exit or infrastructure loss observed before scoped release
remains typed RunLedger evidence and customer Effect policy decides whether it
ends the run. Termination caused by normal cohort release is cleanup evidence,
not runtime-exit evidence.

The distributed contract provides no restart, replacement, rebinding, or
arbitrary-program resume guarantee. A controller failure fails the run.
While the controller is live, cleanup remains inside the run's scoped testbed
Layer and finishes before run completion. After abrupt controller loss,
Temporal may reconcile platform resources idempotently, but it does not
complete or mutate simulator evidence.

The target capacity is 1,000–10,000 real agent containers. That number is an
acceptance target, not a protocol liveness guarantee. Initial implementation
proves the complete contract with 10 distinct agent containers before
advancing through staged scale gates; a two-agent smoke may precede that gate.

## Consequences

The normal distributed path pays scheduler and bootstrap latency in exchange
for an honest isolation and readiness claim. An in-process or packed load
generator may remain useful for unit or throughput tests, but it cannot count
toward a result claiming this distributed-container profile.

The container boundary does not by itself prevent undeclared direct peer
traffic and does not turn a shared-kernel container into a VM or hostile-code
sandbox. A later network-isolation decision may strengthen that boundary
without weakening the one-container requirement.

Portable simulator definitions do not name a scheduler. The selected
`StackProvider` Layer and testbed implementation choose local or distributed
acquisition, preserving the existing simulator/testbed package boundary.

This decision does not add a package, public runner, Router feature, or
production process. Those would require their own compatible decision under
the current six-package and process topology.
