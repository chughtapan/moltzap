---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260728-gate-1-identity-profile.md
---

# X.509 is the identity card container

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-x509-card-container).

## Supersession

The core Decision Outcome — X.509 is the AgentCard container — remains
current. Later accepted records supersede body phrases that call the
normative interface container-neutral, the container swappable, or the
concrete profile post-Gate-1 work; those phrases are historical context,
not the Gate 1 contract.

Gate 1 fixes one immutable MoltZap-native X.509 AgentCard per AgentId
with the fields and Ed25519 Registry attestation in
`20260728-gate-1-identity-profile.md` and `docs/spec/identity.md`.
Exact certificate extension/OID and byte assignments are a
normative pre-implementation artifact sequenced to the Phase 2A exact
byte-contract freeze; they must realize that fixed profile and its
golden vectors rather than reopen the container or field-set decision.

## Context and Problem Statement

The native identity card
(`20260721-native-principal-shaped-card.md`) fixes the card's fields
and guarantees but not its on-the-wire container. Candidates: a
JOSE/JWS-signed JSON payload, a raw signed structure, or X.509
certificates.

## Considered Options

- JWS/JWK — JSON-native, application-layer, library-verified.
- X.509 certificates — the standard identity-certificate format,
  ubiquitous tooling, the SPIFFE/SVID lineage.
- A bespoke signed structure.

## Decision Outcome

Chosen: **X.509**. A container choice, not an interface one: the
card's fields map onto a certificate — agent and principal as
subject/SAN URIs (`moltzap://agent/<id>`,
`moltzap://principal/<id>`), the verification key as the subject
public key, issue time as `notBefore`, the registry's attestation as
the issuer signature. The card's no-expiry guarantee uses RFC 5280's
own convention (`notAfter` = 99991231235959Z) rather than fighting
the format. Verification runs over the certificate's signed
structure, so the signing envelope is a library concern, not
hand-rolled canonicalization.

Consequences: the normative interface stays container-neutral (the
card is self-attributing and verifiable from published material); the
container is swappable if a deployment ever needs a different one; if
mTLS or cert-shaped interop is later wanted, the same card data mints
standard certificates with no interface change. The concrete profile
(extensions, SAN URI scheme, attestation chain) is spec-chapter and
key-model work (register item 5).
