# L1 and L2 implementation ask

{/* @bake-constants: V2_PROTOCOL_VERSION */}

Status: **APPROVED IMPLEMENTATION ASK — AUTHORITY REVIEW REQUIRED BEFORE CODE**

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

## Goal

Ship the reviewed L1 Registry and L2 Router end to end: deep public
capabilities, production clients and servers, persistence or bounded
volatile state as each layer requires, runnable binaries, focused and
integrated tests, documentation, and a human readability disposition
for every implementation slice.

This is the active implementation goal. L3 and L4 implementation and
representation changes remain out of scope, and this ask introduces no
public vocabulary that has not passed the human vocabulary gate.

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
  make plaintext confidential or authenticate unsigned responses.
- Gate 1 does not defend against network-path response tampering. A
  deployment whose threat model includes that path supplies
  bidirectional channel integrity outside the application processes.
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

### Staged public-name gate

The approved `MOLTZAP_REGISTRY_` and `MOLTZAP_ROUTER_` prefixes do not
approve configuration-key suffixes. Before Registry or Router process
configuration enters source, the implementer presents one complete
configuration-key table for literal maintainer approval. The same rule
applies to any public export name not already present in the approved
vocabulary or governing specifications.

These are scheduled human decisions, not implementation discretion or
post-Gate-1 deferrals. Internal work may proceed only until the next
public name would enter source.

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

Before this candidate, repository authority made X.509, CBOR, COSE, a
cross-layer wire profile, mandatory application-facing TLS, and the
`transport` package current. Code against the replacement design stays
blocked until the following authority change and blind review are
complete.

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
- leaves current L3 and later semantic documents and focused ADRs
  unchanged; and
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

Implementation begins only after the review passes and the maintainer
accepts the result.

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

`v2/VERSION`, all six package manifests, and `MOLTZAP_VERSION` advance
together to `2026.729.1` in one slice. MCP and simulator
persisted-schema versions remain independent.

## Shared implementation principles

The implementation follows these rules in every slice:

- Private Effect Schema refinements construct semantic values.
- Each public concept has one validator and one vocabulary term.
- Every closed struct boundary decodes with
  `onExcessProperty: "error"`; defining a `Schema.Struct` without that
  parse option is not treated as closed validation.
- Distinct identifiers and digests remain distinctly branded through
  every internal and public signature.
- Runtime data is decoded at network, environment, SQL, persistence,
  and package boundaries.
- Registry and Router declare each domain operation once as a private
  `@effect/rpc` `RpcGroup` over the route-owned request, success, and
  failure schemas used by their public capabilities. Each member
  declares its success schema, closed operation-level server-error
  schema, and ordered
  `RpcMiddleware` requirements.
- Authentication middleware consumes the nominal proof produced by
  AuthenticatedHttp and provides verified request context to the
  handler. Registration has its distinct verified bootstrap context;
  public Registry reads have no authentication requirement. A
  layer-local capability requirement may be middleware only when its
  failure belongs in the operation's typed error channel. Router never
  gains conversation, membership, task, norm, or policy requirements.
  Required authentication and held-poll middleware is never optional.
- Each operation-level server-error schema contains every closed HTTP
  failure that its fixed client call can receive, including failures
  produced before private RPC dispatch and the closed status 500
  response. Native Effect RPC error schemas add each declared
  middleware failure. Handler and middleware failures travel from the
  server `E` channel to the corresponding client `E` channel; the
  client adapter converts an earlier server-envelope response into the
  same declared operation `E`. Closed domain refusals such as
  `name_taken`,
  `message_invalid`, and `router_restarted` remain values in the
  success result union.
- Connection and timeout failures remain distinct typed client
  transport errors. A response that has an invalid status/body pairing,
  fails its exact schema, or fails required Registry response binding
  or AgentCard verification is a separate typed client response error.
  Its exact public type name remains blocked on the vocabulary gate.
- Requirement order means execution order: authenticated context,
  then any layer-local capability, then the handler. Effect RPC 0.76
  wraps later-attached middleware around earlier-attached middleware,
  so one tiny private composer attaches an operation's declared
  requirements right-to-left. A test pins execution and
  short-circuiting; the ordering is not left to incidental `Set`
  iteration at each call site.
