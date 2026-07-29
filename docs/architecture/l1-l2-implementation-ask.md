# L1 and L2 implementation ask

Status: **APPROVED IMPLEMENTATION ASK — BLOCKED ON AUTHORITY GATE**

Governing architecture:
[`20260728-gate-1-architecture-freeze.md`](../decisions/20260728-gate-1-architecture-freeze.md)

Broader execution plan:
[`first-implementation.md`](./first-implementation.md)

This document is the durable implementation handoff for the first L1
and L2 production slices. It records the complete current ask in one
place so an implementer does not need chat or private agent state.

This document is an execution plan, not normative protocol authority.
The v2 constitution, current ADR outcomes, and normative specification
chapters remain authoritative in the order stated by `AGENTS.md` and
`v2/AGENTS.md`. Candidate ADR and specification changes in this ask
must land atomically and pass the repository blind teammate review gate
before implementation code starts.

## Outcome

The implementation establishes:

1. one deep `identity` package that owns L1 refined values, canonical
   JSON, JOSE attribution, authenticated HTTP, a Registry client, and a
   PostgreSQL Registry server;
2. one deep `router` package that owns L2 opaque-message routing, a
   Router client, and a bounded in-memory Router server;
3. explicit separation between Registry control operations and Router
   data-plane operations;
4. no custom serialization, JOSE, HTTP-signature, SQL, cache, or
   container framework where a maintained standard library already
   supplies the mechanism;
5. public vocabulary that a human has approved and that remains stable
   throughout implementation; and
6. a human readability review for every implementation slice.

The Router is stateless across restart. It keeps only bounded,
process-local state required to serve its current instance. It has no
durable cursor state, recipient queue, conversation state, delivery
record, or server-side poll advancement.

## Run constraints

- The existing Agent Code Guard version remains unchanged in this run.
- The implementation uses the current `v2` branch and preserves all
  unrelated user changes.
- No v2 implementation imports from `packages/*`.
- No application process terminates TLS or requires a particular
  listener scheme. TLS and network encryption are deployment
  responsibilities.
- A deployment that carries a registration admission credential must
  protect it in transit before traffic reaches the Registry process.
  HTTP message signatures authenticate and bind a request; they do not
  make plaintext confidential.
- Application listeners default to loopback. Container deployments may
  explicitly bind `0.0.0.0`.
- Publishing, deployment, cutover, and v1 retirement remain out of
  scope.

## Human gates

### Vocabulary gate

Public names are human-gated. An implementer may use only the approved
vocabulary below. A proposed public rename or new public domain term
stops the slice for human review before it enters an ADR, specification,
export, route, error, configuration key, or generated document.

Approved vocabulary:

| Concept | Public name |
|---|---|
| L1 identity service | `Registry` |
| L1 server capability | `RegistryServer` |
| L2 opaque routing service | `Router` |
| L2 server capability | `RouterServer` |
| shared request-authentication capability | `AuthenticatedHttp` |
| immutable Registry identity statement | `AgentCard` |
| attributed opaque L1 message | `SignedMessage` |
| digest of a complete AgentCard JWS | `AgentCardDigest` |
| digest of a complete SignedMessage JWS | `SignedMessageDigest` |
| opaque client-held Router continuation | `PollCursor` |

`HarnessEndpoin` is the literal human-selected name for the future
public endpoint-facing harness concept. The current source does not
authorize silently normalizing it to `HarnessEndpoint`. Neither name is
introduced by the L1 or L2 slices, so a future slice confirms the exact
spelling at its vocabulary gate.

Retired public vocabulary:

- `Directory` and `DirectoryServer`;
- the `transport` package name;
- `Delivery`;
- `RouterSequence`;
- `wire catalog`;
- `vector corpus`;
- generic public `wire`, `codec`, `serialization`, or `protocol`
  modules.

Tests may use plain descriptions such as fixtures, examples, valid
representations, and invalid representations. They do not create a
public “test-vector” abstraction.

### Readability gate

Each slice ends with a human readability review before the next slice
starts. The review checks:

- names match the vocabulary table;
- one concept has one name across code, tests, errors, configuration,
  and docs;
- public interfaces reveal the domain contract and hide mechanisms;
- errors are closed, typed, and actionable without exposing secrets or
  infrastructure causes;
- comments explain only hidden constraints or surprising invariants;
- files and symbols can be understood without this implementation ask;
  and
