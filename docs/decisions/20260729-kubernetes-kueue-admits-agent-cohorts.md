---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Kubernetes Agent Sandbox and Kueue admit agent cohorts

Decision provenance: [initial trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-kubernetes-and-kueue-admit-agent-cohorts) and [Agent Sandbox reconsideration](../decision-evidence/20260730-distributed-society-execution-agent-sandbox-trajectory.md).

## Context and Problem Statement

The first backend must materialize thousands of isolated agent containers,
admit complete-cohort capacity before materialization, and retain a stable
logical agent across backing-Pod recreation. Kueue's documented Sandbox
integration creates one Workload per Sandbox, which would create another
10,000 high-cardinality objects and does not express a society-wide barrier.

## Decision Outcome

Chosen: **general Kubernetes is the first backend; regional GKE Standard with
a dedicated on-demand gVisor pool is the reference environment; direct Agent
Sandbox resources materialize agents; and one aggregate Kueue Workload
reserves the complete cohort before Sandbox creation**.

The controller creates one deterministic direct `Sandbox` CR per roster slot,
not a Claim, WarmPool, or Sandbox Router service. Each Sandbox has one
application container, no init container or sidecar, `restartPolicy:
OnFailure`, non-root execution, no added Linux capabilities, disabled
ServiceAccount-token automount, and explicit resource requests and limits.
The Sandbox controller owns backing-Pod recreation; no separate Job,
Deployment, StatefulSet, or custom replacement owner manages agent Pods.

The controller first creates one compact Kueue Workload with one PodSet whose
count equals the frozen roster and whose resource shape equals every Sandbox
application container. It waits for admission, applies the admitted scheduling
constraints to every Sandbox template, and holds the reservation until
owner-first cleanup. Agent Sandbox Pods deliberately carry no Kueue queue
label, preventing the native per-Sandbox integration from creating one
Workload per agent. The adapter is testbed-private and must prove that the
reservation, admitted mutations, and actual Pods match; failure to prove this
blocks implementation rather than silently falling back to per-agent
Workloads.

Kueue owns capacity only. It does not establish AgentId identity, daemon
readiness, a current generation, or a ready society. Partial admission and
preemption are disabled for the reference profile.

Terraform owns GCP, networking, IAM, Artifact Registry, storage, regional GKE
and pools. Pinned Helm releases own Kueue and MoltZap support resources; the
managed GKE Agent Sandbox add-on is configured through GKE. The agent pool is
pre-sized when required. Agent ServiceAccounts have no Kubernetes RBAC and no
GCP IAM. Private Artifact Registry mirrors may preserve a stock image digest.

Run-scoped default-deny network policy permits only DNS, Registry, Router,
Ledger, and the in-cluster runtime-bundle service. Paid-model cohorts add an
allowlisted in-cluster HTTPS proxy. Direct agent-to-agent traffic and direct
provider egress are denied.

Nomad remains a future backend seam. Slurm, managed batch, Autopilot, and
AgentENV are not first backends. AgentENV is a Firecracker/KVM platform with
its own privileged DaemonSet and scheduler, so it does not satisfy this
literal Kubernetes-container/Kueue contract.

## Consequences

Agent Sandbox supplies stable identity, persistence, and backing-Pod recovery
without putting lifecycle or readiness semantics into the network. It adds a
managed CRD/controller compatibility surface and one Sandbox object per
agent. The first 2/10-agent profile uses one PVC per Sandbox; a measured
scale-storage decision is required before claiming reboot persistence at
1,000–10,000 agents.

References: [GKE Agent Sandbox](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/machine-learning/agent-sandbox), [GKE setup constraints](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/how-install-agent-sandbox), [Kueue Sandbox integration](https://kueue.sigs.k8s.io/v0.19/docs/tasks/run/external_workloads/sandbox/), and [AgentENV](https://github.com/kvcache-ai/AgentENV).
