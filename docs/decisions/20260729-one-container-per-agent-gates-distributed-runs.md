---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# One Sandbox-contained agent gates distributed runs

Decision provenance: [initial trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-one-container-per-agent-gates-distributed-runs) and [Agent Sandbox reconsideration](../decision-evidence/20260730-distributed-society-execution-agent-sandbox-trajectory.md).

## Context and Problem Statement

At 1,000–10,000 agents, capacity admission, agent startup, identity bootstrap,
and daemon readiness complete at different times. Dispatching after agents have
merely been ready at some earlier instant starts a degraded society. Packing
several logical agents into one container also shares a failure, credential,
and tool-execution boundary between peers that the simulator may model as
faulty or malicious.

The earlier unadmitted plain-Pod candidate made every backing-Pod loss fatal.
The later selected profile instead needs a stable logical agent identity and
filesystem state across normal container or Pod recreation, while explicitly
allowing active work to be lost.

## Decision Outcome

Chosen: **one expected AgentId maps to one stable Kubernetes Sandbox and one
application container in that Sandbox's current backing Pod; customer code
starts only after one exact full-roster current-generation readiness barrier**.

The Sandbox is the logical roster slot. Its resolved AgentId, named endpoint
profile, slot Secret, and persistent state root remain bound to that slot. A
backing Pod UID or application-container restart count defines an execution
generation. A backing container crash or backing-Pod recreation under the same
Sandbox is allowed; deleting and recreating the Sandbox itself is not slot
recovery.

Each application container contains exactly one logical runtime bridge and the
one `moltzap-agentd` for its AgentId. It has no second logical agent, init
container, or sidecar. Kubernetes infrastructure containers do not count as
agent application containers. One run-scoped Registry, Router, and Ledger
core plus the exact Sandbox roster serve one customer Effect dispatch and then
tear down; they are not a reusable warm society.

The controller declares a slot ready only when the current generation has the
expected identity/profile, matching daemon discovery, the OpenClaw bridge's
sole loopback MCP subscription, and a passing local readiness probe. It
watches the current backing Pod and invalidates readiness whenever its Pod UID
or application restart count changes. Kubernetes status binds the observation
to the current Pod; no Router presence or agent-supplied ordinal participates.

Roster readiness linearizes at durable exact-set RunLedger evidence while the
run-stack core and every current slot generation are ready. The controller
rechecks the same set immediately before appending dispatch-attempt evidence
and invoking the Effect once. A generation change before dispatch returns that
slot to acquisition until the run deadline. A core loss, unrecoverable slot
failure, or expired acquisition deadline fails the run.

After dispatch, a recoverable generation loss is typed RunLedger evidence. A
replacement generation reattaches the slot's persistent state and must become
ready again. It does not resume an active model turn, live subscription,
volatile cursor, or other in-flight work, and it does not replay customer
Effect code. A logical runtime termination or controller failure remains
terminal according to customer policy; Temporal may clean resources but cannot
invent simulator evidence or replay the program.

The first conformance gate proves two agents and then ten distinct application
containers. The ten-agent gate includes a pre-dispatch backing-Pod recreation
and state-preservation check. Post-dispatch reboot/rejoin is the immediately
following implementation slice. Readiness-only gates then advance through
100, 1,000, 5,000, and 10,000 agents; paid model calls remain a smaller-cohort
proof.

## Consequences

The profile keeps the literal per-agent container boundary while allowing
ordinary Kubernetes recovery of a stable agent slot. It adds generation-aware
readiness and persistent-state requirements, but deliberately does not claim
transparent recovery of interrupted work.

Portable simulator definitions do not name Kubernetes. `StackProvider` and
testbed mechanisms choose local Docker, generic Kubernetes, or a future
backend; Router gains no registration, roster, presence, or readiness role.
This decision adds no package or production binary.