- no generic helper has escaped merely because two internal call sites
  share mechanics.

The review disposition is recorded with the slice. A requested
vocabulary change returns to the vocabulary gate.

## Authority gate

The current repository still makes X.509, CBOR, COSE, a cross-layer
wire profile, mandatory application-facing TLS, and the `transport`
package current. Code against the replacement design is blocked until
the following authority change is complete.

### Candidate ADRs

The authority change admits four focused records:

1. `20260729-v2-authority-lives-with-v2.md`
2. `20260729-representations-are-layer-owned.md`
3. `20260729-identity-uses-jcs-jose-authenticated-http.md`
4. `20260729-router-order-is-opaque.md`

Each record:

- has MADR-minimal frontmatter;
- names Tapan Chugh as the human decision-maker;
- links the relevant stable heading in
  `docs/decision-evidence/20260729-l1-l2-implementation-trajectory.md`;
- states guarantees separately from mechanisms;
- records the considered alternatives named below; and
- updates the decision index, freeze manifest trace row, normative owner,
  affected specifications, and supersession lineage in the same
  candidate revision.

### Alternatives retained in the records

The records retain these alternatives as non-current choices:

- one main-branch specification tree versus v2 authority living with
  the v2 track;
- one cross-layer byte catalog and shared vector corpus versus
  representation chapters owned separately by each layer;
- X.509, deterministic CBOR, and COSE versus JCS, General JWS, and
  exact public JWKs;
- MessagePack versus JSON representations using JCS and JOSE;
- custom canonicalization, signing, HTTP-message-signature, and SQL
  libraries versus narrow adapters over maintained standards
  libraries;
- application-mandated TLS versus transport security supplied by the
  deployment;
- exposing Router sequence values versus an opaque authenticated
  `PollCursor`;
- durable or per-recipient Router state versus one bounded volatile
  global feed with client-held continuation; and
- a control-plane-shaped `transport` package versus a data-plane
  `router` package.

### Supersession and traceability

The authority candidate:

- fully supersedes
  `20260729-wire-profile-assigns-every-gate-1-byte.md`;
- fully supersedes `20260721-x509-card-container.md`;
- fully supersedes `20260722-spec-lives-on-main.md`;
- partially supersedes `20260728-gate-1-identity-profile.md`;
- partially supersedes
  `20260728-network-wire-is-http-post-polling.md`;
- partially supersedes
  `20260728-six-deep-packages-one-version.md`;
- partially supersedes
  `20260728-gate-1-architecture-freeze.md`;
- partially supersedes
  `20260727-code-first-simulator-kernel.md`; and
- updates any older record whose current status or visible
  `Supersession` section would otherwise leave contradictory guidance.

The retained portions of partially superseded records remain explicit.
No cold reader has to infer which paragraph survives.

The candidate reconciles retained-scope prose in at least:

- `20260721-native-principal-shaped-card.md`;
- `20260721-physical-plane-split.md`;
- `20260721-sessionless-network.md`;
- `20260721-single-credential.md`;
- `20260721-v2-lives-top-level.md`;
- `20260722-control-plane-encoding.md`;
- `20260723-directory-serves-cards.md`;
- `20260723-interim-signature-profile.md`;
- `20260726-attribution-binds-to-the-message.md`; and
- `20260727-registration-is-out-of-band.md`.

`20260727-code-first-simulator-kernel.md` receives the provenance link
required by current ADR law. If the original decision source is not
locatable, its trajectory records that source gap instead of
reconstructing rationale.

The candidate also:

- reconciles `AGENTS.md`, `v2/AGENTS.md`, and `v2/VISION.md`;
- adds `docs/spec/identity-representation.md`;
- adds `docs/spec/router-representation.md`;
- renames `docs/spec/data-plane.md` to `docs/spec/router.md`;
- updates the normative specification readiness matrix;
- removes `docs/spec/wire-profile.md` from the current normative tree;
- leaves L3 and later representation choices explicitly deferred; and
- revises architecture orientation and this implementation ask only
  where needed to agree with the new authority.

### Blind teammate review

The exact authority candidate is frozen as a commit or reproducible
content digest. A fresh reviewer with no inherited conversation or
private state receives only the candidate repository root and the six
questions required by `AGENTS.md`.

