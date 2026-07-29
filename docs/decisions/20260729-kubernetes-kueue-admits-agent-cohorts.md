---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Kubernetes and Kueue admit agent cohorts

Decision provenance: [compacted trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-kubernetes-kueue-admits-agent-cohorts).

## Context and Problem Statement

The distributed run contract needs a scheduler that can materialize thousands
of isolated containers, admit the complete cohort's aggregate resource request
as one workload, and expose ordinary workload state to the testbed. Slurm,
managed batch services, Nomad, Kubernetes, and serverless containers provide
different parts of that behavior. The first implementation should not make
every backend first-class or let scheduler behavior redefine simulator
readiness.

Kubernetes Job and Deployment controllers replace failed workloads by default.
That conflicts with the simulator's current no-replacement semantics. Kueue
can admit a group of externally managed plain Pods as one resource workload,
and it does not recreate a failed plain Pod.

## Decision Outcome

Chosen: **general Kubernetes is the first distributed backend, GKE Standard is
the reference environment, and Kueue admits each complete agent cohort as one
resource workload**.

The reference workload uses one externally managed plain Pod per expected
AgentId. Every Pod has the same agent `PodSpec`, `restartPolicy: Never`, exactly
one container, no init container, and no sidecar. Deterministic metadata
identifies the run and roster slot without making each Pod a different
resource shape. No Job, Deployment, StatefulSet, or other owner may recreate
an agent Pod.

All Pods enter one Kueue Pod group. Kueue admits aggregate quota for the
complete group; partial admission and preemption are disabled. The group is
non-retriable, no owner or external controller recreates an agent Pod, and the
reference uses on-demand rather than Spot capacity. The testbed treats a
pre-admission or pre-barrier Pod loss as cohort failure and deletes the
remaining group.

Aggregate quota admission does not guarantee simultaneous physical Pod
placement. Kubernetes may place Pods incrementally after Kueue admission.
The authoritative GKE profile enables Kueue topology-aware scheduling to
mitigate placement fragmentation; its exact topology domain and configuration
are implementation-scope choices. Topology assignment still does not prove
simultaneous Pod startup or semantic readiness. The exact roster barrier—not
Kueue admission—prevents dispatch into a partial society.

Kueue owns quota and capacity admission only. It does not decide that an
AgentId, daemon, runtime bridge, or society is ready. The exact full-roster
barrier remains a simulator/testbed obligation.

The authoritative GCP profile is a regional, VPC-native GKE Standard cluster
with Dataplane V2, a stable system pool, and a dedicated homogeneous agent
pool that can be pre-sized before cohort creation. Terraform owns the GCP
resources and IAM; pinned Helm configuration owns Kueue and cluster add-ons.
Exact modules, regions, machine shapes, quotas, resource requests, Pod CIDRs,
and autoscaling policy are implementation-scope choices.

Every agent Pod has a finite active deadline. A cluster reconciler deletes
expired run-labeled Pods, Kueue resources, and associated ephemeral resources
if controller and Temporal cleanup do not complete. Exact deadline, expiry,
and scan values are implementation-scope choices. Its resource shape, code
owner, placement, RBAC, cloud credentials, and deployment mechanism are also
selected with the implementation scope. The reconciler bounds orphaned
capacity when it and the Kubernetes control plane remain available; it does
not resume a run or append RunLedger evidence.

The GKE profile uses Workload Identity Federation for GKE for controller and
platform access to GCP services; it mounts no long-lived Google Cloud service
account key. Agent ServiceAccounts retain zero Kubernetes RBAC and receive no
GCP IAM. Artifact delivery uses authenticated enrollment or an object-scoped
ephemeral mechanism rather than agent workload identity. Exact delivery
mechanism and platform IAM bindings are implementation-scope choices.

Private registries are supported. The GKE reference may mirror digest-pinned
images into Artifact Registry and grant only repository-scoped pull access.
A generic Kubernetes deployment may use its normal registry credentials.
Registry location never changes the image or readiness contract.

Nomad is a future backend behind the same distributed cohort contract; no
Nomad adapter is part of the first implementation. Slurm and managed batch
services are not selected. GKE Autopilot may be tested later as a conformance
and cost profile, but it is not authoritative for the 1,000–10,000-agent path.

## Consequences

The testbed, not `simulator`, owns Kubernetes clients, Kueue resources,
Terraform/Helm deployment inputs, and process supervision. Portable
definitions continue to select their host through a Layer.

Creating 10,000 Pod objects and starting 10,000 copies of one image can take
minutes and can expose API-server, registry, network-address, and node-capacity
limits. The implementation must measure those phases separately from semantic
readiness.

Plain Pods are an intentional use of Kueue's externally managed Pod-group
mode. If resource admission or placement cannot complete without preemption,
requeue, or replacement, the reference run fails rather than silently adopting
that behavior.

References: [Kueue plain Pod groups](https://kueue.sigs.k8s.io/docs/tasks/run/plain_pods/),
[Kueue all-or-nothing scheduling](https://kueue.sigs.k8s.io/docs/concepts/all_or_nothing/),
and [GKE large-cluster planning](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/planning-large-clusters).
