# L1 representation

{/* @bake-constants: V2_PROTOCOL_VERSION */}

Status: **Gate 1 normative**

Semantic contract: [`identity.md`](./identity.md)

This chapter owns the exact L1 representation. Its JCS, JWK, JWS, and
HTTP mechanisms remain private to the deep `identity` package.

## Canonical JSON

Every L1 JSON request, result, signed payload, protected header, and
complete General JWS object uses RFC 8785 JSON Canonicalization Scheme
UTF-8 bytes.

A complete decoder:

1. reads within the configured byte bound;
2. decodes fatal UTF-8;
3. parses one unknown JSON value with Effect `Schema.parseJson()`;
4. applies a private Effect Schema refinement that rejects container
   depth over 16 and unpaired Unicode surrogates;
5. canonicalizes that value with JCS and requires the input bytes to
   match; and
6. decodes through the exact closed schema.

No semantic value escapes before every step succeeds.
AuthenticatedHttp deliberately performs steps 1 through 4 as its
parse prelude, performs step 5 before authentication, then performs the
complete route-owned schema decode at its specified later stage.

Duplicate object names require no second parser. Native JSON parsing
collapses them, so the resulting value's JCS bytes cannot equal input
bytes that contain the repeated member. The mandatory byte comparison
therefore rejects every duplicate-name input.

The maximum decoded JSON container depth is 16. A root object or array
has depth 1, each nested object or array adds 1, and scalar values add
no depth. A decoder rejects excess depth before constructing a semantic
value. This Gate 1 bound is not deployment-configurable.

Unknown members, duplicate members, trailing data, byte-order marks,
lone surrogate code points, and non-JCS number spellings are rejected.
No input is normalized before comparison.

Objects shown in this chapter use readable key order. Their bytes use
JCS key order.

## Base64url

JWS, identifiers, digests, nonces, JWK coordinates, and opaque bodies
use RFC 4648 base64url without `=` padding. Decoders reject:

- the standard base64 `+` and `/` alphabet;
- padding;
- whitespace;
- an impossible encoded length;
- nonzero unused trailing bits; and
- any spelling that does not re-encode byte-identically.

An opaque body may contain zero bytes, represented by the empty string.
Route bounds limit its maximum length.

## Refined values

| Value | Exact JSON string |
|---|---|
| `AgentId` | `agt_` plus the 22-character canonical base64url encoding of 16 bytes |
| `PrincipalId` | `prn_` plus the 22-character canonical base64url encoding of 16 bytes |
| `OperationId` | `opn_` plus the 22-character canonical base64url encoding of 16 bytes |
| `MessageId` | `msg_` plus the 22-character canonical base64url encoding of 16 bytes |
| `AgentCardDigest` | `acd_` plus the 43-character canonical base64url encoding of 32 bytes |
| `AgentName` | 3 to 32 ASCII characters matching `^[a-z0-9]+(-[a-z0-9]+)*$` |
| `issuedAt` | whole-second UTC matching `YYYY-MM-DDTHH:mm:ssZ` |

`issuedAt` rejects fractional seconds, offsets, spaces, leap-second
spelling, and any equivalent alternate representation.

Each semantic value has a distinct nominal type. A decoder for one
prefix never constructs another type.

## Ed25519 public JWK

The public JWK is exactly:

```json
{
  "crv": "Ed25519",
  "kty": "OKP",
  "x": "<43-character canonical base64url encoding of 32 bytes>"
}
```

Member names and values are case-sensitive. No `alg`, `d`, `key_ops`,
`kid`, `use`, X.509 member, JWK URL, or extension member is permitted.

The key identifier is the RFC 9278 JWK Thumbprint URI computed from the
exact public JWK:

```text
urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>
```

`<thumbprint>` is the canonical unpadded base64url SHA-256 digest
defined by RFC 7638 and RFC 9278.

## AgentCard

### Payload

The payload is exactly:

```json
{
  "kind": "agentCard",
  "moltzapVersion": "2026.729.1",
  "agentId": "agt_<22-character-base64url>",
  "principalId": "prn_<22-character-base64url>",
  "agentName": "example-agent",
  "publicKey": {
    "crv": "Ed25519",
    "kty": "OKP",
    "x": "<43-character-base64url>"
  },
  "issuedAt": "YYYY-MM-DDTHH:mm:ssZ"
}
```

The payload has no optional member.

### General JWS

An encoded AgentCard is one attached General JWS object:

