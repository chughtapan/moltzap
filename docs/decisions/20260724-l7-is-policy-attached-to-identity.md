---
status: superseded
date: 2026-07-24
decision-makers: Tapan Chugh
superseded-by: 20260728-layer-boundaries-and-fault-model.md
---

# L7 is institutional policy attached to identity

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260724-l7-is-policy-attached-to-identity).

## Supersession

This record is fully superseded. L1 Registry and L7 institutions are
different services and trust domains. No DirectoryEntry combines cards
with institutional facts, and Router and Ledger never query L7.
Gate 1 ships no L7 service.

## Context and Problem Statement

L7 was framed revocation-centric: consequences as "revoking or
quarantining credentials," a certificate-revocation model where an
identity is vouched or not. The corpus already strained against that
frame: the L5 clause has rules keying off "institutional facts, which
L7 records at L1"; quarantine never reduced to a binary; clause 12
credentials legislators; and the monitor decision requires
entitlements ("may operate a monitor") no vouch bit can express. What
is L7's object?

## Considered Options

- Binary vouching: an identity is attested or revoked; quarantine
  bolted on.
- Policy attached to identity: institutional facts as the object,
  revocation the limit case.

## Decision Outcome

Chosen: **the directory entry is identity plus attached institutional
facts** — in an institution, who you are and what you are allowed to
do.

- **The card answers who** (L1): the key binding, self-attributing,
  unchanged. **The facts answer what the identity may do** in the
  institution (L7): mutable, versioned, attributed to the institution,
  served with the lookup. Facts ride beside the card, never inside it —
  a policy change must not re-mint the identity artifact (the minimum
  card stands).
- **Consequences are policy changes.** Quarantine is a restricted
  policy; revocation is the zero policy — the limit case, not the
  model. "L7 reconfigures L1" gains its full meaning: every layer
  reads the facts at L1 and enforces its own slice.
- **Enforcement stays at endpoints.** The plane's admission floor is
  unchanged and already correct — sender exists and is active, one
  institutional bit. Everything richer is read and enforced by L5
  firewalls, required by L4 norms, and defined by L8. The router
  evaluates no policy.
- **Freshness and transparency carry over, sharpened.** The card-cache
  max-age posture covers facts — policy staleness is its more
  important application — and split-view policies are a sharper
  equivocation attack than split-view keys, so the transparency
  target (a verifiable directory audited by our monitors) and the v0
  mint-log insurance cover the fact stream identically.

Open, deliberately: the fact and policy vocabulary; evaluation
semantics; who may author which facts (L8). v0's fact set is the
single active bit.

Refines `20260723-directory-serves-cards.md`: the card remains the
identity's self-attributed artifact and the lookup's core; the entry
grows registry-attested facts beside it. The v0 lookup surface is
unchanged until the fact vocabulary lands.

Consequences: enforcement.md's consequence machinery and constitution
clause 11 reframe from revocation to policy change; register item 5's
propagation question generalizes to fact changes; the "ceasing to
vouch" observable survives as the limit case's mechanism.
