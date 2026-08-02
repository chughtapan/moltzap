# L1 and L2 human review slate

{/* @bake-constants: V2_PROTOCOL_VERSION */}

Status: **DRAFT — HUMAN REVIEW REQUIRED; HARNESS PLACEHOLDER REPLACED**

Implementation handoff:
[`l1-l2-implementation-ask.md`](./l1-l2-implementation-ask.md)

Governing authority:
`v2/VISION.md`,
[`20260728-gate-1-architecture-freeze.md`](../decisions/20260728-gate-1-architecture-freeze.md),
and the current
[`identity.md`](../spec/identity.md),
[`identity-representation.md`](../spec/identity-representation.md),
[`router.md`](../spec/router.md),
[`router-representation.md`](../spec/router-representation.md), and
[`layer-interfaces.md`](../spec/layer-interfaces.md) chapters.

This document is a durable review surface for proposed L1 and L2
implementation choices. It is not normative protocol authority, an
admitted ADR, or evidence that a human approved a name or mechanism.
Items become current only after the maintainer approves them, the
governing ADRs and specifications are reconciled, the candidate is
frozen, and the repository blind-review gate passes.

The slate is intentionally explicit. An omitted public name is not
implementation discretion. A proposed change returns here before it
enters source.

The 2026-08-01 Harness authority resolves the later-layer placeholder
that this L1/L2 review deliberately left open. The current contract uses
the `harness` package, `moltzapd`, and `HarnessClient` as governed by
`docs/spec/harness/` and
[`harness-implementation-slate.md`](./harness-implementation-slate.md).
The production and clean-slate clients target the same minimal semantic
consumer shape. Their exact branch-owned Effect contracts must be admitted
before the compile-time canary; raw MCP representations and implementations
remain separate. Nothing below can revive the old placeholder spelling.

## Registration is Registry bootstrap admission

Registration is not authenticated as an existing AgentId. It proves
possession of the submitted Ed25519 key and presents a deployment
admission credential before the Registry creates an identity.

The proposed ownership is therefore:

- `AuthenticatedHttp` owns only requests authenticated as an existing
  registered AgentId.
- Registry owns registration framing, admission, submitted-key
  proof-of-possession, nonce handling, version handling, and complete
  registration request validation.
- Registry lookup and list remain public unauthenticated reads.
- Registration's private RPC middleware represents successful
  registration admission, not an authenticated-agent context.
- Router send and poll use the registered-agent authentication
  middleware supplied by `AuthenticatedHttp`.

The registration HTTP signature and admission credential remain
mandatory. They establish possession and admission, not an existing
network identity. Invalid admission or proof remains collapsed to the
existing 401 `authentication_failed` envelope unless the maintainer
selects a new public error in this review.

This is a semantic correction to the current wording in
`20260729-identity-uses-jcs-jose-authenticated-http.md`,
`identity.md`, `identity-representation.md`, and
`layer-interfaces.md`. Approval requires those sources, the decision
trajectory, and traceability to change atomically before code.

## Scope and boundaries

- Implement L1 `identity` and L2 `router` only.
- Preserve current L3 and L4 specifications, ADR outcomes, and
  vocabulary.
- Registry is the L1 control-plane service and owns durable PostgreSQL
  identity state.
- Router is the L2 data-plane service and owns bounded process-local
  state only.
- Router owns no conversation, membership, transaction, recovery,
  durable cursor, recipient queue, policy, task, or norm semantics.
- Router retains one global copy of an accepted SignedMessage, not one
  copy per recipient.
- TLS, certificates, trusted proxies, and protection of unsigned
  responses remain deployment concerns.
- Application processes serve ordinary HTTP on the configured bind
  address.
- The MoltZap compatibility value is exactly `2026.729.1`.
- Agent Code Guard remains at the repository's current version during
  this implementation.

## Layer notation is documentation-only

The maintainer selected this vocabulary constraint:

- `L1` and `L2` are documentation shorthand for locating guarantees in
  the architecture.
- Code names domains and capabilities directly: `identity`, `Registry`,
  `router`, and `Router`.
- Numbered layer notation does not appear in package metadata, paths,
  source or test identifiers, comments or JSDoc, runtime strings,
  configuration, errors, fixtures, migrations, or generated code.
- A non-vacuous repository architecture check scans every
  non-documentation file under each v2 package and rejects violations.
- Readability review applies the same rule to every implementation
  slice.

This is already human-selected and is not one of the unresolved
decisions at the end of this slate.

## Package and executable surface

| Entrypoint | Permitted public surface |
|---|---|
| `@moltzap/v2-identity` | L1 values and signed artifacts; verified trust-state types; `AuthenticatedHttp`; `AgentSigningAuthority`; shared HTTP errors |
| `@moltzap/v2-identity/registry` | `OperationId`; Registry requests and results; `Registry`; Registry client errors |
| `@moltzap/v2-identity/registry/server` | `layer`; `StartupError` |
| `@moltzap/v2-router` | L2 values, requests, results; `Router`; Router client errors |
| `@moltzap/v2-router/server` | `RouterServer` |

The production binaries are exactly:

- `moltzap-registry`
- `moltzap-router`

There is no `RegistryClient` or `RouterClient` export. The deep
`Registry` and `Router` capabilities own production client
construction.

## Identity package exports

The following are same-named Effect Schema values and TypeScript
types:

- `AgentId`
- `PrincipalId`
- `AgentName`
- `MessageId`
- `AgentCardDigest`
- `Ed25519PublicKey`
- `AgentCard`
- `SignedMessage`

The Registry subpath exports these same-named Effect Schema values and
TypeScript types:

- `OperationId`
- `RegistryRegisterRequest`
- `RegistryLookupRequest`
- `RegistryListRequest`

The identity root exports these type-only verified values:

- `VerifiedAgentCard`
- `VerifiedSignedMessage`
- `VerifiedAgentRequest`

The Registry subpath exports these type-only capability results:

- `RegistryRegisterResult`
- `RegistryLookupResult`
- `RegistryListResult`

Other identity-root exports are:

- `MOLTZAP_VERSION`
- `AuthenticatedHttp`
- `AgentSigningAuthority`
- the shared HTTP error classes below;
- the proposed signed-artifact error classes below.

The Registry subpath also exports `Registry` and the Registry client error
classes below.

The byte-length operations below are nested members of the exported
`SignedMessage` deep module. They are not additional root exports.

