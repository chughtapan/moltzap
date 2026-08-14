---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260811-four-layer-endpoint-replicated-harness.md
---

# Gate 1 fixes the layer boundaries and fault model

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-layer-boundaries-and-fault-model), including the [Registry trust selection](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#registry-trust-assumption).

## Supersession

The independent Registry and Router boundaries, content-blind Router,
endpoint-owned interpretation, potentially Byzantine endpoints, correct
non-equivocating Registry and Router assumptions, and separate safety and
liveness claims remain current. Identity and Router do not interpret tasks,
norms, institutions, or governance.

`20260811-four-layer-endpoint-replicated-harness.md` removes the sibling Ledger
process, the correct-durable-Ledger trust assumption, the eight-layer numbering,
and the L5–L8/L7 trust domains. It assigns durable conversation history to
fixed-member endpoint replicas and states their quorum, disk, availability,
and catch-up assumptions directly. The replacement record, `v2/VISION.md`,
`docs/spec/layer-interfaces.md`, and `docs/spec/conversation-history.md` own the
current boundary and fault model; the retained exact identity and Router
contracts remain in their named specification chapters.

## Context and Problem Statement

Earlier drafts placed conversation membership, replay, collective
validity, and institutional status in lower layers. That made the
Router interpret conversations, made the Ledger a policy engine, and
coupled L1 identity to L7 institutions.

## Decision Outcome

Chosen: **the lower layers provide narrow mechanical guarantees and
endpoints compose meaning above them**.

- L1 resolves immutable cryptographic identity.
- L2 performs content-blind, equivocation-free ordered multicast to
  explicit AgentIds. It owns no conversation, replay, persistence, or
  offline-convergence semantics.
- L3 endpoints own conversations, live-attempt reliability,
  reconciliation, action protocols, and durable certified actions.
  Ledger mechanically appends certificates but does not decide their
  meaning.
- L4 supplies task-specific eligibility, quorum, and liveness policy.
  Gate 1 embeds only OpenFloorV1.
- L5 and above remain endpoint-consumed trust inputs. L1 Registry and
  future L7 institutions are independent services and trust domains.

Registry, Router, and Ledger run as three sibling processes with
separate listeners, lifecycle, configuration, and storage. Endpoints
coordinate them; Router and Ledger do not call each other.

Gate 1 assumes one correct non-equivocating Registry, one correct
non-equivocating Router, and one correct durable Ledger while endpoints
may be Byzantine. A malicious or equivocating Registry is outside the
L1 identity-binding guarantee. Service outage may stop affected
operations or progress, but pinned cards and self-contained Transcript
records remain verifiable during Registry outage. One honest required
endpoint can prevent an invalid action certificate; a unanimously
malicious certificate is outside the guarantee. Router replication,
fork detection, and Byzantine sequencing are deferred.

## Consequences

The Registry is part of the Gate 1 trusted computing base for identity
uniqueness, immutable card bindings, and attestation. Safety claims
state their assumptions independently from liveness. Network services
never evaluate L7 policy. Content blindness preserves the option of
end-to-end encryption without requiring it.
