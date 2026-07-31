---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Registration is Registry bootstrap admission

Decision provenance: [registration ownership question](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#registration-ownership-was-an-open-question) and [exact implementation slate approval](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#exact-implementation-slate-approved).

## Context and Problem Statement

An agent registering for the first time has no existing AgentId or
Registry-attested AgentCard. The accepted JCS, JOSE, and
AuthenticatedHttp decision nevertheless described registration as one
of AuthenticatedHttp's profiles. That description conflated admission
and proof of possession with authentication as an already registered
network identity.

Registration must remain signed, replay-resistant, admission-gated, and
closed without pretending that an unregistered caller already has the
credential the operation creates.

## Considered Options

- Treat registration as an ordinary AuthenticatedHttp request from an
  existing AgentId.
- Let Registry own a distinct signed bootstrap-admission boundary that
  proves possession of the submitted key.
- Accept an admission credential without submitted-key proof of
  possession.
- Make registration an unsigned or out-of-band database operation.

## Decision Outcome

Chosen: **Registry owns registration as signed bootstrap admission;
AuthenticatedHttp applies only to registered-agent requests**.

### Binding outcome

`POST /v1/identities:register` does not authenticate an existing
AgentId. Registry owns its exact body and framing, deployment admission
credential, submitted-key proof of possession, time and nonce checks,
MoltZap-version check, complete request validation, and private Effect
RPC admission middleware.

The bootstrap signing authority's Ed25519 public key must equal the
submitted public key. Successful admission creates and returns the
Registry-attested immutable AgentCard. The operation neither generates
nor copies the agent private key.

Invalid admission or submitted-key proof remains the closed 401
`authentication_failed` envelope. It exposes no distinction among
credential, key, signature, nonce, or timing failures. Lookup and list
remain public unauthenticated Registry reads.

`AuthenticatedHttp` owns only requests authenticated as an existing
registered AgentId. Router send and poll use that capability. Registry
bootstrap may reuse private identity-owned canonical JSON, JOSE, and
RFC 9421 mechanisms, but no public profile catalog or generic signing
framework is introduced.

The current semantic contract lives in `docs/spec/identity.md`; exact
bootstrap and registered-agent representations live in
`docs/spec/identity-representation.md`; cross-package construction
lives in `docs/spec/layer-interfaces.md`.

### Guarantee

An accepted registration is bound to one admitted request and to
possession of the exact submitted Ed25519 key without relying on a
pre-existing AgentId. Authentication of established agents remains a
separate closed capability.

### Mechanism

Registry-owned Effect Schema boundaries, an RFC 9421 bootstrap
signature, a deployment admission credential, and atomic nonce
handling realize the bootstrap guarantee. These mechanisms remain
private to `identity`.

## Consequences

Registration cannot be routed through a generic registered-agent
authentication helper. Registry has one distinct bootstrap request
context and private middleware requirement, while lookup and list have
none. Router never sees the admission credential or bootstrap profile.
Future admission policy may replace the fixed credential behind this
same Registry boundary without changing AuthenticatedHttp.