`AgentCard` and `SignedMessage` are parsed, exact, but not-yet-trusted
signed artifacts. Only successful cryptographic verification
constructs `VerifiedAgentCard` or `VerifiedSignedMessage`. Neither
verified type has a public standalone decoder or constructor.

The encoded side of each `AgentCard` and `SignedMessage` Schema is the
exact General JWS JSON representation. Its TypeScript side is an
immutable domain view that retains the exact encoded representation
privately for Schema encoding, signature verification, hashing, and
forwarding. JOSE members do not become the application API.

An `AgentCard` exposes exactly these readonly decoded fields:

- `agentId: AgentId`;
- `principalId: PrincipalId`;
- `agentName: AgentName`;
- `publicKey: Ed25519PublicKey`; and
- `issuedAt: string`.

A `SignedMessage` exposes exactly:

- `senderAgentId: AgentId`;
- `agentCardDigest: AgentCardDigest`;
- `recipientAgentIds: readonly AgentId[]`;
- `messageId: MessageId`; and
- `body: Uint8Array`.

The recipient array and public-key value are immutable snapshots.
`body` is a getter that returns a defensive copy, so application
mutation cannot change the signed representation. Fixed `kind` and
MoltZap-version members remain representation invariants rather than
duplicate domain fields.

`VerifiedAgentCard` and `VerifiedSignedMessage` are nominal subtypes of
their untrusted counterparts with the same readable fields. Successful
verification adds only the inaccessible trust brand; it does not wrap
the value in a second object or duplicate its claims.

`VerifiedAgentRequest` is a nominal, type-only value with exactly:

- `callerAgentId: AgentId`;
- `agentCard: VerifiedAgentCard`; and
- `request: unknown`.

The route-owned request remains `unknown` until its complete Schema
decodes it. The inaccessible brand, verified AgentCard, and caller
binding are constructed only by `AuthenticatedHttp`; no Schema,
constructor, or decoder is exported. Carrying the verified card lets
Router verify the caller's SignedMessage without repeating Registry
resolution.

Registry result types are not standalone parsing Schemas. Their
private HTTP response schemas parse exact representations first; the
client verifies signatures and request bindings before constructing
the public verified result.

`AgentCardIssuedAt` is not a separate export. Whole-second UTC
validation remains part of `AgentCard`.

## Router root exports

The following are same-named Effect Schema values and TypeScript
types:

- `RouterInstanceId`
- `SignedMessageDigest`
- `PollCursor`
- `RouterSendRequest`
- `RouterSendResult`
- `RouterPollRequest`
- `RouterPollResult`

Other router-root exports are:

- `Router`
- `RouterConnectionError`
- `RouterRequestTimeoutError`
- `RouterInvalidResponseError`

Router poll results deliberately contain parsed, bounded, untrusted
`SignedMessage` values. The Harness backing verifies every returned message
before accepting the returned PollCursor.

## Refined value vocabulary

| Value | Exact form |
|---|---|
| `AgentId` | `agt_` plus the 22-character canonical unpadded base64url encoding of 16 bytes |
| `PrincipalId` | `prn_` plus the 22-character canonical unpadded base64url encoding of 16 bytes |
| `OperationId` | `opn_` plus the 22-character canonical unpadded base64url encoding of 16 bytes |
| `MessageId` | `msg_` plus the 22-character canonical unpadded base64url encoding of 16 bytes |
| `AgentCardDigest` | `acd_` plus the 43-character canonical unpadded base64url SHA-256 digest |
| `RouterInstanceId` | `rti_` plus the 22-character canonical unpadded base64url encoding of 16 bytes |
| `SignedMessageDigest` | `smd_` plus the 43-character canonical unpadded base64url SHA-256 digest |
| `PollCursor` | `plc_` plus the exact authenticated Compact JWE |
| `AgentName` | 3–32 lowercase ASCII characters matching `^[a-z0-9]+(-[a-z0-9]+)*$` |

The public key concept is `Ed25519PublicKey`, not
`Ed25519PublicJwk`. JWK is its exact private representation mechanism.

## Registry operations

| Capability method | Request | Result variants | HTTP route |
|---|---|---|---|
| `Registry.register` | `RegistryRegisterRequest`: `operationId`, `principalId`, `agentName`, `publicKey` | `registered` with verified `agentCard`; `name_taken`; `key_already_registered`; `idempotency_conflict` | `POST /v1/identities:register` |
| `Registry.lookup` | `RegistryLookupRequest`: exactly one of `agentId` or `agentName` | `found` with verified `agentCard`; `not_found` | `POST /v1/identities:lookup` |
| `Registry.list` | `RegistryListRequest`: optional `afterAgentId` | `page` with verified `agentCards` and `hasMore` | `POST /v1/identities:list` |

Registration separately receives the redacted admission credential
and bootstrap `AgentSigningAuthority`. The client requires the
authority's public key to equal the request's `publicKey`.

Lookup and list receive no admission credential or signing authority.
`GET /healthz` is a direct readiness route, not a `Registry` client
method.

Type names use `Register`, not `Registration`, so the capability
method, route operation, private RPC member, and public request/result
types use one verb.

## Router operations

| Capability method | Request | Result variants | HTTP route |
|---|---|---|---|
| `Router.send` | `RouterSendRequest`: `expectedRouterInstanceId`, `mode`, `signedMessage`; mode is `initial` or `retry` | `accepted` with `routerInstanceId` and `signedMessageDigest`; `router_restarted` with `routerInstanceId`; `message_invalid`; `idempotency_conflict`; `retry_identity_unknown` | `POST /v1/messages:send` |
| `Router.poll` | `RouterPollRequest`: optional `pollCursor` | `batch` with `routerInstanceId`, `signedMessages`, and `pollCursor`; `feed_gap` with `routerInstanceId`; `cursor_invalid` | `POST /v1/messages:poll` |

Caller `AgentId` and `AgentSigningAuthority` are call-boundary inputs.
They are not request fields supplied as verified server context.
`GET /healthz` is direct and is not a `Router` method.

## Exact public Effect signatures

`Registry`, `Router`, and `AuthenticatedHttp` are `Context.Tag` deep
capabilities. Their named operation members are static Effect
accessors; callers do not fetch or name a separate public service
interface. Operation effects require their corresponding capability
in `R`, while each production `.layer` provides it.

The exact artifact members are:

```ts
AgentSigningAuthority.fromPkcs8(
  pkcs8: Redacted.Redacted<string>,
): Effect.Effect<AgentSigningAuthority, InvalidAgentPrivateKeyError>

AgentSigningAuthority.publicKey(
  authority: AgentSigningAuthority,
): Ed25519PublicKey

AgentCard.verify(input: {
  readonly agentCard: AgentCard
  readonly registrySignerPublicKey: Ed25519PublicKey
}): Effect.Effect<VerifiedAgentCard, AgentCardVerificationError>

SignedMessage.sign(input: {
  readonly agentCard: VerifiedAgentCard
  readonly signingAuthority: AgentSigningAuthority
  readonly recipientAgentIds: ReadonlySet<AgentId>
  readonly messageId: MessageId
  readonly body: Uint8Array
}): Effect.Effect<VerifiedSignedMessage, SignedMessageSigningError>

SignedMessage.verify(input: {
  readonly signedMessage: SignedMessage
  readonly agentCard: VerifiedAgentCard
}): Effect.Effect<VerifiedSignedMessage, SignedMessageVerificationError>
```

Signing snapshots the body, rejects an empty recipient set, and sorts
the set by decoded AgentId bytes. It derives the sender, AgentCard
digest, fixed kind, and MoltZap version; callers cannot provide or
override them. The signing authority's public key must equal the
verified AgentCard key.

Registry call grouping is:

```ts
Registry.register(input: {
  readonly request: RegistryRegisterRequest
  readonly admissionCredential: Redacted.Redacted<string>
  readonly signingAuthority: AgentSigningAuthority
}): Effect.Effect<
  RegistryRegisterResult,
  MalformedRequestError
    | AuthenticationFailedError
    | RouteNotFoundError
    | MethodNotAllowedError
    | VersionMismatchError
    | PayloadTooLargeError
    | UnsupportedMediaTypeError
    | OverloadedError
    | UnavailableError
    | InternalServerError
    | RegistryConnectionError
    | RegistryRequestTimeoutError
    | RegistryInvalidResponseError
    | AgentSigningError,
  Registry
>

Registry.lookup(
  request: RegistryLookupRequest,
): Effect.Effect<
  RegistryLookupResult,
  MalformedRequestError
    | RouteNotFoundError
    | MethodNotAllowedError
    | VersionMismatchError
    | PayloadTooLargeError
    | UnsupportedMediaTypeError
    | OverloadedError
    | UnavailableError
    | InternalServerError
    | RegistryConnectionError
    | RegistryRequestTimeoutError
    | RegistryInvalidResponseError,
  Registry
>

Registry.list(
  request: RegistryListRequest,
): Effect.Effect<
  RegistryListResult,
  MalformedRequestError
    | RouteNotFoundError
    | MethodNotAllowedError
    | VersionMismatchError
    | PayloadTooLargeError
    | UnsupportedMediaTypeError
    | OverloadedError
    | UnavailableError
    | InternalServerError
    | RegistryConnectionError
    | RegistryRequestTimeoutError
    | RegistryInvalidResponseError,
  Registry
>
```

Router call grouping is:

```ts
Router.send(input: {
  readonly request: RouterSendRequest
  readonly callerAgentId: AgentId
  readonly signingAuthority: AgentSigningAuthority
}): Effect.Effect<
  RouterSendResult,
  MalformedRequestError
    | AuthenticationFailedError
    | RouteNotFoundError
    | MethodNotAllowedError
    | VersionMismatchError
    | PayloadTooLargeError
    | UnsupportedMediaTypeError
    | OverloadedError
    | UnavailableError
    | InternalServerError
    | RouterConnectionError
    | RouterRequestTimeoutError
    | RouterInvalidResponseError
    | AgentSigningError,
  Router
>

Router.poll(input: {
  readonly request: RouterPollRequest
  readonly callerAgentId: AgentId
  readonly signingAuthority: AgentSigningAuthority
}): Effect.Effect<
  RouterPollResult,
  MalformedRequestError
    | AuthenticationFailedError
    | RouteNotFoundError
    | MethodNotAllowedError
    | VersionMismatchError
    | PayloadTooLargeError
    | UnsupportedMediaTypeError
    | OverloadedError
    | UnavailableError
    | InternalServerError
    | RouterConnectionError
    | RouterRequestTimeoutError
    | RouterInvalidResponseError
    | AgentSigningError,
  Router
>
```

The unions are repeated deliberately so the public signatures stay
exact without exported aggregate error aliases.

AuthenticatedHttp uses the standard Effect Platform request types and
the fixed registered-agent profile:

```ts
AuthenticatedHttp.signAgentRequest(input: {
  readonly httpRequest: HttpClientRequest.HttpClientRequest
  readonly callerAgentId: AgentId
  readonly encodedRequest: unknown
  readonly signingAuthority: AgentSigningAuthority
}): Effect.Effect<
  HttpClientRequest.HttpClientRequest,
  AgentSigningError
>

AuthenticatedHttp.verifyAgentRequest(input: {
  readonly httpRequest: HttpServerRequest.HttpServerRequest
  readonly bodyBytes: Uint8Array
}): Effect.Effect<
  VerifiedAgentRequest,
  MalformedRequestError
    | AuthenticationFailedError
    | VersionMismatchError
    | OverloadedError
    | UnavailableError,
  AuthenticatedHttp
>
```

The service-specific client first uses its route-owned Effect Schema
to encode the typed request. The signing member takes that encoded
value and an HTTP request with its method and URL already selected,
validates that the value is in the canonical-JSON domain, then installs
the canonical outer body and exact digest, version, content, and
signature fields. It does not expose algorithm, covered-component,
header, or profile choices. Encoding or canonicalization failure maps
to `AgentSigningError`.

Before verification, the Router HTTP boundary has already resolved the
route and method, enforced framing, media type, the route-derived body
cap, and its immediate request-concurrency permit. It passes a copied
bounded body to `verifyAgentRequest`. The verifier owns canonical JSON,
minimum caller extraction, Registry resolution, digest and signature
checks, time checks, atomic nonce claim, and version ordering. It
returns the inner route request as `unknown` beside the nominal caller
proof.

The exact client layers are:

```ts
Registry.layer(input: {
  readonly origin: URL
  readonly registrySignerPublicKey: Ed25519PublicKey
  readonly requestTimeout: Duration.Duration
}): Layer.Layer<Registry, never, HttpClient.HttpClient>

Router.layer(input: {
  readonly origin: URL
  readonly sendTimeout: Duration.Duration
  readonly pollTimeout: Duration.Duration
}): Layer.Layer<Router, never, HttpClient.HttpClient>
```