```json
{
  "payload": "<base64url(JCS payload bytes)>",
  "signatures": [
    {
      "protected": "<base64url(JCS protected-header bytes)>",
      "signature": "<86-character base64url Ed25519 signature>"
    }
  ]
}
```

The decoded protected header is exactly:

```json
{
  "alg": "Ed25519",
  "kid": "<Registry signer RFC-9278 JWK Thumbprint URI>",
  "typ": "application/vnd.moltzap.agent-card+jws"
}
```

`Ed25519` is the fully specified JOSE algorithm identifier from RFC
9864.

An AgentCard verifier receives the deployment-pinned Registry signer
public JWK. It requires the protected `kid` to equal that key's RFC 9278
thumbprint URI and verifies the signature with that key. The JWS never
supplies its own trust root.

The outer object, signature object, protected header, and payload are
closed. `signatures` has exactly one member. The signature object has no
unprotected `header`.

Compact JWS, Flattened JWS, detached payloads, multiple signatures,
unprotected headers, `b64`, `crit`, `cty`, embedded JWKs, JWK URLs, and
X.509 members are rejected.

`AgentCardDigest` is `acd_` plus canonical base64url SHA-256 over the
UTF-8 JCS bytes of the complete General JWS object.

## SignedMessage

### Payload

The payload is exactly:

```json
{
  "kind": "signedMessage",
  "moltzapVersion": "2026.729.1",
  "senderAgentId": "agt_<22-character-base64url>",
  "agentCardDigest": "acd_<43-character-base64url>",
  "recipientAgentIds": [
    "agt_<22-character-base64url>"
  ],
  "messageId": "msg_<22-character-base64url>",
  "body": "<canonical unpadded base64url>"
}
```

`recipientAgentIds` is nonempty. After decoding the AgentId payload
bytes, entries are unique and strictly increasing by unsigned bytewise
order. A signer constructs that order. A verifier rejects a different
order instead of sorting it.

The body is opaque bytes. Identity and Router never decode or
re-encode its contents.

### General JWS

An encoded SignedMessage has the same exact one-signature attached
General JWS shape as AgentCard. Its protected header is exactly:

```json
{
  "alg": "Ed25519",
  "kid": "<sender RFC-9278 JWK Thumbprint URI>",
  "typ": "application/vnd.moltzap.signed-message+jws"
}
```

The same closed-shape and rejection rules apply. The sender's verified
AgentCard public JWK verifies the signature. `senderAgentId`,
`agentCardDigest`, protected `kid`, and the resolved card must all bind
to the same immutable identity.

The Router-owned SignedMessageDigest representation is specified in
`router-representation.md`.

## AuthenticatedHttp framing

AuthenticatedHttp accepts only:

- a route using the normal profile;
- Registry registration using the registration profile; or
- a public Registry lookup or list route with no signature profile.

Authenticated request bodies are canonical JSON and have one of these
outer shapes.

