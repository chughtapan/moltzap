---
status: accepted
date: 2026-07-21
decision-makers: Tapan Chugh
---

# X.509 is the identity card container

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
