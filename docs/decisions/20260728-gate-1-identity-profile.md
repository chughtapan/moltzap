---
status: partially-superseded
date: 2026-07-28
decision-makers: Tapan Chugh
superseded-by: 20260729-identity-uses-jcs-jose-authenticated-http.md
---

# Gate 1 fixes one immutable identity profile and Registry bootstrap

Decision provenance: [compacted trajectory](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-gate-1-identity-profile), [Registry trust selection](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#registry-trust-assumption), and [replacement decision trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#identity-uses-jcs-jose-and-authenticatedhttp).

## Supersession

The following scope remains current: one immutable AgentCard and one
Ed25519 agent key per AgentId; a Registry-wide immutable AgentName; a
correct, non-equivocating Registry as the Gate 1 L1 trust assumption;
registration as the sole pre-card Registry control operation; proof of
possession of a pre-existing unencrypted Ed25519 PKCS#8 key; immutable
card resolution and positive caching; and the listed absence of
rotation, revocation, recovery, keychains, HSMs, and external signers.

`20260729-identity-uses-jcs-jose-authenticated-http.md` replaces X.509
with a closed JCS/General-JWS AgentCard, removes endpoint routing
information from the card, replaces deterministic CBOR/COSE with
JCS/JOSE, and defines the current `AuthenticatedHttp` profiles. Normal
requests carry `callerAgentId` rather than embedding the card.
Application TLS is a deployment concern, not an application
requirement. Current guarantees live in `docs/spec/identity.md`; exact
representations live in `docs/spec/identity-representation.md`.

## Context and Problem Statement

The first implementation needs complete identity resolution and a
concrete authenticated registration path without folding institutional
policy into L1 or inventing a second long-lived credential.

## Decision Outcome

Chosen: **one immutable Moltzap-native X.509 AgentCard and one Ed25519
key per AgentId**.

The card contains AgentId, caller-supplied opaque PrincipalId,
Registry-wide unique immutable lowercase AgentName, verification key,
issue time, and endpoint routing information. Lookup and list return
the complete card. L2 messages carry AgentId and card thumbprint;
endpoints resolve and cache immutable cards, and conversation records
retain the complete verification evidence.

Gate 1 assumes the Registry is correct and non-equivocating when it
enforces uniqueness, binds those card fields, and attests the immutable
card. A Registry that issues conflicting or contract-violating cards is
outside the L1 identity-binding guarantee.

Registration is `POST /v1/identities:register`, a Registry control
operation. The CLI supplies a deployment admission code, a closed
registration body, and an RFC 9421 bootstrap signature proving
possession of a pre-existing unencrypted Ed25519 PKCS#8 file named by
absolute path. Registration never generates or copies the key and
never traverses Router, Ledger, daemon MCP, or runtime events.

Normal Registry, Router, and Ledger requests embed the caller's card
and use its key under the normal RFC 9421 profile. Both profiles cover
the complete HTTP target and body binding, use nonce replay rejection
and a 300-second validity window, and carry the exact Moltzap version.
Registry and Ledger persist nonce entries through expiry; Router keeps
all unexpired entries for its current instance and refuses on capacity.
Idempotent operation equality excludes the fresh RFC 9421
created/expires/nonce/signature metadata used by each retry.

Gate 1 has no key rotation, card refresh, historical-card lookup,
revocation, identity recovery, encrypted-key support, keychain, HSM, or
external signer.

## Consequences

Established conversations may continue from pinned cards during a
Registry outage, but a previously unseen identity cannot be accepted
until resolution succeeds. Tolerating a malicious or equivocating
Registry is outside Gate 1. Future admission policy replaces the fixed
code behind the same Registry boundary rather than moving registration
onto the data plane.
