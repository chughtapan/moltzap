---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Pod attestation gates agent enrollment

Decision provenance: [compacted trajectory](../decision-evidence/20260729-distributed-society-execution-trajectory.md#20260729-pod-attestation-gates-agent-enrollment).

## Context and Problem Statement

One homogeneous Pod specification cannot embed a different long-lived
credential or literal roster identity in every manifest without multiplying
resource shapes and secret objects. A shared roster secret would let one
compromised agent impersonate another. Kubernetes already binds projected
ServiceAccount tokens to a concrete Pod, but that credential belongs to the
cluster control plane and must not become MoltZap L1 identity.

Enrollment therefore needs to prove which pre-created workload is asking
before releasing only that roster slot's bootstrap material.

## Decision Outcome

Chosen: **a Pod-bound Kubernetes token attests workload membership to the
testbed controller; it never authenticates a MoltZap message or creates an
AgentId**.

During run resolution and before creating agent Pods, the testbed accepts a
pre-existing key/profile input or provisions a new key and named endpoint
profile for each declared slot. It performs ordinary explicit Registry
registration when required, validates an already-registered profile otherwise,
and resolves the resulting immutable AgentCard. Those results establish the
run's immutable expected AgentId roster. The deployment admission code remains
a controller/testbed credential and is never released to an agent Pod. No
registration operation is added to Router.

Agent Pods use a per-run ServiceAccount with no Kubernetes RBAC. Default token
automount is disabled. The single agent container receives an explicitly
projected, short-lived, Pod-bound token with a run-specific audience and sends
it only to the run controller's authenticated enrollment endpoint.

Before enrollment succeeds, the controller:

1. performs TokenReview for the exact audience and requires both
   `authenticated: true` and that audience in the returned
   `status.audiences`;
2. verifies the exact ServiceAccount namespace, name, and UID plus the bound
   Pod name and UID returned by TokenReview;
3. reads the live Pod and rejects deletion, a changed UID, or unexpected
   run, cohort, slot, ServiceAccount, and Pod-spec bindings;
4. derives the roster slot from controller-created metadata rather than a
   client claim; and
5. atomically binds that Pod UID to the one unbound expected slot.

A retry by the same Pod UID is idempotent. A different UID, duplicate slot,
changed specification, or out-of-roster Pod fails the whole pre-dispatch
cohort. There is no replacement enrollment.

Only after that check may the testbed provide the slot's bootstrap material
and already-assigned key/profile material over the confidential enrollment
channel. The runtime bridge receives the resulting `EndpointProfileRef` and no
other slot's key or profile. Product registration remains the Registry's
explicit control operation, and all product traffic continues to use the
AgentId's ordinary L1 credential.

The enrollment-facing controller identity receives only the cluster
permissions needed to review tokens and inspect the run's Pods and Kueue
workload. Any testbed platform-reconciliation identity is separately limited
to the exact run-scoped resource kinds selected by the implementation. Agent
Pods receive no permission to read Pods, Secrets, Workloads, or TokenReviews.

## Consequences

Kubernetes identity and MoltZap identity remain separate trust domains. A
correct cluster control plane and enrollment controller are additional
operational trust assumptions for workload-to-slot binding; they do not
replace the Gate 1 Registry trust assumption or product signature checks.

Homogeneous Pod specifications remain possible at large scale without one
shared impersonation credential. Stable identity is assigned by the
controller's roster, not by trusting an environment variable or ordinal sent
by the agent.

Exact token lifetime, audience literal, TLS issuer, secret envelope, and RBAC
resource names are implementation details. The binding and separation
guarantees are not.
