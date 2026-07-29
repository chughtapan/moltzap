# L2 Router representation

{/* @bake-constants: V2_PROTOCOL_VERSION */}

Status: **Gate 1 normative**

Semantic contract: [`router.md`](./router.md)

This chapter owns the exact Router representation. The `router` package
uses L1 AuthenticatedHttp and SignedMessage without exporting their
mechanisms.

## Canonical JSON

Every Router request and result body uses RFC 8785 JCS UTF-8 bytes.
Router repeats the same strict canonical-input rule at its boundary:
fatal UTF-8, one JSON value, duplicate-name rejection, exact closed
schema decode, and byte equality with the JCS re-encoding.

Unknown members, duplicate members, trailing data, byte-order marks,
lone surrogate code points, and alternate number spellings are
rejected. Objects shown below use readable key order; their bytes use
JCS key order.

The maximum decoded JSON container depth is 16. A root object or array
has depth 1, each nested object or array adds 1, and scalar values add
no depth. A decoder rejects excess depth before constructing a semantic
value. This Gate 1 bound is not deployment-configurable.

## Refined values

| Value | Exact JSON string |
|---|---|
| `RouterInstanceId` | `rti_` plus the 22-character canonical unpadded base64url encoding of 16 bytes |
| `SignedMessageDigest` | `smd_` plus the 43-character canonical unpadded base64url encoding of 32 bytes |
| `PollCursor` | `plc_` plus the exact Compact JWE below |

The base64url rejection rules in `identity-representation.md` apply at
the L2 boundary and are repeated by Router-owned decoders. The three
values are nominally distinct.

`SignedMessageDigest` is SHA-256 over the UTF-8 JCS bytes of the
complete SignedMessage General JWS object, prefixed as specified above.
It is an equality receipt for one retained live entry, not an order or
delivery proof.

## PollCursor

PollCursor is an opaque client-held value. After removing `plc_`, the
remainder is one Compact JWE with five base64url segments.

The protected header JCS value is exactly:

```json
{
  "alg": "dir",
  "enc": "A256GCM",
  "typ": "application/vnd.moltzap.poll-cursor+jwe"
}
```

There is no JWE unprotected header, shared header, recipient header,
additional authenticated data, compression, key ID, or extension
member. `alg: dir` uses the process's random 256-bit key directly.
`enc: A256GCM` uses a fresh 96-bit IV for every cursor encryption and a
128-bit authentication tag. The Compact JWE encrypted-key segment is
empty as required by `dir`.

The encrypted plaintext is the JCS UTF-8 representation of exactly:

```json
{
  "agentId": "agt_<22-character-base64url>",
  "routerInstanceId": "rti_<22-character-base64url>",
  "lastScannedOrder": "0"
}
```

`lastScannedOrder` matches `0|[1-9][0-9]*`. It has no sign, leading
zero, whitespace, exponent, fraction, or numeric JSON representation.
The decimal is a private Router value and never leaves the encrypted
plaintext.

Compact-JWE parse failure, noncanonical protected header or plaintext,
authentication failure, wrong caller or instance, future order, and a
previous process key all become `cursor_invalid`.

## Authenticated request envelope

Send and poll use the exact normal AuthenticatedHttp profile from
`identity-representation.md`. Their outer body is:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {}
}
```

`callerAgentId` is both the HTTP-authentication identity and the poll
recipient. For send it must also equal the verified SignedMessage
sender.

Requests use `Content-Type: application/json`,
`MoltZap-Version: 2026.729.1`, exact Content-Digest, and the
`moltzap-request-v1` HTTP message-signature profile. Application code
imposes no URL scheme or TLS requirement.

The `kind` field is the common closed-union discriminator already used
by L1. Every well-formed, authenticated, version-matched domain request
returns status 200 with one closed result. Envelope failures use the
status and exact `{"error":"..."}` bodies in
`identity-representation.md`.

## Send

`POST /v1/messages:send`

The exact body is:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {
    "expectedRouterInstanceId": "rti_<22-character-base64url>",
    "mode": "initial",
    "signedMessage": {}
  }
}
```

`mode` is exactly `initial` or `retry`. `signedMessage` is the complete
General JWS object specified by `identity-representation.md`.

The exact results are:

```json
{
  "kind": "accepted",
  "routerInstanceId": "rti_<22-character-base64url>",
  "signedMessageDigest": "smd_<43-character-base64url>"
}
```

```json
{
  "kind": "router_restarted",
  "routerInstanceId": "rti_<22-character-base64url>"
}
```

```json
{"kind":"message_invalid"}
```

```json
{"kind":"idempotency_conflict"}
```

```json
{"kind":"retry_identity_unknown"}
```

`message_invalid` collapses every post-authentication SignedMessage
shape, binding, key, digest, signature, recipient, and configured
message-bound failure. It carries no reason.

## Poll

`POST /v1/messages:poll`

An initial anchor has the exact body:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {}
}
```

A continuation has:

```json
{
  "callerAgentId": "agt_<22-character-base64url>",
  "request": {
    "pollCursor": "plc_<compact-jwe>"
  }
}
```

The exact results are:

```json
{
  "kind": "batch",
  "routerInstanceId": "rti_<22-character-base64url>",
  "signedMessages": [],
  "pollCursor": "plc_<compact-jwe>"
}
```

```json
{
  "kind": "feed_gap",
  "routerInstanceId": "rti_<22-character-base64url>"
}
```

```json
{"kind":"cursor_invalid"}
```

`signedMessages` contains complete SignedMessage General JWS objects in
the restriction of Router's private global order to the authenticated
caller. It may be empty only for an initial anchor or continuation
timeout.

`cursor_invalid` has no RouterInstanceId. `feed_gap` has no partial
batch or PollCursor.

## Health

`GET /healthz` returns:

- 204 with no body when locally ready; or
- 503 with no body when not ready.

It requires no MoltZap version or request signature and reveals no
Registry status.

## Envelope failure mapping

Before a domain result, Router uses the exact AuthenticatedHttp order
and mapping:

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

Registry lookup infrastructure failure during normal authentication is
503 `unavailable`. Registry lookup failure during post-authentication
caller verification is also 503 `unavailable`. A missing identity is
an authentication failure at the L1 boundary.

## Decisions

- `../decisions/20260729-representations-are-layer-owned.md`
- `../decisions/20260729-router-order-is-opaque.md`
