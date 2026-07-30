---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Temporal orchestrates distributed runs

Decision provenance: [initial trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-temporal-orchestrates-distributed-runs) and [Agent Sandbox reconsideration](../decision-evidence/20260730-distributed-society-execution-agent-sandbox-trajectory.md).

## Context and Problem Statement

A society run has durable submission, capacity, acquisition, execution,
collection, and cleanup phases. Temporal can retain that coarse operational
intent without duplicating Kubernetes scheduling as 10,000 Workflows,
Activities, Signals, or child Workflows. Replaying arbitrary customer Effect
code after a controller crash would invent simulator recovery semantics.

## Decision Outcome

Chosen: **Temporal owns one coarse Workflow per society submission; the
in-cluster controller owns one customer-program execution; Kueue, Kubernetes,
and Agent Sandbox own reservation, placement, and backing-Pod lifecycle**.

Temporal Activities use deterministic names and idempotent aggregate
reconciliation. They may start the one non-replacing controller Pod, observe
bounded aggregate status, and clean deterministic resources. They never run
agent logic, decide readiness, append RunLedger evidence, create per-agent
Temporal entities, or replay the customer program.

The controller resolves the roster, creates the aggregate Kueue Workload,
materializes direct Sandboxes after admission, owns the exact generation-aware
barrier, invokes the Effect once, and records simulator evidence. Controller
loss fails the run. Temporal can report operational failure and delete
resources but cannot restart that program, fabricate RunLedger completion, or
turn a rebooted agent generation into a replay.

BullMQ and Redis are absent. Temporal history is neither product Transcript
state nor RunLedger evidence. The first environment uses persistent local
Temporal; production Temporal hosting remains deferred. Submission has one
reusable TypeScript call and a repository-local CLI-shaped entrypoint without
adding a package, export subpath, or production binary.

## Consequences

One Workflow stays bounded from ten through 10,000 agents. Agent restart
recovery is a controller/testbed concern, not a Temporal retry graph.