- `RpcGroup.toLayer` composes handlers. The production adapters use
  `RpcServer.makeNoSerialization` and `RpcClient.makeNoSerialization`
  so native middleware execution, schema correlation, and typed exits
  are retained while the adapters map each call to its exact
  layer-owned HTTP route. `RpcTest.makeClient` exercises the same group
  in process.
- Effect RPC types, tags, request IDs, tracing fields, and
  serialization envelopes remain private. Production HTTP uses Effect
  Platform's router and the exact layer-owned routes and bytes; it does
  not use `RpcServer.layerProtocolHttp`, `/rpc`, NDJSON, JSON-RPC, or
  `RpcSerialization`. AuthenticatedHttp still owns the normative
  framing and validation order before an RPC handler can run.
- On the server, the exact HTTP adapter carries the nominal
  AuthenticatedHttp proof into private RPC execution as request-local
  Effect context; the proof is never a body field, header, process
  cache entry, or client-supplied value. On the client, the exact HTTP
  adapter maps the private RPC tag to one fixed route and maps the
  validated response back to that call's private exit. Both adapters
  preserve the operation's `A` and `E` correlation. The server
  validates and encodes the public success or failure representation;
  the client decodes and validates it. No-serialization RPC itself is
  not treated as a boundary decoder.
- The v1 transport is a feature reference, not an implementation
  dependency. V2 retains native middleware gates and typed server
  failures but does not copy v1's dual client/server RPC definitions,
  aggregate error reconstruction, method catalog, multiplexing,
  generic typed dispatcher, or payload re-guards. One native RPC
  member remains the source of the operation's `A` and `E` types.
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

The Gate 1 operation requirements are:

| Operation | Private RPC middleware execution order |
|---|---|
| Registry register | verified bootstrap request context |
| Registry lookup | none |
| Registry list | none |
| Router send | verified agent request context |
| Router poll | verified agent request context, then one request-scoped held-poll permit |

Health routes remain direct HTTP routes outside the RPC groups.
The held-poll permit is native `wrap: true` middleware. It enforces both
the per-AgentId exclusion and global held-poll capacity, fails with the
closed `overloaded` server error, and releases on success, typed
failure, defect, interruption, or client cancellation. No other
capability gate is invented for L1 or L2.

The server HTTP adapter scopes one private `FiberRef` containing the
nominal AuthenticatedHttp proof around `RpcServer.write`. Handler fibers
inherit it. The first authenticated middleware reads the proof, checks
the expected authentication profile, and provides the narrower handler
context. The `FiberRef` defaults to absent, so a direct or incorrectly
adapted private call fails closed. Public lookup and list bypass this
path because their operations deliberately have no authentication
middleware. Handlers use the context or permit supplied by middleware;
they do not repeat the authentication, identity lookup, or capacity
work that obtained it.

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
| `AgentName` | 3 to 32 characters matching `^[a-z0-9]+(-[a-z0-9]+)*$` |
| AgentCard issue time | whole-second UTC `YYYY-MM-DDTHH:mm:ssZ` |

Decoders reject noncanonical spellings. They do not normalize input.
Validated constructors used to simplify fixtures remain test-only.

### Canonical JSON

MoltZap-owned signed JSON uses RFC 8785 JSON Canonicalization Scheme.
Received signed JSON is:

1. bounded and decoded as fatal UTF-8;
2. parsed as one unknown JSON value through `Schema.parseJson()`;
3. checked by a private Effect Schema refinement for depth at most 16
   and well-formed Unicode;
4. compared byte-for-byte with the JCS encoding of that value; and
5. decoded through an exact closed schema.

No semantic value escapes before every step succeeds.
AuthenticatedHttp performs the canonical envelope prelude before
authentication and the complete route-owned schema decode at its
specified later stage.

Effect Schema owns parsing failures, structural refinement, and every
semantic decode. No second JSON parser is used. Although
`Schema.parseJson()` delegates to native `JSON.parse`, a duplicate
member cannot survive the mandatory JCS byte comparison: parsing
collapses it and JCS emits only one member. That same comparison rejects
noncanonical whitespace, member order, and number spelling.

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

The Router-owned `SignedMessageDigest` is SHA-256 over the JCS
representation of the complete General JWS and is defined by the L2
representation.

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
- The request-target query component is absent on every route. Any
  present query component, including an empty one, fails route lookup
  as 404 `not_found`.