The reviewer does not open, read, or search existing
`*-cold-review.md` or invalid-review records. The review artifact
records the candidate identity, exact prompt, isolation attestation,
duration, unedited answers, independently discovered paths and
headings, discovery trail, author interventions, per-question
verdicts, blockers, and overall result.

Implementation remains blocked until the review passes and the
maintainer accepts the result.

## Package graph and release identity

V2 continues to contain exactly six deep packages:

| Package | Owns |
|---|---|
| `identity` | L1 contracts, Registry client, PostgreSQL Registry server, `moltzap-registry` |
| `router` | L2 contracts, Router client, in-memory Router server, `moltzap-router` |
| `transcript` | L3 contracts, Ledger client and server |
| `endpoint` | endpoint protocol engine, local state, daemon MCP, CLI |
| `simulator` | production-capability system driver and run evidence |
| `testbed` | platform acquisition, processes, faults, and black-box subjects |

The production dependency graph becomes:

```text
router     -> identity
transcript -> identity + router contracts
endpoint   -> identity + router + transcript
simulator  -> identity + endpoint public capabilities
testbed    -> identity + router + transcript + endpoint + simulator
```

The package directory `v2/transport` becomes `v2/router`. Its npm name
becomes `@moltzap/v2-router`. All references, project names, TypeScript
references, dependency constraints, architecture checks, docs, and
generated surfaces change atomically.

The identity binary becomes `moltzap-registry`. The Router binary
remains `moltzap-router`.

`v2/VERSION`, all six package manifests, and `MOLTZAP_VERSION` change
from `2026.729.0` to `2026.729.1` in one slice. MCP and simulator
persisted-schema versions remain independent.

## Shared implementation principles

The implementation follows these rules in every slice:

- Private Effect Schema refinements construct semantic values.
- Each public concept has one validator and one vocabulary term.
- Distinct identifiers and digests remain distinctly branded through
  every internal and public signature.
- Runtime data is decoded at network, environment, SQL, persistence,
  and package boundaries.
- Secrets use `Schema.Redacted` or an equally explicit redacted type.
- Expected failures use closed tagged errors or closed result unions.
- Export barrels are explicit.
- Type canaries assert positive invariants that exist.
- Property tests cover named algebraic properties such as canonical
  round trips, idempotency, ordering, and cursor continuation.
- Integration tests use PGlite over its PostgreSQL socket and real
  PostgreSQL through Testcontainers where concurrency or driver
  behavior matters.
- Generic public `Id`, `Digest`, `Timestamp`, `Base64Url`, wire,
  serialization, JWS, HTTP-signature, cursor, or database-row APIs do
  not exist.

The implementation does not carry forward these v1 debt patterns:

- one generic wire-string or date helper;
- a shared cursor/base64 helper;
- deterministic FNV UUID fixtures;
- throwing boundary decoders;
- casts that downgrade refined values to strings and restore them;
- database type overlays without decoding;
- `UserId` renamed to `PrincipalId` by analogy alone; or
- custom libraries for standards already covered by the selected
  dependencies.

## L1 representation

### Refined values

The identity package owns these values:

| Value | Canonical representation |
|---|---|
| `AgentId` | `agt_` plus canonical unpadded base64url for exactly 16 bytes |
| `PrincipalId` | `prn_` plus canonical unpadded base64url for exactly 16 bytes |
| `OperationId` | `opn_` plus canonical unpadded base64url for exactly 16 bytes |
| `MessageId` | `msg_` plus canonical unpadded base64url for exactly 16 bytes |
| `AgentCardDigest` | `acd_` plus the 43-character unpadded base64url SHA-256 digest |
| `SignedMessageDigest` | `smd_` plus the 43-character unpadded base64url SHA-256 digest |
| `AgentName` | 3 to 32 characters matching `^[a-z0-9]+(-[a-z0-9]+)*$` |
| AgentCard issue time | whole-second UTC `YYYY-MM-DDTHH:mm:ssZ` |

Decoders reject noncanonical spellings. They do not normalize input.
Validated constructors used to simplify fixtures remain test-only.

### Canonical JSON

MoltZap-owned signed JSON uses RFC 8785 JSON Canonicalization Scheme.
Received signed JSON is:

1. decoded as UTF-8;
2. parsed as JSON with duplicate-key rejection;
3. decoded through an exact closed schema;
4. re-encoded into its logical JSON value;
5. canonicalized with JCS; and
6. accepted only when the representation that must be canonical equals
   the canonical bytes.

