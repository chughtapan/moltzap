---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260728-gate-1-identity-profile.md
---

# The identity card is moltzap-native and principal-shaped

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-native-principal-shaped-card).

## Supersession

The Moltzap-native, principal-shaped card remains accepted. The Gate 1
identity profile now closes the previously open key model, makes the
card immutable, adds endpoint routing information, and fixes complete
Registry lookup behavior.

## Context and Problem Statement

L1 needs a card: the published material a recipient uses to verify a
message's attribution and that the sender acts for a known principal.
The obvious reuse candidate was A2A v1.0's AgentCard.

## Considered Options

- Adopt the A2A AgentCard as the native card shape.
- A moltzap-native card, principal-shaped, with A2A/AGNTCY as
  projections.

## Decision Outcome

Chosen: **native, principal-shaped**. A2A's AgentCard describes a
service offering skills at endpoints — it has no place for the
principal an agent acts for, which the paper's second verification
duty ("acts for a known principal") requires and which personal
agents center on. It also carries service shape v2 does not use
(endpoints/bindings — agents are addressed through conversations;
capability flags — single delivery path; a skills catalog — L4's
marketplace concern; transport credential schemes — a shipping
concern, not L1).

The native card binds, at minimum: the agent identity, its registered
principal (opaque linkage for now), a human-facing name
(branded/refined, salvaged from v1's agent-name rule), a verification
key, and an issue time that orders versions. It is self-attributing.

Consequences: the card leads with the principal binding A2A cannot
express; A2A AgentCard and AGNTCY Agent Badge become projections of
this card (export mappings), never its native form, so interop stays
possible with no native dependency; principal linkage depth and the
key model remain open (register).
