---
status: accepted (control-plane request signing stands; message attribution is superseded — see 20260726-attribution-binds-to-the-message.md)
date: 2026-07-21
decision-makers: Tapan Chugh
---

# One credential: the card key authenticates everything

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