Canonicalization is an internal identity mechanism. No general-purpose
JCS or JSON codec is exported.

### Public key

The exact public-key representation is:

```json
{
  "crv": "Ed25519",
  "kty": "OKP",
  "x": "<43-character canonical unpadded base64url>"
}
```

Unknown fields are rejected. Private key loading accepts an absolute
path to an unencrypted Ed25519 PKCS#8 document at the CLI or process
boundary. Private key material does not appear in logs, errors, public
models, or Registry storage.

### AgentCard

The exact signed payload is:

```json
{
  "kind": "agentCard",
  "moltzapVersion": "2026.729.1",
  "agentId": "agt_<16-byte-base64url>",
  "principalId": "prn_<16-byte-base64url>",
  "agentName": "example-agent",
  "publicKey": {
    "crv": "Ed25519",
    "kty": "OKP",
    "x": "<43-character-base64url>"
  },
  "issuedAt": "YYYY-MM-DDTHH:mm:ssZ"
}
```

The card contains no service origin, route, certificate chain,
institutional policy, active status, contact data, or extension bag.
Service origins are deployment configuration.

An encoded AgentCard is exactly one attached General JWS:

- outer members are exactly `payload` and `signatures`;
- `signatures` contains exactly one member;
- that member contains exactly `protected` and `signature`;
- the protected header is exactly
  `{"alg":"Ed25519","kid":"<RFC-9278-JWK-thumbprint-URI>","typ":"application/vnd.moltzap.agent-card+jws"}`;
- there is no unprotected header; and
- protected header and payload bytes are JCS representations before
  base64url encoding.

`AgentCardDigest` is SHA-256 over the JCS representation of the complete
General JWS.

### SignedMessage

The exact signed payload is:

```json
{
  "kind": "signedMessage",
  "moltzapVersion": "2026.729.1",
  "senderAgentId": "agt_<16-byte-base64url>",
  "agentCardDigest": "acd_<sha256-base64url>",
  "recipientAgentIds": ["agt_<16-byte-base64url>"],
  "messageId": "msg_<16-byte-base64url>",
  "body": "<canonical-unpadded-base64url>"
}
```

`recipientAgentIds` is nonempty, contains no duplicate decoded ID, and
is strictly ordered by decoded ID bytes. Received payloads that violate
the ordering are rejected rather than normalized. `body` is opaque
bytes and has no L2 interpretation.

An encoded SignedMessage is exactly one attached General JWS with the
same closed shape as AgentCard. Its protected header is exactly
`{"alg":"Ed25519","kid":"<RFC-9278-JWK-thumbprint-URI>","typ":"application/vnd.moltzap.signed-message+jws"}`.

`SignedMessageDigest` is SHA-256 over the JCS representation of the
complete General JWS.

## AuthenticatedHttp

`AuthenticatedHttp` is a deep capability owned by `identity`. It is
shared by Registry and Router because HTTP request authentication is an
L1 guarantee. It is not a generic HTTP framework and does not own
Registry or Router request representations.

Normal authenticated request bodies have the exact outer shape:

```json
{
  "callerAgentId": "agt_<16-byte-base64url>",
  "request": {}
}
```

Registration bodies use:

```json
{
  "request": {}
}
```

Public Registry lookup and list requests are unauthenticated.

### HTTP framing

- Request bodies are JSON.
- `Content-Type` is exactly `application/json`, with no parameters.
- `Accept` is not required.
- `Content-Encoding` is rejected.
- Bodies are read under route-specific byte bounds before parsing.
- Successful responses use exact closed JSON schemas.
- Envelope error bodies are exactly `{"error":"<code>"}`.

### HTTP message signatures

The RFC 9421 signature label is `moltzap`.

Normal requests use the tag `moltzap-request-v1` and cover, in this
exact order:

1. `@method`
2. `@authority`
3. `@path`
4. `@query`
5. `content-digest`
6. `content-type`
7. `moltzap-version`

Registration uses the tag `moltzap-registration-v1` and adds
`authorization` after `moltzap-version`.

Signature parameters are exactly:

- `created`;
- `expires`;
- `keyid`;
- `nonce`;
- `alg`;
- `tag`.

The maximum validity window is 300 seconds. A request may be at most
five seconds in the future. A nonce contains 16 random bytes and uses
canonical unpadded base64url.