Each layer snapshots its `URL` origin and Effect `Duration` values.
Process composition obtains the same values through Effect Config.
There is no exported client-options or configuration type.

The registered-agent verifier layer is:

```ts
AuthenticatedHttp.layer(input: {
  readonly liveNonceCapacity: number
  readonly agentCardCacheCapacity: number
  readonly registryLookupConcurrencyLimit: number
}): Layer.Layer<AuthenticatedHttp, never, Registry>
```

Its integer inputs are already positive, refined process values. The
layer owns the bounded nonce set, positive immutable-card cache, and
single-flight lookup limit for one Router process. Registry's client
layer owns the complete lookup deadline.

The server subpath modules expose constant discard layers:

```ts
import * as RegistryServer from "@moltzap/v2-identity/registry/server"

RegistryServer.layer: Layer.Layer<never, RegistryServer.StartupError>
RouterServer.layer: Layer.Layer<never, RouterServer.StartupError>
```

They read private Effect Config and compose their Node capabilities.
Embedded runs select another `ConfigProvider`; no server configuration
object or otherwise-useless server service tag is exported.

## Deep-module member names

The proposed public members are:

- `AgentSigningAuthority.fromPkcs8`
- `AgentSigningAuthority.publicKey`
- `AgentCard.verify`
- `SignedMessage.sign`
- `SignedMessage.verify`
- `SignedMessage.encodedByteLength`
- `SignedMessage.maximumEncodedByteLength`
- `Registry.layer`
- `Router.layer`
- `RegistryServer.layer`
- `RouterServer.layer`

`AgentSigningAuthority` is opaque. It exposes no generic
`sign(bytes)` method, raw private-key value, JOSE object, or WebCrypto
key. `fromPkcs8` accepts redacted unencrypted Ed25519 PKCS#8 material.

`AgentCard.verify` is the only public producer of
`VerifiedAgentCard`. `SignedMessage.sign` produces a locally verified
`VerifiedSignedMessage`, and `SignedMessage.verify` is the only
verifier-side producer of that type.

`SignedMessage.encodedByteLength(signedMessage: SignedMessage): number`
is total for a parsed exact SignedMessage and returns the UTF-8 JCS byte
length of its complete General JWS. It adds no failure channel.
`SignedMessage.maximumEncodedByteLength: number` is 471,671 for the
fixed opaque-body and recipient bounds. A `VerifiedSignedMessage`
remains usable where `SignedMessage` is accepted. These two
representation facts let Router enforce byte retention and derive its
envelopes without reimplementing identity's General JWS calculation.

`.layer` is the only public production-construction member on the
client and server capabilities. No separate public factory,
pass-through function, configuration class, or `Live` alias is added.

The proposed startup-error surface is:

- `StartupError` from `@moltzap/v2-identity/registry/server`, tagged
  `RegistryServerStartupError`, with the closed phases
  `configuration`, `storage`, and `listener`; and
- `RouterServer.StartupError`, tagged `RouterServerStartupError`, with
  the closed phases `configuration` and `listener`.

Each startup error is a `Data.TaggedError` with exactly `_tag` and `phase`
as its declared fields. `phase` is the only public detail
because it changes the operator's remedy:

- Registry `configuration` covers Effect Config validation,
  credential and signing-key loading, and representation/resource fit;
- Registry `storage` covers pool acquisition, migrations, startup
  metadata, and storage readiness;
- Registry `listener` covers listener acquisition and serving startup;
- Router `configuration` covers Effect Config validation, pinned
  Registry signer loading, and resource fit; and
- Router `listener` covers listener acquisition and serving startup.

The public server layers preserve these errors in their Effect `E` channel.
The Registry module exports its startup error directly; the Router facade uses
an ES-module namespace export without a TypeScript `namespace` declaration.
SQL, migrator, configuration parser, and Node listener errors, secret paths,
driver messages, and raw causes remain private; server code maps them after
recording redacted diagnostics.

## AuthenticatedHttp surface

`AuthenticatedHttp` applies only to registered-agent requests.

The proposed public members are:

- `signAgentRequest`
- `verifyAgentRequest`
- `layer`

Registry registration does not add `signRegistrationRequest` or
`verifyRegistrationRequest` to `AuthenticatedHttp`. Registry owns
those private bootstrap-admission operations.

The verified agent proof remains opaque and nominal. It is never a
body field, client-supplied value, process cache entry, or public
constructor argument.

No generic HTTP-signing API, configurable authentication-profile
catalog, or signature-library object is exported.

## Shared HTTP/server errors

These classes are owned and exported by `identity`. Router uses them
without redeclaring or re-exporting aliases.

Each class is an empty `Schema.TaggedError`; its `_tag` is exactly its
class name. The status and response `error` code are a private
bijective mapping, not duplicate instance fields.

| HTTP | Exact `error` code | Class and `_tag` |
|---:|---|---|
| 400 | `malformed` | `MalformedRequestError` |
| 401 | `authentication_failed` | `AuthenticationFailedError` |
| 404 | `not_found` | `RouteNotFoundError` |
| 405 | `method_not_allowed` | `MethodNotAllowedError` |
| 412 | `version_mismatch` | `VersionMismatchError` |
| 413 | `payload_too_large` | `PayloadTooLargeError` |
| 415 | `unsupported_media_type` | `UnsupportedMediaTypeError` |
| 429 | `overloaded` | `OverloadedError` |
| 503 | `unavailable` | `UnavailableError` |
| 500 | `internal` | `InternalServerError` |

`RouteNotFoundError` deliberately distinguishes an HTTP 404 from the
successful Registry lookup result `{ "kind": "not_found" }`.

The exact operation server-error membership is:

- register, send, and poll declare all ten classes;
- lookup and list declare all except
  `AuthenticationFailedError`, because public reads have no
  authentication or admission stage; and
- a well-formed server error not declared for the operation is an
  invalid client response, not a widened error union.

There is no exported aggregate `OperationServerError`.

## Client and signed-artifact errors

Registry client-only errors:

- `RegistryConnectionError`
- `RegistryRequestTimeoutError`
- `RegistryInvalidResponseError`

Router client-only errors:

- `RouterConnectionError`
- `RouterRequestTimeoutError`
- `RouterInvalidResponseError`

Proposed signed-artifact errors:

- `InvalidAgentPrivateKeyError`
- `AgentSigningError`
- `AgentCardVerificationError`
- `SignedMessageSigningError`
- `SignedMessageVerificationError`