- The raw request-target absence check is independent of signature
  verification. Every accepted request signs the RFC 9421 `@query`
  derived value `?`, which does not itself distinguish absence from a
  present empty query.

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

For Router send and poll, stage 7 closes the outer request but retains
`signedMessage` as a bounded raw JSON object and `pollCursor` as a
bounded string. Full SignedMessage and PollCursor decoding belongs to
the Router domain handler, where failures become `message_invalid` and
`cursor_invalid`.

A wrong version after otherwise valid authentication consumes the
nonce.

An already claimed live nonce is `authentication_failed`. A novel
nonce presented when the live-nonce store is full returns status 429
`overloaded`, is not claimed, and never evicts an unexpired nonce.

Public lookup and list skip authentication and replay stages. They
check route and method, framing and bounds, version, canonical body and
schema, then the domain handler. The earliest failing stage determines
the response.

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

Every Registry client receives the deployment-pinned Registry signer
public JWK. It verifies each returned AgentCard and the register,
lookup, or list response binding before returning a nominal verified
domain value.

### Routes

- `POST /v1/identities:register`
- `POST /v1/identities:lookup`
- `POST /v1/identities:list`
- `GET /healthz`

Registration is authenticated with the bootstrap profile. Lookup and
list are public reads. Health has no domain body.

### Requests

Registration inner domain request, placed at `request` inside the
AuthenticatedHttp registration envelope:

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

List returns `page` with `agentCards` and `hasMore`. AgentCards are
ordered by decoded AgentId bytes. The repository reads page size plus
one to derive `hasMore`.

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

Nonce claim is a separately committed atomic replay step before
version, complete schema, and domain handling. Registration then commits
idempotency, identity uniqueness, the exact card, and the exact result
in one later transaction. A later refusal does not roll back a claimed
nonce. No driver-specific error string crosses the repository boundary.

Tests run the same repository and migrations against PGlite through
its PostgreSQL socket. Real PostgreSQL Testcontainers cover
multi-connection races, serialization retries, rollback, and restart.

`GET /healthz` returns 204 only when configuration, signer, migrations,
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

The Router owns `RouterInstanceId`, `SignedMessageDigest`, and
`PollCursor`.

The internal global order is a private `bigint`. It never appears in a
public request, result, log field intended as protocol data, or exported
type.

### Routes

- `POST /v1/messages:send`
- `POST /v1/messages:poll`
- `GET /healthz`

Send and poll use the normal authenticated HTTP profile. Health is
local readiness only and does not depend on Registry availability.

### Send

Send inner domain request, placed at `request` inside the normal
AuthenticatedHttp envelope whose `callerAgentId` is the sender:

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
- one private bigint order whose empty-tail sentinel is `0`, whose first
  accepted entry is `1`, and which increments by one for each later
  accepted entry;
- one private greatest-evicted order initialized to `0`;
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
eviction, scan snapshot, waiter registration, and detaching addressed
waiters. JSON parsing, canonicalization, hashing, Registry lookup,
signature verification, response encoding, network I/O, and waiter
completion remain outside the lock.

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

Poll request contains optional `pollCursor`.

Poll results:

- `batch`, containing `routerInstanceId`, ordered `signedMessages`, and
  the next `pollCursor`;
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
whose last scanned order is less than the greatest-evicted order
returns conservative `feed_gap` with the current instance; equality is
safe.

Long polling uses request-scoped `Deferred` waiters. Cancellation
removes the waiter. The Router enforces one held poll per AgentId and a
global held-poll bound. It stores no continuation or response state
after the request ends.

`GET /healthz` returns 204 when the current process can accept local
work. It does not call Registry.

## Dependencies

Direct dependencies are exact-pinned. Existing compatible Effect
workspace dependencies stay on the repository's Effect 3.22 family.

Production mechanisms:

| Dependency | Version | License | Purpose |
|---|---:|---|---|
| `effect` | `3.22.0` | MIT | typed effects, services, schemas, concurrency |
| `@effect/platform` | `0.97.0` | MIT | platform-neutral HTTP capabilities |
| `@effect/platform-node` | `0.108.0` | MIT | Node HTTP process composition |
| `@effect/rpc` | `0.76.0` | MIT | private typed operation groups, handlers, and in-process contract clients |
| `@effect/experimental` | `0.61.0` | MIT | compatible Effect SQL peer |
| `@effect/sql` | `0.52.0` | MIT | SQL capability, transactions, migrator |
| `@effect/sql-pg` | `0.53.0` | MIT | PostgreSQL implementation for Effect SQL |
| `jose` | `6.2.4` | MIT | General JWS, JWK thumbprints, Compact JWE |
| `canonicalize` | `3.0.0` | Apache-2.0 | RFC 8785 JCS |
| `http-message-signatures` | `1.0.6` | ISC | RFC 9421 signing and verification |
| `structured-headers` | `2.0.3` | MIT | exact structured-field parsing |

Test mechanisms:

| Dependency | Version | License | Purpose |
|---|---:|---|---|
| `vitest` | `3.2.4` | MIT | test runner |
| `@effect/vitest` | `0.30.0` | MIT | Effect test integration |
| `fast-check` | `3.23.2` | MIT | property tests |
| `@electric-sql/pglite` | `0.4.4` | Apache-2.0 | embedded PostgreSQL engine |
| `@electric-sql/pglite-socket` | `0.1.4` | Apache-2.0 | PostgreSQL socket compatibility |
| `@testcontainers/postgresql` | `10.28.0` | MIT | real PostgreSQL integration |

No dependency is added until its license, maintenance status, runtime
format, and compatibility with Node and the selected Effect versions
are verified. No custom replacement is implemented for one of these
mechanisms.

## Operational configuration

Environment data is decoded once at process startup through a closed
Effect Schema. Every numeric bound is a positive integer in its valid
cross-field range.

Registry server composition requires its bind settings, PostgreSQL
URL, admission credential, and absolute Registry-signing private-key
path. Every Registry client receives the Registry origin and the
deployment-pinned exact Registry signer public JWK. Router server
composition therefore receives those two Registry client inputs in
addition to its own bind and bound settings. These are conceptual
inputs only: exact public environment suffixes and exported
configuration type names remain blocked on the human vocabulary gate.

Both processes enforce the fixed 16-container JSON depth bound defined
by their representation chapters. Gate 1 exposes no environment key
for this bound.

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

The Router's 25-second long-poll hold is a fixed Gate 1 value and has
no environment key.

The public configuration prefixes are `MOLTZAP_REGISTRY_` and
`MOLTZAP_ROUTER_`. Cross-field validation rejects configurations where
an enclosing bound is smaller than the value it must contain.

There is no application TLS, certificate, scheme, or trusted-proxy
configuration. The deployment preserves the request body and the
signed method, authority, path, query, content digest, content type,
version, and registration authorization fields at ingress. It also
protects unsigned responses when network-path tampering is in its
threat model.

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
- absent-query enforcement and combined-failure precedence;
- proof that a validly authenticated wrong-version request consumes
  its nonce;
- private RPC middleware executes authenticated context before each
  declared layer-local capability and both before the handler;
- an authentication or capability refusal short-circuits every later
  middleware and the handler;
- middleware-provided context reaches the handler without repeating
  the lookup or admission work that produced it;
- every declared middleware or handler failure crosses the exact HTTP
  adapter from the server `E` channel to the client's corresponding
  typed `E` channel;
- every fixed-route server-envelope response, including a pre-RPC
  refusal and the closed status 500 response, reaches the declared
  operation `E`;
- per-operation type canaries prove the concrete client `E` is exactly
  its closed operation server failures, middleware failures, client
  transport failures, and client response-validation failure rather
  than `unknown`, a widened global union, or an untyped exception;
- type tests reject a handler that emits an error absent from its RPC
  member and reject authenticated operations missing their required
  middleware;
- domain refusals remain success values, declared server failures
  remain typed errors, and connection or timeout failures remain
  distinct client transport errors;
- an undeclared defect becomes the closed status 500 envelope without
  leaking its cause or being fabricated as a domain result;
- malformed responses, invalid status/body pairings, and Registry
  response-verification failures produce the distinct typed client
  response error;
- separate black-box HTTP tests prove strict excess-property rejection
  and the exact status/body representation because in-process
  `RpcTest.makeClient` performs no public serialization;
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

- any change to L3 and later representation formats;
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
