---
status: accepted
date: 2026-07-29
decision-makers: Tapan Chugh
---

# Identity and Router expose deep Effect capabilities

Decision provenance: [deep-module direction](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#identity-uses-jcs-jose-and-authenticatedhttp), [documentation-only layer notation](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#numbered-layer-notation-stays-in-documentation), and [exact implementation slate approval](../decision-evidence/20260729-l1-l2-implementation-trajectory.md#exact-implementation-slate-approved).

## Context and Problem Statement

The first implementation needs exact callable TypeScript interfaces,
not only HTTP representations. V1 demonstrates useful Effect Schema
brands and Effect RPC middleware, but its generic transport
descriptors, duplicated client/server RPC members, aggregate error
reconstruction, and mechanism-shaped vocabulary would recreate the
technical debt this rewrite is intended to remove.

The packages need a small public surface that keeps parsing, signing,
HTTP, RPC, configuration, SQL, caching, concurrency, and process
construction inside cohesive domain modules.

## Considered Options

- Export client classes, server classes, option interfaces, generic
  repositories, codecs, middleware tags, and transport helpers.
- Copy v1's descriptor catalog and dual client/server RPC definitions.
- Implement custom parsing, configuration, RPC, JOSE, canonicalization,
  and HTTP-signature libraries.
- Expose cohesive domain capabilities built directly from Effect and
  maintained standards libraries.
- Put numbered architecture labels into package and source names.
- Keep numbered layer notation in documentation and use domain
  vocabulary in executable artifacts.

## Decision Outcome

Chosen: **`identity` and `router` expose cohesive Effect capabilities;
mechanisms and numbered layer notation remain outside the code
vocabulary**.

### Binding outcome

`@moltzap/v2-identity` exports the shared refined identity values,
AgentCard, SignedMessage, their nominal verified forms,
AgentSigningAuthority, AuthenticatedHttp, and their closed public errors.
Its `/registry` subpath exports Registry-owned values, requests, results,
client errors, and the Registry capability. Its `/registry/server` subpath
exports the Registry production layer and startup error directly.
`@moltzap/v2-router` exports Router-owned refined values, requests, results,
Router, and its client errors. Its `/server` subpath exports `RouterServer`.

AgentCard and SignedMessage are same-named Effect Schemas and
TypeScript domain types. Their encoded side is the exact General JWS
JSON; their decoded side exposes immutable domain fields while
retaining exact JOSE state privately. VerifiedAgentCard and
VerifiedSignedMessage are nominal subtypes, not wrapper objects.
VerifiedAgentRequest is a non-serializable nominal proof containing
the caller AgentId, resolved verified AgentCard, and still-unknown
route request.

AgentSigningAuthority, AgentCard, and SignedMessage expose only the
domain operations required to load a redacted PKCS#8 key, obtain its
public key, verify a card, sign a message, verify a message, and obtain
identity-owned SignedMessage lengths. No generic byte signer, JWS
object, WebCrypto key, or JOSE surface escapes.

Registry, Router, and AuthenticatedHttp are `Context.Tag` deep
capabilities with static Effect accessors. Registry and Router expose
only `.layer` for production client construction. Their inputs are
inline `URL`, Effect `Duration`, signer, caller, and admission values
owned by the relevant call or layer. The Registry server module and
RouterServer expose constant discard layers and closed startup errors. There
are no public client classes, service-interface types, options types,
configuration types, factories, `Live` aliases, or server tags.

Effect Schema parses and validates every network, configuration, SQL,
and persistence boundary. Each process loads one private `Config.all`
through `Schema.Config`, `Config.redacted`, and
`Config.withDefault`. Executables supply `ConfigProvider.fromEnv`;
tests supply `ConfigProvider.fromMap`; embedded composition may supply
another provider. No direct `process.env` parser, environment-prefix
enumerator, mutable configuration singleton, or hot reload exists.

Each Registry and Router operation is declared once in a private
`@effect/rpc` group. Required authentication or admission middleware is
non-optional and its failure propagates through the server `E` channel
to the exact client `E`. Production still uses the fixed layer-owned
HTTP routes and representations, not Effect RPC's HTTP protocol,
`/rpc`, JSON-RPC, NDJSON, or a network multiplexer. Private
no-serialization RPC preserves operation correlation, middleware
context, and typed exits behind the HTTP adapters.

HTTP/server errors are closed empty `Schema.TaggedError` values.
Client, signing, and verification errors are closed empty
`Data.TaggedError` values. A tag identifies the recovery class; raw
causes and secrets remain in private redacted diagnostics. Server
startup errors expose only their closed startup phase.

`L1` and `L2` remain documentation notation. Package metadata, paths,
source and test identifiers, JSDoc, comments, runtime strings,
configuration, errors, fixtures, migrations, and generated code name
`identity`, Registry, `router`, and Router directly. Repository checks
enforce this without changing later-layer vocabulary or authority.

The exact exports, method signatures, result variants, error
membership, construction inputs, and startup phases live in
`docs/spec/identity.md`, `docs/spec/router.md`, and
`docs/spec/layer-interfaces.md`. Exact encodings remain in the separate
identity and Router representation chapters.

### Guarantee

A caller can construct and use Registry and Router from their domain
interfaces without learning HTTP signing, JOSE, RPC, configuration,
SQL, cache, nonce, or listener mechanisms. Every untrusted boundary and
expected failure remains typed and closed.

### Mechanism

Effect Schema, Config, Context, Layer, RPC, SQL, and Platform provide
the implementation substrate. `jose`, `canonicalize`,
`http-message-signatures`, and `structured-headers` provide the
standards mechanisms selected by the identity decision.

## Consequences

The implementation does not create a replacement transport framework.
Mechanism reuse happens inside the owning deep package, and public
names return to human review before they enter source. Type canaries
pin the approved public signatures; each implementation batch receives
a human readability review before the next batch starts.

## Record changelog

Point corrections that leave the Decision Outcome intact.

| Date | Change |
|---|---|
| 2026-08-14 | Recorded the approved Registry subpath ownership and direct server export in the binding package surface. The deep Effect-capability outcome is unchanged. |
