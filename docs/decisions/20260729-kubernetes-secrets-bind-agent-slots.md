---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Kubernetes Secrets bind agent slots

Decision provenance: [Agent Sandbox reconsideration](../decision-evidence/20260730-distributed-society-execution-agent-sandbox-trajectory.md).

## Context and Problem Statement

The selected GKE Agent Sandbox posture disables ServiceAccount-token automount
and prohibits projected service-account token volumes. A TokenReview ceremony
would add a second enrollment protocol without improving the controller's
ability to bind a stable Sandbox slot to its already-resolved AgentId.

## Decision Outcome

Chosen: **the controller creates one run-scoped Kubernetes Secret per stable
Sandbox slot and mounts only that Secret read-only into that Sandbox's current
backing Pod**.

Before Sandbox creation the controller resolves each AgentId, named endpoint
profile, and required key material through ordinary Registry operations. It
then creates the Secret containing only that slot's identity/profile/bootstrap
configuration and immutable bundle references. The agent ServiceAccount has no
RBAC or cloud identity and cannot list or read other Secrets.

The controller derives the slot from Sandbox metadata and verifies the
Sandbox-to-current-Pod owner relation, Pod UID, and application restart count
when interpreting Kubernetes readiness. The Secret binds an agent to the
logical slot; Kubernetes readiness status binds the observation to the current
generation. Neither Secret data nor Pod metadata is a Router operation or
substitute for MoltZap L1 message authentication.

The same Secret remounts after backing-container restart or backing-Pod
recreation. It is deleted after owner-first Sandbox cleanup. A shared roster
Secret and a projected-token/TokenReview enrollment exchange are outside this
profile.

## Consequences

Kubernetes identity and MoltZap identity remain separate trust domains.
The implementation creates one small Secret object per agent, trading object
count for a simple, GKE-compatible isolation boundary. The controller remains
the only actor that maps a roster slot to its AgentId; no agent claims an
ordinal.
