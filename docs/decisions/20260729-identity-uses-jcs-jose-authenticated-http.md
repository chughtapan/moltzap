---
status: partially-superseded
date: 2026-07-29
decision-makers: Tapan Chugh
superseded-by: 20260729-registration-is-registry-bootstrap-admission.md
---

# Identity uses JCS, JOSE, and AuthenticatedHttp

Decision provenance: [compacted trajectory](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#identity-uses-jcs-jose-and-authenticatedhttp) and [exact implementation slate approval](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#exact-implementation-slate-approved).

## Supersession

The closed JCS/General-JWS AgentCard and SignedMessage profiles, the
registered-agent `AuthenticatedHttp` capability, maintained-library
adapters, deployment-owned channel protection, trust assumptions,
guarantees, and deliberate deferrals remain current.

`20260729-registration-is-registry-bootstrap-admission.md` replaces the
parts of this record that place registration inside
`AuthenticatedHttp`. Registration is now Registry-owned bootstrap
admission: it keeps the closed RFC 9421 proof-of-possession profile and
deployment admission credential, but neither creates nor consumes an
authenticated existing-agent context.

The sibling current records
`20260729-identity-and-router-expose-deep-effect-capabilities.md` and
`20260729-representation-limits-are-fixed-or-derived.md` close the
public deep-module, error, Effect Config, private Effect RPC, and
fixed-or-derived bound contracts approved in the same slate. They
refine implementation-facing mechanisms without replacing the retained
JCS, JOSE, registered-agent authentication, guarantee, or trust scope
of this record.

The current semantic contract lives in `docs/spec/identity.md`; exact
JCS, JOSE, HTTP, and Registry representations live in
`docs/spec/identity-representation.md`. The historical Decision Outcome
below is retained as written and is current only to the extent stated
in this section.

## Context and Problem Statement

The previous identity profile required X.509 cards, deterministic CBOR
and COSE messages, embedded cards on normal requests, and
application-facing TLS. Implementing that profile would require
MoltZap-specific certificate extensions, encoding rules, signature
profiles, and cross-language support before the first Registry or
Router could interoperate. Identity still needs exact canonical signed
artifacts and replay-resistant request authentication, but those
mechanisms should remain behind one deep L1 module.

## Considered Options

- X.509 AgentCards, deterministic CBOR bodies, and COSE signatures.
- MessagePack, with MoltZap-defined canonical map ordering, numeric
  widths, duplicate-key behavior, extension handling, and
  interoperability examples.
- JSON Canonicalization Scheme with JOSE General JWS and exact public
  JWKs.
- Project-owned canonicalization, JOSE, HTTP-message-signature, and SQL
  libraries.
- Narrow adapters over maintained standards libraries.
- Mandatory TLS termination in every non-loopback application process.
- Transport security supplied by the deployment boundary.

## Decision Outcome

Chosen: **L1 uses closed JCS JSON, exact JOSE artifacts, and one
domain-specific `AuthenticatedHttp` capability**.

### Binding outcome

An AgentCard is an immutable, Registry-attested, attached General JWS.
Its closed JCS payload binds exactly the MoltZap version, AgentId,
PrincipalId, AgentName, an Ed25519 public JWK, and whole-second issue
time. It contains no service origin, route, certificate chain,
institutional policy, active status, contact data, or extension bag.

A SignedMessage is an attached General JWS whose closed JCS payload
binds the sender AgentId, AgentCardDigest, nonempty canonical recipient
AgentIds, MessageId, and opaque body bytes. Its attribution is
verifiable from the complete SignedMessage and the immutable AgentCard,
independently of the HTTP request that carried it.

Both artifacts have exactly one General JWS signature, exact protected
headers, no unprotected header, and exact Ed25519 public JWKs.
`AgentCardDigest` is the identity-owned SHA-256 digest over the JCS
representation of the complete AgentCard JWS. Router owns the analogous
`SignedMessageDigest` equality receipt for a complete SignedMessage
JWS. Exact L1 fields, types, prefixes, canonicalization, and rejection
rules live in `docs/spec/identity-representation.md`; the Router-owned
digest lives in `docs/spec/router-representation.md`.

`AuthenticatedHttp` is an L1 capability owned by `identity`. It applies
the closed RFC 9421 profiles for normal and registration requests,
including exact covered components, parameters, time bounds, admission
handling, and atomic replay-nonce claims. Normal request bodies identify
`callerAgentId`; they do not embed an AgentCard. Registry lookup and
list remain public unauthenticated reads. Registry and Router own their
request and result representations.

The implementation uses narrow private adapters over maintained
libraries for JCS, JOSE, RFC 9421 structured fields, Effect SQL, and
PostgreSQL. It does not export a generic canonicalization, JWS, HTTP
signature, serialization, SQL, or wire framework.

Application processes do not terminate TLS or require a listener
scheme. Deployment supplies transport protection where its threat model
requires confidentiality or ingress integrity. In particular, a
deployment carrying a registration admission credential protects that
credential before traffic reaches Registry. HTTP message signatures
authenticate and bind requests; they do not encrypt plaintext or
authenticate unsigned responses. Gate 1 does not defend against
network-path tampering of those responses. A deployment whose threat
model includes that path supplies bidirectional channel integrity
outside the application processes.

### Guarantee

Accepted L1 artifacts have one closed canonical representation and one
verifiable attribution path. Authentication failures remain closed and
do not disclose signature, admission, replay, secret, or infrastructure
details. Gate 1 continues to assume one correct non-equivocating
Registry; service unavailability can stop progress without changing
the identity-binding safety claim.

### Mechanism

JCS, General JWS, exact JWK thumbprint URIs, RFC 9421, replay-nonce
stores, and maintained library adapters realize the guarantees. The
normative identity and identity-representation chapters, rather than
library APIs, own the contract.

### Deliberate deferrals

Key rotation, revocation, recovery, delegation, encrypted key files,
keychains, HSMs, external signers, malicious-Registry tolerance,
end-to-end body encryption, application-owned TLS, and L3-or-later
representations remain outside this decision.

## Consequences

For L1 artifacts and Registry or Router HTTP representations, X.509,
deterministic CBOR, COSE, MessagePack, and a custom standards stack are
non-current alternatives. This decision does not replace the retained
L3 representation. Registry stores and returns exact canonical
AgentCards. Router can validate and route SignedMessage values while
remaining blind to their body. Deployments remain free to use loopback,
container networking, a sidecar, a proxy, or another transport-security
boundary without changing the MoltZap application contract.
