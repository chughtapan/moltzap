---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# One wire profile assigns every Gate 1 byte

Decision provenance: [compacted trajectory](../decision-evidence/20260729-phase-2a-wire-profile-trajectory.md#20260729-wire-profile-assigns-every-gate-1-byte), whose Phase 2A requirement originates in the [Gate 1 engineering review ledger](../decision-evidence/20260728-gate-1-engineering-review-trajectory.md#20260728-network-wire-is-http-post-polling).

## Context and Problem Statement

The Gate 1 architecture freeze fixed carrier, encoding discipline,
guarantees, and failure behavior, but deliberately assigned no
byte-level constant. Phrases such as "fixed numeric map keys",
"domain-separated COSE profiles", "MoltZap extension OIDs", and
"opaque PollCursor" constrain a profile without being one.

Six implementation lanes — identity, transport, transcript, endpoint,
the simulator port, and the vector corpus — all consume the same
bytes. Every value left unassigned is a value each lane invents
separately, and the mismatch surfaces only when two of them first
exchange a signature or a hash. Unanimity makes that worse: an action
certificate is valid only if every member agrees byte for byte, so a
single disagreement about map key order, float width, or Ed25519
verification criteria is a liveness failure rather than a decoding
warning.

The approved plan therefore blocks all product, protocol,
simulator-port, client, and server implementation at Phase 2A until
one catalog exists.

## Decision Outcome

Chosen: **`docs/spec/wire-profile.md` is the single normative catalog
of every Gate 1 byte-level constant, and an absent constant is a
catalog defect rather than an implementation choice.**

The catalog is a normative `docs/spec/` chapter. It assigns; the
semantic chapters keep owning guarantees and failure behavior. Where a
chapter fixes a value, the catalog restates it as a constraint and
never widens it. No implementation may introduce a wire constant, map
key, tag, OID, domain string, prefix, status code, or schema that the
catalog does not assign, and no implementation-local default fills a
gap in it.

The choices below are the load-bearing ones. Every other assignment is
mechanical detail the catalog owns in full.

**Namespace.** The MoltZap OID arc is
`2.25.207290692779462626256938133231573616585`, the ITU-T X.667 UUID
arc applied to `uuid5(NAMESPACE_DNS, "moltzap.xyz")`. It requires no
registration authority, cannot collide, and is reproducible by anyone.
The rejected alternative was an unregistered IANA Private Enterprise
Number arc, which is squatting on a namespace the project does not
own.

**Attestation chain.** An AgentCard chain is exactly one certificate.
The trust anchor is the Registry attestation Ed25519 public key, held
as deployment configuration. No CA certificate travels on the wire,
PKIX path building is absent, and CRL, OCSP, and `authorityInfoAccess`
retrieval never occur. The issuer distinguished name is a fixed
constant compared as a format check; trust comes solely from the
pinned key. A verifier holding only that 32-byte key and a
`TranscriptRecord` completes every verification step offline.

**Encoding shape.** Closed MoltZap maps use small positive integer
keys, permanently assigned and never reused. Closed unions are a
two-element array whose first element is a lowercase `snake_case` text
discriminant, so a wire dump stays readable while remaining closed.
`JsonValue` numbers are a CBOR integer or IEEE-754 binary64 and
nothing else — a deliberate deviation from RFC 8949 preferred-float
shortest-form, because JSON has no float-width concept and
shortest-form would let two conforming encoders disagree on the bytes
of one document.

**Derivations.** Every hash and derived identifier uses one
construction: SHA-256 over the deterministic CBOR encoding of an array
whose first element is a literal domain constant. CBOR's own length
prefixes make each preimage unambiguous, so no separator, length, or
padding convention exists. The two X.509 thumbprints are the
deliberate exceptions and are a bare SHA-256 over DER, matching
universal tooling.

**Self-delivery.** A protocol message includes its sender in the
recipient set exactly when the message's effect on any member's fold
depends on its position in the global Router order. `begin` is the
only such kind, so every member — the contender included — decides the
winning candidate from the identical delivery feed. Every other kind
excludes its sender.

**HTTP split.** The HTTP status describes the request envelope; the
CBOR discriminant describes the domain outcome. Every authenticated,
well-formed, version-matched domain POST returns 200 with a closed
tagged result, including domain refusals such as `feed_gap`,
`stale_base`, and `idempotency_conflict`. The envelope error taxonomy
is closed and its bodies carry no reason string.

**Signed facts are not duplicated.** A `TranscriptRecord` carries the
storage key, the chain fields, and the complete certificate. The
author, content, selection, `ReplyFingerprint`, Router instance, and
member verification descriptor live inside the signed action binding
and are present by containment. There is no unsigned copy of a signed
fact that could disagree with it.

**Verification is closed.** Ed25519 verification is cofactorless, with
canonical `S` and `R` and small-order public keys rejected. Ed25519
libraries differ here, and in a unanimity protocol a permissive and a
strict verifier disagreeing about one signature is a split view rather
than a local error.

**Deployment inputs.** Exactly three values stay per-deployment: the
Registry attestation key, the registration admission code, and the
service routes. The catalog fixes their exact type and validation.
Everything else on the wire is a protocol constant, and operational
bounds never appear in a MoltZap structure.

**The corpus is specified here and built next.** The catalog fixes the
vector fixture material, the positive vector inventory, every
rejection class with its exact expected outcome, and the CI
obligations — including that CI fails when a wire constant appears in
implementation source without appearing in the catalog. Producing the
corpus is a separate deliverable; the choices it would otherwise make
are already made.

## Consequences

Implementation may begin against a complete byte contract once the
corpus passes. Until then the plan's block stands: the catalog alone
does not unblock Phase 3 or Phase 4.

The check that keeps the catalog authoritative rather than descriptive
is the CI rule that rejects a wire constant present in source and
absent from the chapter. Without it the catalog degrades into
documentation of whatever the code happened to do, which is the
failure this decision exists to prevent.

Verbosity is accepted. A three-member action certificate carries every
member's complete card because a record must verify with no live
Registry. `control-plane.md` already permits later physical
compression on the condition that reads reconstruct these identical
bytes, so the cost is recoverable without a contract change.

Strictness is accepted. There is no extension bag, no
reserved-for-future field, and no unknown-field tolerance, so no wire
meaning can be added compatibly. Every wire change updates the
catalog, a new accepted ADR, the vector corpus, and the exact
`v2/VERSION` value together.

Three narrower consequences follow from named choices. Marking the
routing extension critical means a generic PKIX validator rejects a
MoltZap card, which is intended: a card is unusable without its routes
and is not a TLS credential. Pinning the Registry attestation key as
deployment configuration means a deployment that loses that key cannot
verify existing cards, and Gate 1 has no rotation or recovery path for
it. Admitting only `https` in a service route puts the mandatory-TLS
rule of `identity.md` in the card itself, with no loopback carve-out,
so a testbed or a local run acquires TLS at the platform edge like any
other deployment rather than downgrading the wire.

The `moltzap.xyz`-derived OID arc, the identifier prefixes, and the
`openfloor.v1.speak` action identifier are public namespace choices
made in this record. Replacing any of them later is a wire change with
a version bump, not a refactor.
