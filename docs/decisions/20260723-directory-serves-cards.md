---
status: partially-superseded
date: 2026-07-23
decision-makers: Tapan Chugh
superseded-by: 20260729-identity-uses-jcs-jose-authenticated-http.md
---

# Directory read serves cards

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260723-directory-serves-cards) and [replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#identity-uses-jcs-jose-and-authenticatedhttp).

## Supersession

Registry lookup and list serving complete native immutable AgentCards
directly remains accepted. No parallel thin identity or routing
metadata projection is served, and future L7 institutional statements
remain outside Registry.

`20260729-identity-uses-jcs-jose-authenticated-http.md` replaces the
historical Directory/X.509/routing/freshness and revocation language.
The public service name is Registry. AgentCard is an exact
JCS/General-JWS artifact with no service origin or route. Lookup and
list are public unauthenticated reads. Current behavior lives in
`docs/spec/identity.md`.

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
