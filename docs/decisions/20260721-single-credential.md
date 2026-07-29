---
status: partially-superseded
date: 2026-07-21
decision-makers: Tapan Chugh
superseded-by: 20260729-identity-uses-jcs-jose-authenticated-http.md
---

# One credential: the card key authenticates everything

Decision provenance: [compacted trajectory](../decision-evidence/20260720-20260727-v2-design-origins-trajectory.md#20260721-single-credential) and [replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#identity-uses-jcs-jose-and-authenticatedhttp).

## Supersession

The agent's Ed25519 key remains its single long-lived credential for
normal service requests and SignedMessage attribution. Registration is
the sole pre-card exception: a deployment admission credential
authorizes the attempt and an RFC 9421 signature proves possession of
the submitted agent key. The Registry attestation key is a service
trust anchor, not a second agent credential.

`20260729-identity-uses-jcs-jose-authenticated-http.md` replaces X.509,
embedded-card requests, and the historical incomplete signing shape.
Normal requests carry `callerAgentId`; `AuthenticatedHttp` resolves the
immutable card and verifies the exact RFC 9421 profile. Current details
live in `docs/spec/identity.md` and
`docs/spec/identity-representation.md`.

## Context and Problem Statement

The identity card binds a verification key
(`20260721-native-principal-shaped-card.md`,
`20260721-x509-card-container.md`) whose target duty is verifying
per-message signatures. Interim plane authentication was drafted as
bearer keys (carrying v1's mechanism forward), giving every identity
two credentials: a
plane-side shared secret plus the card keypair, with the card key
dormant until message signing ships.

## Considered Options

- Bearer secret for requests; card key dormant until message signing.
- Proof-of-possession: every request signed with the card key.
- Short-lived tokens derived from a card-key challenge.

## Decision Outcome

Chosen: **proof-of-possession of the card key**. Every request on
either plane is signed with the identity's card key in the HTTP
message-signature shape — method, path, body digest; the exact
profile is key-model work (the `v2/VISION.md` open-question
register, item 5) — and the plane
verifies against the registered public key. Bearer secrets never
exist. Registration submits the public key; the registry issues the
card. There is no second key: the card key is the only credential the
plane ever verifies
(`20260727-registration-is-out-of-band.md` retired the operator key
this record had provisioned alongside it).

Consequences: the plane stores only public material — no shared
secrets anywhere, at rest or in transit; the interim-to-target
attribution migration shrinks to a change of scope — sign the
request becomes sign the message — with the same key; endpoints hold
their private key from day one (message signing requires it
eventually anyway); v1's bearer credential-key toolkit is not
salvaged; rotation and revocation remain register item 5.