Registration admission uses:

```text
Authorization: MoltZap-Admission <token68>
```

The credential length is 8 to 512 characters. It is redacted at every
configuration, error, logging, and diagnostic boundary.

### Verification order

Authenticated requests pass through this order:

1. route and method;
2. framing, media type, body bound, and early concurrency bound;
3. UTF-8, JSON, JCS prelude, and minimum identity extraction;
4. body digest, HTTP signature, admission, and time checks;
5. atomic nonce claim;
6. signed MoltZap version check;
7. complete closed request schema; and
8. domain handler.

A wrong version after otherwise valid authentication consumes the
nonce.

### Envelope failures

| HTTP status | Error code |
|---|---|
| 400 | `malformed` |
| 401 | `authentication_failed` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 412 | `version_mismatch` |
| 413 | `payload_too_large` |
| 415 | `unsupported_media_type` |
| 429 | `overloaded` |
| 503 | `unavailable` |
| 500 | `internal` |

Authentication distinctions, admission details, signature details,
driver failures, and secret material do not appear in public errors.

## Registry

The Registry is an independent L1 HTTP process. It is the control-plane
service in this implementation.

### Routes

- `POST /v1/identities:register`
- `POST /v1/identities:lookup`
- `POST /v1/identities:list`
- `GET /health`

Registration is authenticated with the bootstrap profile. Lookup and
list are public reads. Health has no domain body.

### Requests

Registration request:

```json
{
  "operationId": "opn_<16-byte-base64url>",
  "principalId": "prn_<16-byte-base64url>",
  "agentName": "example-agent",
  "publicKey": {
    "crv": "Ed25519",
    "kty": "OKP",
    "x": "<43-character-base64url>"
  }
}
```

Lookup contains exactly one selector:

```json
{"agentId":"agt_<16-byte-base64url>"}
```

or:

```json
{"agentName":"example-agent"}
```

List request contains only optional `afterAgentId`. Clients do not
choose the page size.

### Results

Registration returns one of:

- `registered`, containing the complete AgentCard;
- `name_taken`;
- `key_already_registered`; or
- `idempotency_conflict`.

Lookup returns `found` with the complete AgentCard or `not_found`.

List returns `page` with `cards` and `hasMore`. Cards are ordered by
decoded AgentId bytes. The repository reads page size plus one to
derive `hasMore`.

### Registration transaction

Idempotency is keyed by submitted-key RFC 9278 JWK thumbprint plus
`OperationId`. The Registry persists the exact canonical inner request
bytes and the exact original result bytes.

Within one serializable transaction, conflict precedence is:

1. an existing idempotency operation;
2. an existing public key;
3. an existing AgentName.

An identical stored operation returns its original result. Changed
canonical request bytes return `idempotency_conflict`. A new operation
for an already registered key returns `key_already_registered`. A new
key for an existing name returns `name_taken`.

The Registry mints a random 16-byte `AgentId`, rounds issue time to the
current whole UTC second, constructs the exact card, and signs it with
the Registry attestation key. A uniqueness collision retries inside
the bounded transaction policy and never escapes as a public raw
database error.

### PostgreSQL ownership

The Registry uses Effect SQL with PostgreSQL and owns:

- immutable identity rows with searchable identity fields and exact
  canonical AgentCard bytes;
- idempotency operation rows with canonical request and result bytes;
- accepted replay nonces through expiry; and
- one metadata row binding the Registry signer thumbprint and exact
  MoltZap version to the database.

Startup serializes against the metadata row. A database created for a
different signer or MoltZap version fails closed.

Registration, idempotency, identity uniqueness, result persistence,
and nonce claims are atomic. No driver-specific error string crosses
the repository boundary.

Tests run the same repository and migrations against PGlite through
its PostgreSQL socket. Real PostgreSQL Testcontainers cover
multi-connection races, serialization retries, rollback, and restart.

`GET /health` returns 204 only when configuration, signer, migrations,
database, and listener are ready. Otherwise it returns 503.

## Router

The Router is an independent L2 HTTP process. It is the data-plane
service in this implementation. It routes SignedMessage values without
interpreting their bodies.

### Refined values

| Value | Canonical representation |
|---|---|
| `RouterInstanceId` | `rti_` plus canonical unpadded base64url for exactly 16 bytes |
| `PollCursor` | `plc_` plus a Compact JWE |