Every client-only and signed-artifact class is an empty
`Data.TaggedError` whose `_tag` is exactly its class name. It declares
no `message`, code, status, reason, cause, operation, method, origin,
URL, timeout, response, key, path, SQL, or library-detail field. The
calling method and error tag already identify the recovery class.
Private redacted diagnostics retain the underlying cause before
mapping.

The client taxonomy is exclusive:

- configured total-call deadline expiry becomes the service-specific
  `RequestTimeoutError`;
- another connection-establishment or connection-use failure becomes
  the service-specific `ConnectionError`;
- a recognized operation-declared server envelope becomes its mapped
  shared server error;
- local authenticated-request signing failure becomes
  `AgentSigningError`; and
- an invalid status/body/schema/binding/signature combination becomes
  the service-specific `InvalidResponseError`.

No infrastructure cause, key material, SQL detail, response body, or
library error escapes through these errors.

The exact public method `E` channels are:

- `AgentSigningAuthority.fromPkcs8`:
  `InvalidAgentPrivateKeyError`;
- `AgentSigningAuthority.publicKey`: `never`;
- `AuthenticatedHttp.signAgentRequest`: `AgentSigningError`;
- `AuthenticatedHttp.verifyAgentRequest`:
  `MalformedRequestError | AuthenticationFailedError |
  VersionMismatchError | OverloadedError | UnavailableError`;
- `AgentCard.verify`: `AgentCardVerificationError`;
- `SignedMessage.sign`: `SignedMessageSigningError`;
- `SignedMessage.verify`: `SignedMessageVerificationError`;
- `Registry.register`: its ten declared server errors plus
  `RegistryConnectionError | RegistryRequestTimeoutError |
  RegistryInvalidResponseError | AgentSigningError`;
- `Registry.lookup` and `Registry.list`: their nine declared server
  errors plus `RegistryConnectionError |
  RegistryRequestTimeoutError | RegistryInvalidResponseError`; and
- `Router.send` and `Router.poll`: their ten declared server errors
  plus `RouterConnectionError | RouterRequestTimeoutError |
  RouterInvalidResponseError | AgentSigningError`.

Registry response-card, binding, and signature failures collapse into
`RegistryInvalidResponseError`; they do not add
`AgentCardVerificationError` to Registry calls. Router poll returns
untrusted SignedMessage values and therefore does not add
`SignedMessageVerificationError`.

The implementation declares each private RPC member's
`Schema.Union(...)` at that member. It exports no shared HTTP, client,
signed-artifact, or operation-error union, class array, registry, or
reconstruction helper.

## Private RPC design

Registry has one private RPC group with members:

- `register`
- `lookup`
- `list`

Router has one private RPC group with members:

- `send`
- `poll`

Health routes remain outside RPC.

| Operation | Private RPC middleware execution order |
|---|---|
| Registry register | successful Registry-owned registration admission |
| Registry lookup | none |
| Registry list | none |
| Router send | verified registered-agent context |
| Router poll | verified registered-agent context |

The implementation requirements are:

- authentication and capability middleware short-circuit every later
  middleware and the handler;
- middleware-provided context reaches the handler without repeating
  admission, identity lookup, or capacity work;
- handler and middleware failures travel from the server `E` channel
  through the exact HTTP adapter to the client `E` channel;
- closed domain refusals remain values in `A`;
- connection, timeout, local-signing, and invalid-response failures
  remain client `E`;
- required middleware is never optional;
- `RpcServer.makeNoSerialization` and
  `RpcClient.makeNoSerialization` preserve private correlation and
  typed exits; and
- Effect Schema still validates every production network boundary.

Router acquires the per-AgentId and global held-poll permit inside the
handler only after a valid continuation has scanned a stable tail and
found no addressed message. Invalid cursors, omitted-cursor anchoring,
and immediately satisfiable polls therefore retain their domain
precedence and do not consume held-poll capacity. The permit is scoped
and releases on completion, failure, defect, interruption, or client
cancellation.

Production HTTP remains the exact layer-owned routes. It does not use
`/rpc`, JSON-RPC, NDJSON, `RpcSerialization`, or Effect RPC's HTTP
protocol.

The v1 transport is a feature reference only. V2 does not copy its
dual client/server RPC definitions, method catalog, mux, generic
dispatcher, payload re-guards, or aggregate error reconstruction.

## JSON, JOSE, and request signatures

- Effect Schema is the only JSON parser.
- `Schema.parseJson()` parses one unknown JSON value.
- Private Effect Schema refinements enforce maximum container depth
  and well-formed Unicode.
- JCS byte equality rejects duplicate names, alternate member order,
  whitespace, and alternate number spelling.
- There is no `jsonc-parser.visit` and no second JSON parser.
- `canonicalize` supplies RFC 8785 JCS.
- `jose` supplies General JWS, JWK thumbprints, and Compact JWE.
- `http-message-signatures` and `structured-headers` supply the RFC
  9421 mechanisms.
- No project-owned JOSE, JCS, HTTP-signature, or structured-field
  implementation is added.
- MessagePack, deterministic CBOR, COSE, and X.509 are not used for
  L1 or L2.
- Current later-layer CBOR/COSE choices remain untouched.

## Fixed representation and security choices

- Ed25519 public keys use exact closed public JWKs.
- AgentCard and SignedMessage use attached General JWS.
- Registered-agent HTTP signatures bind method, authority, path,
  query, content digest, content type, and MoltZap version.
- Registration's Registry-owned proof additionally binds its
  admission authorization field.
- Signature validity intervals are at most 300 seconds.
- `created` may be at most five seconds after the verifier clock.
- Authentication nonces are 16 random bytes.
- The registration admission credential is one 8–512-character
  token68 value.
- Maximum decoded JSON container depth is 16.
- Unknown fields and noncanonical base64url are rejected.
- Application code owns no TLS, certificate, or trusted-proxy
  configuration.
- Deployments protect admission credentials and unsigned responses
  when their threat model requires it.

## Registry state

Registry persists:

- immutable AgentCards and their identity bindings;
- registration idempotency operations and exact results;
- accepted registration replay nonces through expiry; and
- startup metadata and schema migrations.

One configured SQL operation deadline covers connection acquisition,
every execution, and every retry belonging to one required storage
operation.

The nonce claim commits as its own durable replay step before version,
complete route schema, and domain handling. Registration then commits
idempotency, uniqueness, the card, and the exact result atomically.

## Router state and private order

One Router process owns:

