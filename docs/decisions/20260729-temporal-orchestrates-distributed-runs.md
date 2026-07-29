---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Temporal orchestrates distributed runs

Decision provenance: [compacted trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-temporal-orchestrates-distributed-runs).

## Context and Problem Statement

A distributed society run has durable operational phases—submission, capacity
preparation, cohort creation, readiness, dispatch, artifact collection,
cancellation, and cleanup—but Kubernetes schedules containers rather than
owning that lifecycle. BullMQ can queue work but would require custom recovery
and reconciliation. Temporal can retain coarse run state, but modeling every
agent as a Workflow, Activity, Signal, or child Workflow would duplicate the
cluster scheduler and amplify history at the exact scale being targeted.

The customer's Effect program is arbitrary code. Replaying it after a
controller crash would claim determinism and recovery semantics that the
simulator does not provide.

## Decision Outcome

Chosen: **Temporal owns one coarse orchestration Workflow per society
submission; Kubernetes and Kueue own container placement and capacity; the
in-cluster controller owns one execution of the customer Effect program**.

The Workflow observes aggregate phases only: validate, prepare capacity,
submit the controller workload, await the controller's barrier result, observe
program completion or cancellation, collect artifacts, and reconcile cleanup.
It does not create a Temporal entity or event stream per agent.

Temporal Activities perform idempotent reconciliation against deterministic
run resource names. They may validate or prepare shared capacity, create and
reconcile the controller bootstrap workload, observe aggregate controller
state, and delete deterministic run resources during cleanup. The in-cluster
controller and its testbed Layer exclusively own acquisition or creation of
the production stack, Kueue workload, and agent Pod group. Activities do not
execute model turns, decide roster readiness, append simulation evidence on
behalf of the controller, or replay the customer program.

The in-cluster controller fetches the selected experiment artifact, acquires
the run-scoped Registry, Router, and Ledger core through the testbed, resolves
the AgentId roster, and then acquires the agent cohort that completes the
stack with its daemons and runtime bridges. It evaluates the Effect program
once after the exact readiness barrier, collects execution evidence, releases
the cohort and core, and records cleanup outcomes. A surviving controller
then finalizes and publishes the RunLedger. Controller loss fails the run;
Temporal may continue cleanup but does not resume the Effect program or
replace agents.

The controller workload is one non-retriable, non-replacing execution
identity. Once execution starts, Temporal never recreates it for that run.
Exact Pod-versus-Job resource shape is selected with the implementation scope.
Abrupt controller loss may leave the RunLedger unfinalized. Temporal records
the operational failure and cleanup state without impersonating RunLedger
evidence. If Temporal cleanup also fails, finite agent-Pod deadlines and an
available expired-run reconciler bound orphaned capacity without resuming the
run or writing simulator evidence.

BullMQ and Redis are absent. Temporal history is operational orchestration
state, not product Transcript state and not simulator RunLedger evidence.

The first environment uses a persistent local Temporal development server.
Production Temporal hosting is deliberately unselected. Submission must be
usable through both a reusable TypeScript call and a CLI-shaped operator
entrypoint. Until the implementation scope selects a compatible owner, the CLI
is repository-local composition; this record creates no seventh package, new
export, or binary. Publishing a binary or changing an export requires an
explicit replacement of the six-package decision.

The submitting operator and the submitted TypeScript/Effect bundle are trusted
in this profile. The bundle executes arbitrary code in the controller process;
Effect service requirements shape composition but are not an operating-system
sandbox. Isolation for hostile or mutually untrusted experiment code and
multi-tenant controller execution requires a separate decision.

## Consequences

One Workflow remains small when the agent count grows from 10 to 10,000. The
controller reports bounded aggregate progress rather than 10,000 independent
Temporal state machines.

Temporal is part of the GKE reference orchestration, not a requirement of the
backend-neutral simulator contract. Another scheduler backend may use a
different operational coordinator if it preserves the same readiness,
evidence, failure, and cleanup guarantees.

Run cancellation is durable at the orchestration layer, but arbitrary Effect
recovery is not. A later resume design would require a separate simulator
checkpoint and replay decision.

Controller and Temporal-worker Kubernetes shapes, placement, credentials, and
aggregate status transport are selected with the implementation scope. That
choice cannot move roster readiness or RunLedger authority into Temporal.
The expired-run reconciler's resource shape, code owner, placement, RBAC,
credentials, and deployment mechanism are selected there as well.

One Workflow per submission defines single-run orchestration only. Concurrent
society admission, fairness, namespace allocation, and multi-tenant isolation
are outside this profile.

Reference: [Temporal Workflow Execution limits](https://docs.temporal.io/workflow-execution/limits).