The Router owns `RouterInstanceId` and `PollCursor`.
`SignedMessageDigest` remains owned by `identity`.

The internal global order is a private `bigint`. It never appears in a
public request, result, log field intended as protocol data, or exported
type.

### Routes

- `POST /v1/messages:send`
- `POST /v1/messages:poll`
- `GET /health`

Send and poll use the normal authenticated HTTP profile. Health is
local readiness only and does not depend on Registry availability.

### Send

Request:

```json
{
  "expectedRouterInstanceId": "rti_<16-byte-base64url>",
  "mode": "initial",
  "signedMessage": {}
}
```

`mode` is exactly `initial` or `retry`.

Results:

- `accepted`, containing `routerInstanceId` and
  `signedMessageDigest`;
- `router_restarted`, containing the current `routerInstanceId`;
- `message_invalid`;
- `idempotency_conflict`; or
- `retry_identity_unknown`.

`SignedMessageDigest` equality is evidence for the current live retry
entry only. A digest is not the retry identity.

The Router checks `expectedRouterInstanceId` immediately after
AuthenticatedHttp succeeds and before message resolution,
verification, or feed work.

For `initial`, an existing `(senderAgentId, messageId)` conflicts. For
`retry`, an identical retained message returns its original accepted
result, a changed retained message conflicts, and an evicted or unknown
retry identity returns `retry_identity_unknown`.

The Router resolves the authenticated caller's immutable AgentCard only
on a positive-cache miss. It never resolves recipients. The cache is a
bounded LRU with single-flight misses, infinite success TTL, and zero
failure TTL. Registry unavailability can prevent a new caller from
sending, but does not make Router health unready.

### Volatile feed

One Router process instance owns:

- one random 16-byte `RouterInstanceId`;
- one random 256-bit cursor-encryption key;
- one global count-and-byte-bounded ring containing one copy of each
  accepted SignedMessage;
- one O(1) retry index whose entries are removed with their ring item;
- one bounded replay-nonce set for the current instance;
- one bounded positive AgentCard cache; and
- request-scoped poll waiters grouped by caller AgentId.

The Router owns no durable state. It owns no per-recipient message
copy, recipient queue, session, conversation, transaction, persisted
cursor, or recipient-specific acknowledgment.

The state lock covers only retry lookup, order assignment, append,
eviction, and detaching addressed waiters. JSON parsing,
canonicalization, hashing, Registry lookup, signature verification,
response encoding, and network I/O remain outside the lock.

### PollCursor

`PollCursor` is a client-held, opaque Compact JWE. Its protected header
is exactly:

```json
{
  "alg": "dir",
  "enc": "A256GCM",
  "typ": "application/vnd.moltzap.poll-cursor+jwe"
}
```

Its JCS plaintext is exactly:

```json
{
  "agentId": "agt_<16-byte-base64url>",
  "routerInstanceId": "rti_<16-byte-base64url>",
  "lastScannedOrder": "<unsigned-decimal-bigint>"
}
```

A `PollCursor` has the prefix `plc_` followed by the complete Compact
JWE. It is opaque outside the Router package.

Poll request contains optional `cursor`.

Poll results:

- `batch`, containing `routerInstanceId`, ordered `messages`, and the
  next `cursor`;
- `feed_gap`, containing `routerInstanceId`; or
- `cursor_invalid`.

An omitted cursor returns an immediate empty batch anchored at the
current tail. A continuation scans strictly after
`lastScannedOrder`, filters messages addressed to the caller, advances
past unrelated messages, and does not skip the first addressed message
that would exceed a batch count or byte bound.

Tampering, wrong caller, wrong instance, a future order, malformed
plaintext, a noncanonical decimal, or an old cursor key returns
`cursor_invalid` without disclosing the current instance. A cursor
behind global eviction returns conservative `feed_gap` with the current
instance.

Long polling uses request-scoped `Deferred` waiters. Cancellation
removes the waiter. The Router enforces one held poll per AgentId and a
global held-poll bound. It stores no continuation or response state
after the request ends.

`GET /health` returns 204 when the current process can accept local
work. It does not call Registry.

## Dependencies

Direct dependencies are exact-pinned. Existing compatible Effect
workspace dependencies stay on the repository's Effect 3.22 family.

Production mechanisms:

| Dependency | Version | Purpose |
|---|---:|---|
| `effect` | `3.22.0` | typed effects, services, schemas, concurrency |
| `jose` | `6.2.4` | General JWS, JWK thumbprints, Compact JWE |
| `canonicalize` | `3.0.0` | RFC 8785 JCS |
| `http-message-signatures` | `1.0.6` | RFC 9421 signing and verification |
| `structured-headers` | `2.0.3` | exact structured-field parsing |
| `@effect/sql-pg` | `0.53.0` | PostgreSQL implementation for Effect SQL |

The implementation uses the compatible repository versions of
`@effect/platform`, `@effect/platform-node`, `@effect/sql`, and related
Effect packages. It verifies the exact resolved versions before
editing manifests.

Test mechanisms:

| Dependency | Version | Purpose |
|---|---:|---|
| `vitest` | `3.2.x` | test runner |
| `@effect/vitest` | compatible Effect 3.22 release | Effect test integration |
| `fast-check` | compatible existing release | property tests |
| `@electric-sql/pglite` | `0.4.4` | embedded PostgreSQL engine |
| `@electric-sql/pglite-socket` | `0.1.4` | PostgreSQL socket compatibility |
| `@testcontainers/postgresql` | `10.x` | real PostgreSQL integration |

No dependency is added until its license, maintenance status, runtime
format, and compatibility with Node and the selected Effect versions
are verified. No custom replacement is implemented for one of these
mechanisms.

## Operational configuration

Environment data is decoded once at process startup through a closed
Effect Schema. Every numeric bound is a positive integer in its valid
cross-field range.

Common defaults:

| Setting | Default |
|---|---:|
| host | `127.0.0.1` |
| port | required |
| request queue depth | `32` |

Registry defaults:

| Setting | Default |
|---|---:|
| maximum request body | 64 KiB |
| list page size | 100 |
| concurrent requests | 256 |
| live nonce capacity | 10,000 |
| SQL pool size | 10 |
| SQL acquire timeout | 5 seconds |

Router defaults:

| Setting | Default |
|---|---:|
| maximum request body | 512 KiB |
| maximum opaque body | 256 KiB |
| maximum complete SignedMessage | 384 KiB |
| maximum recipients | 128 |
| retained message count | 4,096 |
| retained message bytes | 64 MiB |
| poll message count | 128 |
| poll response bytes | 1 MiB |
| concurrent requests | 512 |
| held polls | 256 |
| held polls per AgentId | 1 |
| live nonce capacity | 100,000 |
| positive AgentCard cache | 10,000 |
| concurrent Registry lookups | 32 |
| Registry lookup timeout | 5 seconds |
| long-poll hold | 25 seconds |

The public configuration prefixes are `MOLTZAP_REGISTRY_` and
`MOLTZAP_ROUTER_`. Cross-field validation rejects configurations where
an enclosing bound is smaller than the value it must contain.

There is no application TLS, certificate, scheme, or trusted-proxy
configuration. The deployment preserves the signed authority, path,
query, content digest, content type, version, and registration
authorization fields at ingress.

## Implementation slices

### Slice 0: authority and durable contract

- Add the four candidate ADRs and one source-faithful trajectory.
- Apply every supersession and lineage change.
- Update the decision index and freeze manifest.
- Add the two representation chapters and rename the Router chapter.
- Update architecture pages and this ask for consistency.
- Freeze the candidate, run the blind teammate review, and obtain
  maintainer acceptance.

Exit: authority is discoverable and contradiction-free. No product
code exists in this slice.

### Slice 1: vocabulary, package, and release identity

- Rename `v2/transport` to `v2/router`.
- Rename the package, Nx project, imports, dependency edges, and binary
  references.
- Rename `moltzap-directory` to `moltzap-registry`.
- Bump all v2 release identities to `2026.729.1`.
- Keep exactly six packages and preserve the frozen DAG.

Exit: build, typecheck, lint, package-graph checks, version checks, and
human readability review pass.

### Slice 2: refined values and exact L1 representations

- Implement the branded values and closed schemas.
- Implement internal JCS parsing and encoding.
- Implement exact Ed25519 JWK validation and private-key import.
- Implement AgentCard signing, verification, and digest.
- Implement SignedMessage signing, verification, recipient invariants,
  and digest.

Exit: unit, property, independent-library, mutation, type-canary, and
human readability review pass.

### Slice 3: AuthenticatedHttp