- one count-and-byte-bounded global ring;
- one retained retry index coupled to ring eviction;
- one bounded live-nonce set;
- one bounded positive AgentCard LRU;
- single-flight same-AgentId Registry misses; and
- request-scoped poll waiters grouped by AgentId.

Router owns no database, durable cursor, recipient queue or index,
per-recipient record copy, or server-side poll advancement.

The private order is an unsigned 128-bit integer:

- `0` is the empty-tail sentinel;
- the first accepted message is order `1`;
- the maximum is `2^128 - 1`;
- assigning the maximum succeeds and immediately makes health return
  503 because no fresh append capacity remains;
- the next fresh append returns 429 without mutation; and
- retained retries and polls remain usable.

PollCursor is a client-held Compact JWE:

- A256GCM with one random 256-bit process key;
- a fresh 96-bit IV and 128-bit tag for every cursor;
- bound to AgentId, RouterInstanceId, and last scanned private order;
- at most 348 ASCII characters; and
- invalid after process restart.

Exactly one held poll per AgentId is permitted. The long-poll hold is
exactly 25 seconds.

## Configuration vocabulary

The proposed naming rule is:

- `CAPACITY` bounds aggregate retained or live state, measured as
  entries or bytes, and admitted held work;
- `LIMIT` bounds one request, response, batch, or concurrency class;
- `SIZE` configures a page or pool size; and
- `TIMEOUT_MS` is a duration in milliseconds.

This table supersedes the earlier mixed `MAX_*`, `DEPTH`, and
`CAPACITY` proposal if approved.

Configuration loading uses Effect directly:

- each process defines one private `Config.all` value;
- `Schema.Config` decodes and refines every environment value at the
  boundary;
- `Config.redacted` protects the PostgreSQL URL, admission credential,
  and signing-key path;
- `Config.withDefault` owns defaults;
- the executable supplies `ConfigProvider.fromEnv`, tests use
  `ConfigProvider.fromMap`, and embedded compositions may supply
  another `ConfigProvider`; and
- configuration failure remains in the server layer's typed startup
  error channel.

There is no direct `process.env` access, custom environment parser,
generic public configuration type, mutable configuration singleton, or
hot reload. Tests do not mutate `process.env`. Effect Config reads the
declared keys and ignores unrelated or unused environment variables;
the implementation does not build a second prefix-enumeration system
solely to reject unknown keys.

### Configuration key audit

A value is process configuration only when an operator can choose it
independently to express a deployment input or a resource tradeoff.
Protocol constants, representation consequences, and duplicate
capacity controls remain private constants or derived values.

The following candidates are therefore excluded from the configuration
surface:

| Excluded candidate | Replacement | Reason |
|---|---|---|
| `MOLTZAP_REGISTRY_REQUEST_QUEUE_CAPACITY` and `MOLTZAP_ROUTER_REQUEST_QUEUE_CAPACITY` | no application request queue | One immediate request-concurrency permit is the complete in-process admission control. The Node and operating-system connection backlog is deployment/runtime behavior. |
| `MOLTZAP_REGISTRY_REQUEST_BODY_BYTE_LIMIT` | one derived private cap per Registry route | Each route has one fixed closed request representation, so a second operator-selected number can only disagree with it. |
| `MOLTZAP_ROUTER_REQUEST_BODY_BYTE_LIMIT` | one derived private cap per Router route | Each route has one fixed closed request representation, so send and poll can reject excess bytes at their own exact boundaries. |
| `MOLTZAP_ROUTER_SIGNED_MESSAGE_BYTE_LIMIT` | derived complete SignedMessage cap | The closed SignedMessage representation, fixed opaque-body maximum, and fixed recipient maximum determine it exactly. |
| `MOLTZAP_ROUTER_OPAQUE_BODY_BYTE_LIMIT` and `MOLTZAP_ROUTER_RECIPIENT_LIMIT` | fixed Gate 1 values | These decide what a conforming Router accepts, rather than how one deployment allocates resources. |
| reject undeclared `MOLTZAP_REGISTRY_*` or `MOLTZAP_ROUTER_*` keys | ordinary Effect Config lookup | Rejecting undeclared variables would require a second environment-enumeration subsystem without improving parsing of the declared configuration. |

The retained keys fall into two categories:

- deployment and trust inputs: listener address, database location,
  admission secret, signing key, Registry origin, and pinned Registry
  signer; and
- independently useful resource controls: page or batch shape,
  concurrency, live-entry capacity, storage pool and deadline, feed
  retention, response bytes, held polls, cache entries, and Registry
  lookup pressure.

Count and byte controls remain separate where they protect different
worst cases: many tiny values versus a few large values. Total request
concurrency and held-poll capacity also remain separate so held polls
cannot consume every request permit.

If this table is approved, the authority reconciliation removes stale
queue and independently configured representation-bound language from
`identity.md`, `identity-representation.md`, `router.md`, and
`router-representation.md` before implementation. Until that atomic
reconciliation passes review, this section remains a proposal and the
normative chapters remain current.

### Registry process

| Exact key | Meaning | Required/default | Range and constraints | Redaction |
|---|---|---|---|---|
| `MOLTZAP_REGISTRY_HOST` | listener bind host | `127.0.0.1` | nonempty Node bind host; `0.0.0.0` and `::` allowed | no |
| `MOLTZAP_REGISTRY_PORT` | listener port | required | integer 1–65535 | no |
| `MOLTZAP_REGISTRY_POSTGRESQL_URL` | Registry PostgreSQL connection URL | required | absolute PostgreSQL URL naming a database | entire value |
| `MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL` | registration admission credential | required | 8–512 token68 characters | entire value |
| `MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH` | Registry AgentCard-signing key | required | absolute path to unencrypted Ed25519 PKCS#8 | entire path and key material |
| `MOLTZAP_REGISTRY_LIST_PAGE_SIZE` | server-owned identity-list page size | `100` | positive integer; clients cannot override | no |
| `MOLTZAP_REGISTRY_REQUEST_CONCURRENCY_LIMIT` | active request permits | `256` | positive integer | no |
| `MOLTZAP_REGISTRY_LIVE_NONCE_CAPACITY` | unexpired accepted registration nonces | `10,000` | positive integer; never evict a live nonce | no |
| `MOLTZAP_REGISTRY_SQL_POOL_SIZE` | PostgreSQL pool size | `10` | positive integer | no |
| `MOLTZAP_REGISTRY_SQL_OPERATION_TIMEOUT_MS` | acquisition, execution, and retry deadline | `5,000` | positive milliseconds; expiry becomes 503 `unavailable` | no |

