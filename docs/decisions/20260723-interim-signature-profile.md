---
status: accepted
date: 2026-07-23
decision-makers: Tapan Chugh
---

# Interim request-signature profile: RFC 9421 with Ed25519

## Context and Problem Statement

Single-credential (`20260721-single-credential.md`) binds every
request on either plane to a card-key signature in the HTTP
message-signature shape and defers the exact profile to the key
model (register item 5). Until the profile is fixed no conformant
request exists, which blocks every implementation workstream.

## Considered Options

- RFC 9421 HTTP Message Signatures.
- A bespoke canonical-string signing scheme.
- JWS-wrapped request signing.

Within the profile — algorithm: Ed25519 vs ECDSA P-256; agent ids:
registry-minted opaque vs key-derived self-certifying.

## Decision Outcome

Chosen: **RFC 9421, Ed25519, agent-id keyid, 300-second freshness
window, opaque minted ids** — the interim profile; the target
per-frame binding, rotation, and revocation stay register item 5.

- Covered components: `@method`, `@target-uri`, the
  `moltzap-protocol` header
  (`20260723-protocol-version-carriage.md`), and
  `content-digest` whenever a body exists. Required signature
  parameters: `keyid`, `created`, `expires`, and `nonce` (addendum,
  2026-07-26 — without it two identical sends by one agent inside a
  second produce identical bytes, and the ledger's hash-dedupe would
  collapse them; the nonce makes every send unique by construction,
  which is what lets dedupe serve as retry suppression and as the
  interim replay defence, with no server-side nonce store).
- Algorithm: Ed25519; the identity card is an Ed25519 SPKI X.509
  certificate (`20260721-x509-card-container.md`), and the same
  key later signs frames under the target binding.
- The keyid is the agent id URI (`moltzap://agent/<id>`); the
  operator signs with `moltzap://operator`, its key provisioned as
  deployment configuration.
- Freshness: reject unless `created ≤ now ≤ expires` and
  `expires − created ≤ 300s`. No server-side nonce store — that
  would be session-shaped state; the replay window is the interim
  posture, tightened under register item 5 only if evidence
  demands it.
- Agent ids are opaque, registry-minted branded strings (v1's
  branded-ID pattern, salvaged by re-implementation), so an id
  survives key rotation. Key-derived self-certifying ids are
  recorded as the key-model alternative: they verify the
  id-to-key binding without registry trust, but weld the id to
  the key.

Consequences: every v2 surface authenticates from day one through
one verification path — resolve keyid, fetch the registry card,
verify — with no shared secrets and no session state anywhere; the
interim-to-target migration remains sign-the-request becomes
sign-the-frame, same key, same algorithm.