- Implement exact request signing and verification.
- Implement closed framing and envelope failures.
- Implement bootstrap admission and normal caller resolution.
- Implement atomic replay-nonce capability interfaces.
- Prove authentication order, version ordering, replay behavior, time
  boundaries, redaction, and failure collapse.

Exit: unit, property, black-box HTTP, mutation, typecheck, lint, and
human readability review pass.

### Slice 4: Registry

- Implement the Registry client and server capability.
- Implement PostgreSQL migrations and repository.
- Implement registration, lookup, list, health, startup metadata, and
  configuration.
- Add PGlite-socket and PostgreSQL Testcontainers integration suites.

Exit: all Registry acceptance tests, concurrency tests, restart tests,
Nx checks, and human readability review pass.

### Slice 5: Router

- Implement the Router client and server capability.
- Implement the instance fence, bounded volatile feed, retry index,
  positive identity cache, replay nonce store, opaque cursor, polling,
  waiters, health, and configuration.
- Add deterministic state-machine, property, concurrency, cancellation,
  capacity, restart, and black-box HTTP tests.

Exit: all Router acceptance tests, Nx checks, and human readability
review pass.

### Slice 6: repository completion

- Run uncached affected and repository-wide Nx checks.
- Run docs formatting, link, Mermaid, generated-document, and
  architecture-boundary checks.
- Run dependency/license audit and forbidden-vocabulary search.
- Run a fresh senior code review, security review of crypto and
  authentication boundaries, and cold-reader public API review.
- Resolve every finding inside the approved contract.
- Record exact commands, results, skipped environment-dependent tests,
  and remaining deliberate deferrals.

Exit: every required check is green, every human gate has a recorded
disposition, and no implementation requirement remains only in chat.

## Required tests

At minimum, the implementation includes:

- refined-value round-trip and rejection properties;
- distinct-brand type canaries;
- strict AgentName and whole-second time validation;
- JCS fixtures including whitespace, ordering, Unicode, numbers,
  duplicate keys, and unknown fields;
- AgentCard and SignedMessage independently produced valid examples;
- protected-header, algorithm, key ID, type, signature-count,
  extra-field, mutation, and wrong-key rejection;
- recipient nonempty, uniqueness, decoded-byte ordering, body
  opacity, and digest properties;
- RFC 9421 signature-base examples and mutation tests;
- media, encoding, size, method, route, digest, signature, timing,
  nonce, admission, version, and closed-schema failures;
- proof that a validly authenticated wrong-version request consumes
  its nonce;
- Registry registration idempotency and exact-result replay;
- Registry conflict precedence and concurrent uniqueness;
- byte-identical Registry reads across restart;
- persistent Registry replay rejection through expiry;
- Registry health and startup metadata mismatch;
- Router initial/retry state-machine properties;
- Router restart fencing and cursor invalidation;
- Router cursor caller binding, tamper rejection, future-order
  rejection, and conservative feed gaps;
- Router continuation with unrelated traffic and batch byte/count
  boundaries;
- one-copy global retention and coupled retry eviction;
- positive-cache single flight, no negative caching, and Registry
  outage behavior;
- long-poll wakeup, timeout, cancellation, per-AgentId exclusivity, and
  global overload;
- nonce-capacity refusal without eviction of a live nonce; and
- Router health independence from Registry.

## Completion evidence

The final handoff records:

- the accepted authority candidate identity and blind-review artifact;
- the exact changed package graph and version;
- the public export inventory by package;
- the dependency inventory with exact versions and licenses;
- the migration inventory;
- test and check commands with results;
- human readability dispositions by slice;
- any environment-dependent test that cannot run and the exact reason;
- deliberate deferrals; and
- a statement that Agent Code Guard was not upgraded in this run.

## Explicit deferrals

This ask does not decide or implement:

- L3 and later representation formats;
- conversations, reliability, transactions, replay, or recovery at L2;
- `HarnessEndpoin` and any normalized spelling;
- Registry malicious-equivocation tolerance;
- key rotation, revocation, recovery, delegation, HSMs, keychains, or
  external signers;
- Router persistence, replication, failover, or stable instance
  identity;
- per-recipient indexes or queues;
- end-to-end body encryption;
- application-owned TLS termination;
- container images, deployment manifests, publishing, cutover, or v1
  retirement; or
- simulator-port work that still depends on its separate provenance
  gate.