Normal:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {}
}
```

Registration:

```json
{
  "request": {}
}
```

The route supplies the exact closed schema replacing `{}`.

Registry and Router domain POST requests:

- have exactly one `Content-Type` field whose field value is
  `application/json`, with no parameter;
- have no `Content-Encoding`;
- do not require `Accept`;
- have exactly one `MoltZap-Version` field with value `2026.729.1`;
  and
- use one body whose octets are the canonical JSON bytes.

Every Registry and Router route requires an absent request-target query
component. Any present query component, including an empty one, fails
route lookup as 404 `{"error":"not_found"}` before authentication or
domain handling. This raw request-target check is independent of
signature verification. Under RFC 9421, accepted requests cover
`@query` with the derived value `?`; that derived value alone does not
distinguish an absent query component from a present empty one.

Authenticated requests also have exactly one `Content-Digest`
dictionary member:

```text
Content-Digest: sha-256=:<RFC 8941 base64 of SHA-256(body octets)>:
```

Duplicate covered fields, combined alternate values, or an additional
digest algorithm are rejected.

Responses with JSON bodies use `Content-Type: application/json` and JCS
bytes. `GET /healthz` has no body. Application code imposes no URL
scheme or TLS requirement. L1 and L2 responses carry no
application-layer response signature; their network-path assumption is
specified in `identity.md`.

## HTTP message signatures

Authenticated requests contain exactly one `Signature-Input` dictionary
member and one matching `Signature` dictionary member. Their label is
`moltzap`.

### Normal profile

The signature-input covered-component order is exactly:

```text
"@method" "@authority" "@path" "@query" "content-digest" "content-type" "moltzap-version"
```

Its tag is `moltzap-request-v1`.

### Registration profile

The covered-component order is exactly:

```text
"@method" "@authority" "@path" "@query" "content-digest" "content-type" "moltzap-version" "authorization"
```

Its tag is `moltzap-registration-v1`.

### Parameters

After the covered components, signature parameters appear exactly once
and in this order:

1. `created`
2. `expires`
3. `keyid`
4. `nonce`
5. `alg`
6. `tag`

`created` and `expires` are integer Unix seconds. `created` is not later
than `expires`; the interval is at most 300 seconds. At verification,
`created` may be at most five seconds after the verifier clock and
`expires` must not be earlier than it.

`keyid` is the signing JWK's RFC 9278 thumbprint URI. `nonce` is the
22-character canonical base64url representation of 16 random bytes.
`alg` is the RFC 9421 HTTP Signature Algorithms registry value
`ed25519`. `tag` is the exact profile tag above.

Extra labels, covered components, parameters, or signature bytes are
rejected.

## Registration admission

Registration has exactly one covered authorization field:

```text
Authorization: MoltZap-Admission <token68>
```

The credential is 8 to 512 token68 characters. Leading or trailing
whitespace, multiple credentials, parameters, and a different scheme
are rejected. The configured and received credential remains redacted
in values, logs, traces, metrics, defects, and public errors.

## AuthenticatedHttp validation order

The server performs:

1. route lookup and method check;
2. content framing, content type, content encoding, body limit, and
   early concurrency bound;
3. fatal UTF-8, JSON parse, JCS comparison, and minimum caller or
   submitted-key extraction;
4. content digest, HTTP signature, key, admission, and time checks;
5. atomic nonce claim;
6. signed MoltZap version check;
7. complete closed route-owned schema decode; and
8. domain handler.

For Router send and poll, stage 7 validates the closed outer request
while retaining `signedMessage` as a bounded raw JSON object and
`pollCursor` as a bounded string. The Router domain handler performs
the complete SignedMessage or PollCursor decode, so their failures map
to `message_invalid` or `cursor_invalid`, respectively.

An otherwise valid wrong-version request consumes its nonce.

At stage 5, an already claimed live nonce is
`authentication_failed`. A novel nonce that cannot be retained because
the live-nonce capacity is full is `overloaded` with status 429; it is
not claimed, and no unexpired nonce is evicted.

### Public Registry read validation order

Lookup and list perform:

1. exact route lookup and method check;
2. content framing, content type, content encoding, body byte bound,
   and early concurrency bound;
3. exact `MoltZap-Version` check;
4. fatal UTF-8 decoding, JSON parsing, complete closed-schema decoding,
   JCS re-encoding, and byte comparison; and
5. domain handling.

Public lookup and list reject `Content-Digest`, `Signature-Input`,
`Signature`, or `Authorization` as stage-2 400 `malformed`. They do not
ignore or verify an authentication profile that the route does not own.

When multiple conditions fail, the earliest stage determines the
response. Framing failures therefore precede `version_mismatch`, and
`version_mismatch` precedes `malformed` body or schema failures. Public
reads perform no key resolution, signature verification, admission
check, or nonce claim.

### Exact envelope precedence

Each profile evaluates its numbered stages in order. Within one stage,
the first matching row below determines the response. `GET /healthz`
uses the common stage-1 route and method rules, then only its
route-specific 204 or 503 readiness contract.

Common route and framing outcomes are:

| Stage | First matching condition | Outcome |
|---:|---|---|
| 1 | no exact route, including any present query component | 404 `not_found` |
| 1 | exact route with a different method | 405 `method_not_allowed` |
| 2 | malformed HTTP framing or a duplicate field required to be single-valued | 400 `malformed` |
| 2 | public read carries `Content-Digest`, `Signature-Input`, `Signature`, or `Authorization` | 400 `malformed` |
| 2 | missing, parameterized, or unsupported `Content-Type`, or any `Content-Encoding` | 415 `unsupported_media_type` |
| 2 | body exceeds the route byte bound | 413 `payload_too_large` |
| 2 | request queue or early concurrency capacity is unavailable | 429 `overloaded` |

Authenticated-profile outcomes after common framing are:

| Stage | First matching condition | Outcome |
|---:|---|---|
| 3 | fatal UTF-8, JSON syntax, duplicate name, depth, canonical-byte, or minimum-identity extraction failure | 400 `malformed` |
| 4 | required Registry resolution cannot start because lookup capacity is full | 429 `overloaded` |
| 4 | required Registry resolution is unavailable or times out | 503 `unavailable` |
| 4 | missing or invalid digest, signature fields, covered component, key binding, card, admission credential, proof, algorithm, tag, or time window | 401 `authentication_failed` |
| 5 | nonce is already live | 401 `authentication_failed` |
| 5 | nonce is novel but live-nonce capacity is full | 429 `overloaded`; do not claim it |
| 6 | the authenticated signed MoltZap version differs | 412 `version_mismatch`; retain the nonce claim |
| 7 | complete closed route-owned schema fails | 400 `malformed`; retain the nonce claim |
| 8 | owner request capacity, including held-poll capacity, is unavailable | 429 `overloaded` |
| 8 | a required domain dependency is unavailable or times out | 503 `unavailable` |
| 8 | an unexpected implementation failure occurs | 500 `internal` |

Public Registry read outcomes after common framing are:

| Stage | First matching condition | Outcome |
|---:|---|---|
| 3 | `MoltZap-Version` is absent or differs | 412 `version_mismatch` |
| 4 | fatal UTF-8, JSON syntax, duplicate name, depth, canonical-byte, or complete closed-schema failure | 400 `malformed` |
| 5 | Registry storage is unavailable or times out | 503 `unavailable` |
| 5 | an unexpected implementation failure occurs | 500 `internal` |

Reaching a domain refusal or success returns the route's closed status
200 result. Router-owned post-authentication SignedMessage artifact and
message-bound failures are domain results specified in
`router-representation.md`; owner saturation remains the 429 envelope
outcome above.

Normal authentication, AgentCard resolution, key binding, digest,
signature, timing, and replay failures all become:

```json
{"error":"authentication_failed"}
```

Registration admission and proof failures produce the same public
response. Registry resolution infrastructure failure produces
`unavailable`.

## Envelope failures

Non-domain failures have exactly one-member bodies:

| Status | Exact body |
|---:|---|
| 400 | `{"error":"malformed"}` |
| 401 | `{"error":"authentication_failed"}` |
| 404 | `{"error":"not_found"}` |
| 405 | `{"error":"method_not_allowed"}` |
| 412 | `{"error":"version_mismatch"}` |
| 413 | `{"error":"payload_too_large"}` |
| 415 | `{"error":"unsupported_media_type"}` |
| 429 | `{"error":"overloaded"}` |
| 503 | `{"error":"unavailable"}` |
| 500 | `{"error":"internal"}` |

The `kind` field below is the common closed-union discriminator already
used by AgentCard and SignedMessage. No second result-tag vocabulary is
introduced.

## Registry routes

### Register

`POST /v1/identities:register` uses the registration authenticated
outer body:

```json
{
  "request": {
    "operationId": "opn_<22-character-base64url>",
    "principalId": "prn_<22-character-base64url>",
    "agentName": "example-agent",
    "publicKey": {
      "crv": "Ed25519",
      "kty": "OKP",
      "x": "<43-character-base64url>"
    }
  }
}
```

A well-formed authenticated domain request returns status 200 and
exactly one result:

```json
{"kind":"registered","agentCard":{}}
```

```json
{"kind":"name_taken"}
```

```json
{"kind":"key_already_registered"}
```

```json
{"kind":"idempotency_conflict"}
```

`agentCard` is the complete General JWS object specified above.

### Lookup

`POST /v1/identities:lookup` is public and accepts exactly one of:

```json
{"agentId":"agt_<22-character-base64url>"}
```

```json
{"agentName":"example-agent"}
```

It returns status 200 and:

```json
{"kind":"found","agentCard":{}}
```

or:

```json
{"kind":"not_found"}
```

### List

`POST /v1/identities:list` is public and accepts:

```json
{}
```

or:

```json
{"afterAgentId":"agt_<22-character-base64url>"}
```

It returns status 200 and:

```json
{
  "kind": "page",
  "agentCards": [],
  "hasMore": false
}
```

`agentCards` contains complete General JWS AgentCards in strictly
increasing decoded AgentId order. Its maximum length is the
server-configured page size. `hasMore` is true exactly when another
card exists after the last returned AgentId.

### Health

`GET /healthz` returns:

- 204 with no body when ready; or
- 503 with no body when not ready.

It requires no MoltZap version or request signature.

## Rejection summary

- A noncanonical or schema-invalid public Registry request is 400
  `malformed`.
- A missing or wrong version on a public Registry request is 412
  `version_mismatch`.
- Domain refusals use status 200 and their closed `kind` result.
- No error or result carries a free-form reason.

## Decisions

- `../decisions/20260729-representations-are-layer-owned.md`
- `../decisions/20260729-identity-uses-jcs-jose-authenticated-http.md`