### Router process

| Exact key | Meaning | Required/default | Range and constraints | Redaction |
|---|---|---|---|---|
| `MOLTZAP_ROUTER_HOST` | listener bind host | `127.0.0.1` | nonempty Node bind host; `0.0.0.0` and `::` allowed | no |
| `MOLTZAP_ROUTER_PORT` | listener port | required | integer 1–65535 | no |
| `MOLTZAP_ROUTER_REGISTRY_ORIGIN` | Registry client origin | required | serialized HTTP or HTTPS origin; no userinfo, route path, query, or fragment | no |
| `MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY` | deployment-pinned Registry signer | required | inline exact closed Ed25519 public JWK JSON in compact JCS spelling | no; public key |
| `MOLTZAP_ROUTER_RETAINED_MESSAGE_CAPACITY` | global-ring message count | `4,096` | positive count; one copy per message | no |
| `MOLTZAP_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY` | global-ring byte retention | `67,108,864` | sum of complete SignedMessage JCS bytes | no |
| `MOLTZAP_ROUTER_POLL_MESSAGE_LIMIT` | maximum messages in one batch | `128` | positive count | no |
| `MOLTZAP_ROUTER_POLL_RESPONSE_BYTE_LIMIT` | maximum complete poll result | `1,048,576` | UTF-8 JCS result bytes including PollCursor | no |
| `MOLTZAP_ROUTER_REQUEST_CONCURRENCY_LIMIT` | active request permits | `512` | positive integer | no |
| `MOLTZAP_ROUTER_HELD_POLL_CAPACITY` | globally held continuation polls | `256` | positive and not greater than request concurrency | no |
| `MOLTZAP_ROUTER_LIVE_NONCE_CAPACITY` | current-instance unexpired nonces | `100,000` | positive; never evict a live nonce | no |
| `MOLTZAP_ROUTER_AGENT_CARD_CACHE_CAPACITY` | positive immutable-card LRU | `10,000` | positive entry count | no |
| `MOLTZAP_ROUTER_REGISTRY_LOOKUP_CONCURRENCY_LIMIT` | concurrent underlying Registry lookups | `32` | positive; same-AgentId misses remain single-flight | no |
| `MOLTZAP_ROUTER_REGISTRY_LOOKUP_TIMEOUT_MS` | complete Registry lookup deadline | `5,000` | positive milliseconds through verified-card result | no |

The system still validates distinct representations, but their
enclosing byte bounds are not independent configuration knobs:

- the opaque-body maximum after canonical base64url decoding is the
  fixed Gate 1 value 262,144 bytes, and the recipient maximum is the
  fixed Gate 1 value 128;
- the complete SignedMessage maximum is derived exactly from those
  fixed limits plus the closed SignedMessage representation;
- the send and poll request-body maxima are derived separately from
  their fixed request representations; and
- the HTTP reader applies the route's derived request maximum before
  parsing, while SignedMessage validation applies the identity-owned
  derived artifact maximum after parsing.

Registry likewise derives a separate pre-parse body cap for each fixed
register, lookup, and list representation. The derived maxima are
private route values, not environment keys or public configuration
names.

Identity owns the fixed opaque-body and recipient limits, the exact
complete SignedMessage calculation, and the exact length of an
accepted SignedMessage. It exposes those last two facts only through:

- `SignedMessage.maximumEncodedByteLength`; and
- `SignedMessage.encodedByteLength(signedMessage)`.

Router consumes that deep-module interface instead of reproducing
General JWS size knowledge. Router owns only its send, poll,
PollCursor, and poll-result calculations. Each representation uses one
overflow-checked calculator for the encodings it owns. Tests compare
the identity calculator with actual Schema, JCS, and JWS encodings and
the Router calculator with actual Schema, JCS, and JWE encodings.

Numeric values use canonical unsigned decimal with no whitespace,
sign, fraction, or exponent. The proposed range is `1..2^31-1`,
except ports, which are `1..65535`.

## Router configuration fit laws

Router configuration is rejected unless:

1. retention holds at least one maximum SignedMessage under the fixed
   opaque-body and recipient bounds, by count and bytes; and
2. one such maximum SignedMessage plus a maximum PollCursor fits both
   the poll-message and poll-response-byte limits.

Under the fixed SignedMessage bounds and default resource limits:

- the maximum complete SignedMessage is 471,671 bytes;
- the maximum send request is 471,819 bytes;
- the maximum PollCursor is 348 characters;
- the maximum PollCursor request is 422 bytes; and
- a one-message batch is 472,119 bytes.

Tests compare each calculator against only the actual encodings its
package owns rather than maintaining a second size formula.

## Fixed values without environment keys

There is no process environment key for:

- MoltZap version;
- maximum JSON depth;
- opaque-body maximum after canonical base64url decoding;
- maximum SignedMessage recipients;
- route request-body caps derived from the fixed representations;
- the complete SignedMessage cap derived from the fixed opaque-body and
  recipient limits;
- the 300-second signature validity interval;
- the five-second future skew;
- the 25-second poll hold;
- one held poll per AgentId;
- private order width;
- RouterInstanceId;
- PollCursor key;
- positive AgentCard cache TTL;
- TLS, certificates, URL-scheme enforcement, or trusted proxies; or
- version negotiation.

Positive immutable AgentCards have no time expiry within the bounded
cache. Failures and `not_found` have zero cache lifetime.

## Client inputs that are not server environment

Registry client construction receives:

- `origin: URL`;
- `registrySignerPublicKey: Ed25519PublicKey`; and
- `requestTimeout: Duration.Duration`.

Each registration call receives:

- `admissionCredential: Redacted.Redacted<string>`; and
- `signingAuthority: AgentSigningAuthority`.

Router client construction receives:

- `origin: URL`;
- `sendTimeout: Duration.Duration`; and
- `pollTimeout: Duration.Duration`.

Each Router send or poll call receives:

- `callerAgentId: AgentId`; and
- `signingAuthority: AgentSigningAuthority`.

These timeouts are programmatic caller configuration, not new
Registry or Router server environment keys. A caller may choose a poll
timeout shorter than the server's 25-second hold and receive
`RouterRequestTimeoutError`.

No caller private key, cursor key, or AgentCard is added to Router
process environment.

## Dependency pins

Direct production dependencies are exact-pinned:

| Dependency | Version | License | Purpose |
|---|---:|---|---|
| `effect` | `3.22.0` | MIT | typed effects, services, schemas, concurrency |
| `@effect/platform` | `0.97.0` | MIT | platform-neutral HTTP |
| `@effect/platform-node` | `0.108.0` | MIT | Node process composition |
| `@effect/rpc` | `0.76.0` | MIT | private typed operation groups and middleware |
| `@effect/experimental` | `0.61.0` | MIT | compatible Effect SQL peer |
| `@effect/sql` | `0.52.0` | MIT | SQL, transactions, and Migrator |
| `@effect/sql-pg` | `0.53.0` | MIT | PostgreSQL implementation |
| `jose` | `6.2.5` | MIT | General JWS, thumbprints, Compact JWE |
| `canonicalize` | `3.0.0` | Apache-2.0 | RFC 8785 JCS |
| `http-message-signatures` | `1.0.6` | ISC | RFC 9421 |
| `structured-headers` | `2.0.3` | MIT | structured fields |

Direct test dependencies are exact-pinned:

| Dependency | Version | License | Purpose |
|---|---:|---|---|
| `vitest` | `3.2.4` | MIT | test runner |
| `@effect/vitest` | `0.30.0` | MIT | Effect test integration |
| `fast-check` | `3.23.2` | MIT | property tests |
| `@electric-sql/pglite` | `0.4.4` | Apache-2.0 | embedded PostgreSQL |
| `@electric-sql/pglite-socket` | `0.1.4` | Apache-2.0 | PostgreSQL socket compatibility |
| `@testcontainers/postgresql` | `10.28.0` | MIT | real PostgreSQL integration |

The exact versions and license metadata were checked against the npm
registry. A dependency is not added until its maintenance status,
module format, Node support, selected Effect-version compatibility, and
lockfile closure are also verified. `@effect/platform-node` has
mandatory peers on `@effect/cluster`, which in turn peers on
`@effect/workflow`; pnpm supplies that compatible closure without
misstating unused packages as direct application dependencies.

## Test and readability gates

Before feature implementation, `identity` and `router` gain
non-vacuous Nx targets for:

- production build;
- production typecheck;
- test typecheck;
- unit tests;
- integration tests;
- lint;
- focused architecture checks; and
- generated documentation and documented-import validation.

Production TypeScript configuration excludes
`*.types-check.ts`. The separate test typecheck includes those
canaries. A missing target or a test target that discovers no required
tests is a failure.

Configuration tests use `ConfigProvider.fromMap` to prove exact keys,
defaults, refinements, secret redaction, typed startup failure, and
acceptance of unrelated map entries. Boundary tests prove every
route-derived body cap at the exact maximum and one byte beyond it.
Identity tests independently verify both SignedMessage byte-length
members against actual canonical encodings; Router tests use the
identity-owned maximum without duplicating the General JWS formula.

Every implementation slice ends with human readability review before
the next slice:

- one concept has one name;
- numbered layer notation appears only in documentation;
- public interfaces expose domain guarantees and hide mechanisms;
- errors are closed, typed, and redacted;
- comments explain only hidden constraints or invariants;
- no generic helper escapes merely because two private call sites
  share mechanics; and
- the code can be understood without this slate.

## Retired and forbidden vocabulary

Retired public vocabulary:

- `Directory`
- `DirectoryServer`
- the `transport` package
- `Delivery`
- `RouterSequence`
- `wire profile`
- `wire catalog`
- `vector corpus`
- public `test-vector`

Forbidden generic or mechanism exports:

- generic `Id`, `Digest`, `Timestamp`, `Base64Url`, or `Cursor`;
- public `wire`, `codec`, `serialization`, or `protocol` modules;
- generic JCS, JSON, JWS, JOSE, or HTTP-signature APIs;
- RPC groups, middleware tags, request IDs, tracing fields,
  serializers, or envelopes;
- repositories, database rows, SQL causes, caches, nonce stores, HTTP
  handlers, cursor internals, or Router private order;
- public configuration types;
- `/rpc`, JSON-RPC, or NDJSON production surfaces; and
- `RegistryClient` or `RouterClient`.

The earlier `HarnessEndpoin` placeholder and any normalized
`HarnessEndpoint` spelling are retired. The current later-layer
subsystem and package name is `Harness`; L1 and L2 still do not
introduce or own it.

## Explicit deferrals

This slate does not decide or implement:

- any L3 or L4 representation or vocabulary change;
- conversation, task, norm, membership, transaction, replay, or
  recovery semantics in Router;
- Router persistence, replication, failover, or stable process
  identity;
- key rotation, revocation, recovery, delegation, HSMs, keychains, or
  external signers;
- end-to-end body encryption;
- application-owned TLS;
- container images or deployment manifests;
- publishing, cutover, or v1 retirement; or
- simulator porting governed by its separate provenance gate.

## Human decisions required

The maintainer must explicitly accept or change:

1. Registry-owned bootstrap admission instead of placing registration
   inside `AuthenticatedHttp`.
2. Keeping collapsed 401 `authentication_failed` for invalid
   registration admission or proof, or introducing a different public
   error.
3. The complete root and server-subpath export inventories, including
   the type-only `VerifiedAgentRequest`.
4. The immutable decoded `AgentCard` and `SignedMessage` views, their
   exact fields and defensive-copy behavior, and nominal verified
   subtypes.
5. Type-only verified Registry results with private response Schemas.
6. Every artifact member name, argument grouping, return type, and
   error channel, including the two SignedMessage byte-length members.
7. Every Registry and Router operation argument group, exact `E`
   membership, and capability requirement in `R`.
8. The `VerifiedAgentRequest` fields and the exact
   `AuthenticatedHttp` signing, verification, and layer signatures.
9. `.layer` as the only public production-construction member; the
   inline client-layer fields, `URL` and Effect `Duration` inputs,
   `HttpClient.HttpClient` requirement, and constant discard server
   layers.
10. Every error class and `_tag`, the empty non-startup shapes, and the
    nested startup `phase` fields and literals.
11. Programmatic client timeouts rather than server environment keys.
12. The reduced Effect Config surface, naming convention, and literal
    keys.
13. `POSTGRESQL_URL` rather than the earlier generic `DATABASE_URL`.
14. The unsigned 128-bit Router order and exhaustion behavior.
15. The fixed opaque-body and recipient limits, derived enclosing-byte
    limits, exact byte-accounting domains, remaining bounds, and
    cross-field fit laws.

After approval, the normative ADR/spec delta is frozen and sent
through a new isolated blind review. Implementation begins only after
that review passes and the maintainer accepts it.
