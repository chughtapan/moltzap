---
status: partially-superseded
date: 2026-07-23
decision-makers: Tapan Chugh
superseded-by: 20260728-gate-1-identity-profile.md
---

# Directory read serves cards

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260723-directory-serves-cards).

## Supersession

Serving complete native cards directly remains accepted. Gate 1 now
makes each card immutable, includes endpoint routing information, and
separates all future L7 institutional statements from Registry entries.

## Context and Problem Statement

Recipient verification needs the sender's card — a message verifies
from message plus card — and the interim signature profile's
verification path resolves a keyid to "the registry card." But the
control plane's directory read said only "resolve and enumerate
identities," leaving the payload open: two implementers would ship
an id-and-name listing and a card store respectively, and card
custody sat as a proposed register item.

## Considered Options

- A thin listing (id, name), with cards fetched elsewhere.
- The card is the directory entry: resolve and enumerate both
  return cards.

## Decision Outcome

Chosen: **the card is the directory entry**. Resolve-by-id returns
the identity's current card — the X.509 certificate, the identity's
only public artifact, self-attributing and therefore tamper- and
substitution-evident regardless of who serves it. Enumeration
returns cards too, paginated; no thinner projection is minted —
interop shapes remain projections consumers derive from the card,
never parallel served forms.

This closes card custody for v0: the registry serves cards. The
residual — whether agents also serve their own cards (peer custody,
verification with the registry unreachable) — stays an identity-doc
open question rather than a register admission. Enumeration exposes
only published material: cards are public by definition, per-id
resolve yields the same data, and visibility filtering was
deliberately not rebuilt; roster privacy, if it ever matters, is an
L8 policy over an L7 mechanism.

Consequences: one verification path everywhere (resolve keyid,
fetch card, verify); revocation gains its observable form — the
registry ceasing to vouch the card is what every verifier sees at
next resolve, the concrete shape of L7-reconfigures-L1; endpoints
may cache cards only with an explicit max-age equal to the freshness
window they accept — issued-at orders versions, it is not freshness,
and a revoked card still verifies cryptographically, so verification
failure alone never triggers the refetch (implementation note, not
interface).
