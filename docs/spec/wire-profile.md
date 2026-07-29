# Wire profile — the exact byte contract

Status: **Gate 1 normative**

This chapter is the single normative catalog of every byte-level
constant in the Gate 1 wire. It assigns what the other normative
chapters deliberately left unassigned. Where a chapter already fixes a
value, this catalog restates it as a constraint and never widens it.

An implementer takes every constant from here. No implementation may
introduce a wire constant, map key, tag, OID, domain string, prefix,
status code, or schema that this chapter does not assign, and no
implementation-local default fills a gap in it.

## Authority

`AGENTS.md` and `v2/VISION.md`, then current ADR outcomes, then this
chapter alongside the other `docs/spec/` chapters. This chapter owns
byte-level assignment; the semantic chapters own guarantees and
failure behavior. A disagreement between them is a documentation
defect to be reported, not resolved by inference.

Semantic ownership stays where it already is:

| Concern | Owning chapter |
|---|---|
| Identities, cards, registration, request authentication | `identity.md` |
| Router ordering, delivery, polling, restart | `data-plane.md` |
| Registry and Ledger operations, atomic commit | `control-plane.md` |
| OpenFloorV1 contention, grants, TTL | `endpoints/tasks.md` |
| Daemon, local MCP, attention | `endpoints/daemon.md` |
| Type ownership and package graph | `layer-interfaces.md` |
| CLI boundary, redaction, projection | `cli.md` |

## Reading this chapter

Every statement in sections 1 through 13 and in `Acceptance criteria`
is binding. A paragraph beginning `Rationale:` and the whole
`Non-normative notes` section explain a choice and bind nothing.

- `MUST`, `MUST NOT`, and `exactly` are absolute.
- A `SHOULD` never appears. Gate 1 has no optional wire behavior.
- Byte literals are hexadecimal with a `0x` prefix.
- `bstr(n)` is a CBOR byte string of exactly `n` bytes; `bstr` is a
  byte string of any length. `tstr` is a CBOR text string. `uint` is
  a CBOR unsigned integer.
- `det-cbor(x)` is the deterministic encoding of `x` under section 3.
- An ABNF fragment uses RFC 5234 core rules.

## 1. Version carriage and the source of each constant

### 1.1 The MoltZap compatibility value

`v2/VERSION` is the sole source of the MoltZap compatibility value.
This chapter never restates that value; restating it would create a
second authority and the repository's documentation drift gate rejects
a version-shaped literal in `docs/`.

The value is the exact file content of `v2/VERSION` with one optional
trailing line feed removed. It is carried in exactly two places:

| Carrier | Form |
|---|---|
| `moltzap-protocol` HTTP request header | the exact value, one field line, no parameters |
| `protocol` field of a signed or stored MoltZap structure | `tstr` equal to the exact value |

Requests and responses carry no version field in their CBOR bodies:
the header carries it for the HTTP attempt, and structures that
outlive the attempt (`UnsignedMessage`, `ActionBinding`,
`TranscriptRecord`) carry it in-band because they are verified long
after the request is gone.

A service compares the header for exact octet equality and rejects a
mismatch before any domain processing or state change
(`identity.md` — HTTP request authentication).

### 1.2 Independently pinned values

These are not derived from `v2/VERSION` and never negotiated against
it:

| Value | Constant |
|---|---|
| MCP core revision | `2026-07-28` |
| MCP core pinned commit | `5f5440bb26a62e2cf3440b92da5a667efa03b267` |
| MoltZap MCP extension identifier | `xyz.moltzap/events-v1` |
| MoltZap URI scheme | `moltzap` |
| MoltZap reverse-DNS namespace | `xyz.moltzap` |
| MoltZap OID arc | `2.25.207290692779462626256938133231573616585` |

### 1.3 Deployment-supplied values

Three values are per-deployment configuration rather than protocol
constants. This chapter fixes their exact type and validation; a
deployment supplies the value.

| Value | Type | Consumed by |
|---|---|---|
| Registry attestation key | DER `SubjectPublicKeyInfo` for Ed25519, 44 bytes (section 5.9) | every process that verifies an AgentCard |
| Registration admission code | `token68` per RFC 9110, 8 to 512 characters | Registry, CLI |
| Service routes | `ServiceRoute` (section 5.7) | endpoints |

Nothing else is deployment-configurable on the wire. Operational
bounds — decode limits, page sizes, retention, caches, concurrency —
are process settings and never appear in a MoltZap structure
(`data-plane.md` — Operational bounds).

## 2. Identifiers

### 2.1 Binary forms

| Identifier | Bytes | Kind |
|---|---|---|
| `AgentId` | 16 | Registry-minted opaque |
| `PrincipalId` | 16 | caller-supplied opaque |
| `OperationId` | 16 | caller-supplied opaque |
| `MessageId` | 16 | sender-chosen opaque |
| `RouterInstanceId` | 16 | Router-minted opaque |
| `ConversationId` | 16 | derived (section 4) |
| `TxnId` | 16 | derived for START, fresh for MULTICAST |
| `AgentCardThumbprint` | 32 | SHA-256 |
| `SpkiThumbprint` | 32 | SHA-256 |
| `RecordHash` | 32 | SHA-256 |
| `ContentDigest` | 32 | SHA-256 |
| `ReplyFingerprint` | 32 | SHA-256 |

Every 16-byte identifier is a CBOR `bstr(16)`. Every 32-byte digest is
a CBOR `bstr(32)`. A decoder MUST reject any other length.

`RouterSequence` and `LedgerOffset` are `uint`, not opaque
identifiers. `RouterSequence` starts at 1 for the first accepted send
of a Router instance and increases by exactly 1 per accepted send.
`LedgerOffset` starts at 0 for a conversation's START record and
increases by exactly 1 per committed record. `PollCursor` and
`LedgerOffset` never appear where the other is expected
(`layer-interfaces.md` — Transcript).

An opaque 16-byte identifier that is not derived MUST be drawn from a
cryptographically secure random source. The Registry MUST NOT mint an
`AgentId` whose 16 bytes are all zero, because RFC 5280 §4.1.2.2
requires a certificate serial number to be a positive integer and
section 5.3 derives the serial from those bytes.

### 2.2 Textual projection

JSON, MCP, CLI output, log lines, and URIs use one canonical textual
form and no other:

```abnf
typed-id      = type-prefix "_" payload
type-prefix   = 3(%x61-7A)                ; three lowercase letters
payload       = 22(b64url-char) / 43(b64url-char)
b64url-char   = ALPHA / DIGIT / "-" / "_"
```

The payload is the unpadded base64url (RFC 4648 §5) encoding of the
binary value.

A parser MUST split at the fixed offset: characters 0 through 2 are
the prefix, character 3 is `_`, and the remainder is the payload. The
payload alphabet itself contains `_`, so a parser MUST NOT split on
the last or on an arbitrary `_`.

A decoder MUST reject a non-canonical trailing group. The final
payload character carries the value's unused low bits and MUST be:

| Binary length | Payload length | Permitted final character |
|---|---|---|
| 16 bytes | 22 | `A`, `Q`, `g`, `w` |
| 32 bytes | 43 | `A`, `E`, `I`, `M`, `Q`, `U`, `Y`, `c`, `g`, `k`, `o`, `s`, `w`, `0`, `4`, `8` |

Assigned prefixes are closed. A textual identifier bearing any other
prefix is rejected.

| Prefix | Identifier | Total length |
|---|---|---|
| `agt` | `AgentId` | 26 |
| `prn` | `PrincipalId` | 26 |
| `opn` | `OperationId` | 26 |
| `msg` | `MessageId` | 26 |
| `cnv` | `ConversationId` | 26 |
| `txn` | `TxnId` | 26 |
| `rti` | `RouterInstanceId` | 26 |
| `crd` | `AgentCardThumbprint` | 47 |
| `spk` | `SpkiThumbprint` | 47 |
| `rec` | `RecordHash` | 47 |
| `cdg` | `ContentDigest` | 47 |
| `rpf` | `ReplyFingerprint` | 47 |

The projection never changes a signed or stored representation
(`cli.md` — Output and errors). A textual identifier never appears
inside a MoltZap CBOR structure; those carry the binary form.

### 2.3 MoltZap URIs

Two URI shapes exist. Both are constructed from the textual form
above.

| URI | Use |
|---|---|
| `moltzap://agent/<AgentId text>` | X.509 subject alternative name; normal-profile RFC 9421 `keyid` |
| `moltzap://principal/<PrincipalId text>` | X.509 subject alternative name |

One further `keyid` shape exists for the pre-card bootstrap profile
only: `moltzap://spki/<SpkiThumbprint text>` (section 9.6).

A verifier MUST compare a MoltZap URI by exact octet equality. There
is no percent-encoding, no case folding, no default port, no query,
and no fragment.

### 2.4 AgentName grammar

`AgentName` is the immutable, Registry-wide unique, lowercase,
mention-safe slug of `identity.md`. Its wire form is already
canonical; a decoder rejects an alternate spelling rather than
normalizing it.

```abnf
agent-name    = label *( "-" label )
label         = 1*( %x61-7A / %x30-39 )    ; a-z 0-9
```

That grammar is exactly the regular expression
`^[a-z0-9]+(-[a-z0-9]+)*$`. Independently of it, an `AgentName` MUST
be at least 3 and at most 32 characters.

The rule set is complete and closed. A decoder MUST reject, without
repair:

- any uppercase letter;
- any character outside `a-z`, `0-9`, and `-`;
- a leading or trailing `-`;
- two or more consecutive `-`;
- any leading or trailing whitespace;
- any non-ASCII code point, including a Unicode confusable, a
  combining mark, and any form that would require NFC or NFKC
  normalization;
- a name shorter than 3 or longer than 32 characters.

Registry-wide uniqueness is exact octet equality over that canonical
form. Because the grammar admits exactly one spelling of any admitted
name, no case folding, normalization, or confusable-skeleton index is
performed or needed.

Gate 1 reserves no `AgentName`. The grammar above is the complete
admission rule. There is no `@all`, `@here`, or other broadcast name:
L2 routes only to explicit `AgentId`s (`data-plane.md` — Message and
Delivery), and `start_conversation.members` names explicit agents.

Rationale: an `AgentName` is carried by the X.509 card, by
registration, and by name lookup, but it never appears in a signed
addressing or fixed-member binding — those use canonical `AgentId`
(`identity.md` — Identity types) — and it carries no routing meaning.
The grammar therefore only has to guarantee exactly one spelling and
safe rendering after `@`.

### 2.5 Legal-action identifiers

A legal-action descriptor's `actionId` (`endpoints/tasks.md` — Legal
actions) MUST match:

```abnf
action-id     = segment *("." segment)
segment       = %x61-7A *(%x61-7A / %x30-39)
```

Gate 1 advertises exactly one legal action, and its identifier is:

`openfloor.v1.speak`

Its payload schema is section 11.7. A daemon MUST NOT advertise any
other `actionId` in Gate 1.

## 3. Deterministic CBOR profile

Every MoltZap-owned structure — signed bodies, request bodies,
response bodies, cursors, and the routing extension — uses this
profile. Opaque bytes carried by another layer are never decoded or
re-encoded (`data-plane.md` — Message and Delivery).

### 3.1 Encoding rules

An encoder MUST produce, and a decoder MUST require, RFC 8949 §4.2.1
core deterministic encoding, further restricted as follows.

1. Definite lengths only. Indefinite-length arrays, maps, byte
   strings, and text strings are rejected.
2. Preferred serialization for every integer and every length: the
   shortest argument encoding that represents the value.
3. Map keys are sorted by the bytewise lexicographic order of their
   encoded key bytes. For the small positive integer keys used by
   MoltZap maps this is ascending numeric order.
4. Duplicate map keys are rejected.
5. Unknown map keys are rejected at every depth. There is no
   extension bag (`identity.md` — Attributed L1 message).
6. Missing required map keys are rejected. An optional key is
   represented by absence, never by `null` and never by a
   type-default value.
7. Tags are rejected except the two assigned in section 6:
   COSE_Sign1 (`18`) and COSE_Sign (`98`).
8. Major type 7 values are rejected except `false` (0xF4), `true`
   (0xF5), `null` (0xF6) where a schema admits them, and the
   binary64 float (0xFB) where section 3.4 admits it. `undefined`,
   every other simple value, binary16, and binary32 are rejected.
9. Text strings MUST be well-formed UTF-8 with no unpaired
   surrogate and no byte-order mark. A decoder MUST NOT apply
   Unicode normalization.
10. Trailing bytes after the outermost item are rejected.

A decoder MUST verify determinism by construction, not by
re-encoding: an accepted item is one whose encoding satisfies rules 1
through 10. Re-encoding an accepted item MUST yield the identical
bytes; a conforming implementation may assert this in tests.

### 3.2 Closed maps

Every MoltZap map is closed. Its keys are `uint` values assigned
where the map is defined, starting at 1 with no gaps in the assigned
range. Most are in section 7; `ServiceRoutes` is in section 5.7 and
the three cursor plain maps are in section 8.2. A map never uses a
text-string key except inside a `JsonValue` (section 3.4).

Key numbers are permanent. A later MoltZap version may add a key, but
never reassigns or reuses one.

### 3.3 Closed unions

Every closed union on MoltZap-owned wire is a definite CBOR array of
exactly two elements:

```
[ discriminant : tstr, value ]
```

The discriminant is drawn from that union's closed set, is lowercase
`snake_case`, and matches `^[a-z][a-z0-9_]*$`. Each arm's `value` type
is assigned where the union is defined; unless stated otherwise it is
a closed map, and an arm with no fields carries the empty map `{}`
(0xA0).

A decoder MUST reject an unknown discriminant, an array of any length
other than 2, and a value whose shape does not match the arm.

Rationale: a two-element array keeps the union self-describing in a
hex dump and in a CBOR diagnostic trace while remaining closed and
deterministic. Numeric arm tags were rejected because a wire dump
would carry no readable meaning.

### 3.4 `JsonValue`

`JsonValue` is the payload type of the `data` content arm
(`endpoints/tasks.md` — ContentPartV1) and of an MCP action payload
projected onto the wire. Its canonical CBOR encoding is:

| JSON value | CBOR |
|---|---|
| `null` | 0xF6 |
| `true` / `false` | 0xF5 / 0xF4 |
| string | `tstr`, UTF-8, not normalized |
| integer in [-2^63, 2^63-1] | `uint` or negative integer, preferred form |
| any other number | binary64 float (0xFB) |
| array | definite CBOR array |
| object | definite CBOR map with `tstr` keys, sorted per rule 3 |

Additional rules:

- A number MUST NOT be NaN, `+Infinity`, `-Infinity`, or negative
  zero. An encoder that holds negative zero MUST encode integer `0`.
- Binary16 and binary32 are rejected even when they would round-trip.
  Exactly one float width exists so that `1.5` has exactly one
  encoding.
- Object keys are compared by exact octet equality; duplicates are
  rejected.
- No tag appears anywhere inside a `JsonValue`.

Rationale: this deviates from RFC 8949 §4.2.2 preferred-float
shortest-form on purpose. JSON has no float-width concept, so
shortest-form would let two conforming encoders disagree on the bytes
of the same JSON document, which the byte-equality corpus forbids.

### 3.5 The derivation function

Every MoltZap hash and derived identifier uses one construction:

```
H(domain, e1, ..., en) = SHA-256( det-cbor([ domain, e1, ..., en ]) )
```

`domain` is a `tstr` literal from the table in section 4. The
remaining elements are the preimage components in the listed order,
each encoded under this profile.

A truncated derivation takes the first 16 bytes of the 32-byte
digest, in order, with no folding and no re-hashing.

Rationale: CBOR's own length prefixes make the preimage
unambiguous, so no separator convention, no length field, and no
padding rule is needed. Concatenation-style preimages were rejected
because they admit extension and boundary confusion between two
variable-length components.

Two thumbprints are deliberate exceptions and are computed as a bare
SHA-256 over DER, with no domain wrapper, because they must match the
universal X.509 thumbprint convention and existing tooling:

- `AgentCardThumbprint = SHA-256(AgentCard DER)`
- `SpkiThumbprint = SHA-256(SubjectPublicKeyInfo DER)`

## 4. Derivations, digests, and literal domain constants

Every literal domain constant in the system appears in this table.
Each is an ASCII `tstr`. No implementation may introduce another.

| Derived value | Domain constant | Preimage components after the domain | Output |
|---|---|---|---|
| `ConversationId` | `moltzap-conversation-id-v1` | starter `AgentId` `bstr(16)`, `OperationId` `bstr(16)` | first 16 bytes |
| START `TxnId` | `moltzap-start-txn-id-v1` | starter `AgentId` `bstr(16)`, `OperationId` `bstr(16)` | first 16 bytes |
| `ContentDigest` | `moltzap-content-digest-v1` | the `content` array | 32 bytes |
| `ReplyFingerprint` | `moltzap-reply-fingerprint-v1` | `TxnId` `bstr(16)`, `actionId` `tstr`, payload `JsonValue` | 32 bytes |
| genesis previous hash | `moltzap-transcript-genesis-v1` | `ConversationId` `bstr(16)` | 32 bytes |
| `RecordHash` | `moltzap-transcript-record-v1` | `protocol` `tstr`, `ConversationId` `bstr(16)`, `epoch` `uint`, `offset` `uint`, previous hash `bstr(32)`, certificate `bstr` | 32 bytes |
| register operation identity | `moltzap-op-register-v1` | `OperationId`, `PrincipalId`, `AgentName`, `spki` (section 10) | 32 bytes |
| send operation identity | `moltzap-op-send-v1` | signed message bytes `bstr` (section 10) | 32 bytes |
| append operation identity | `moltzap-op-append-v1` | certificate bytes `bstr` (section 10) | 32 bytes |
| start operation identity | `moltzap-op-start-v1` | `OperationId`, member `AgentId` array, `content` array (section 10) | 32 bytes |
| poll cursor integrity tag | `moltzap-poll-cursor-v1` | cursor plain bytes `bstr` (section 8.1) | first 16 bytes |
| Registry list cursor integrity tag | `moltzap-list-cursor-v1` | cursor plain bytes `bstr` (section 8.1) | first 16 bytes |
| Ledger conversations cursor integrity tag | `moltzap-conversations-cursor-v1` | cursor plain bytes `bstr` (section 8.1) | first 16 bytes |

Every row except the last three uses the unkeyed `H` of section 3.5.
The three cursor integrity tags are the keyed construction: they
replace `SHA-256` with `HMAC-SHA-256` under the issuing process's key
over the identical domain-prefixed array, and section 8.1 defines that
in full.

Two further literals are COSE external authenticated data and are
assigned in section 6.3:

- `moltzap-l1-message-v1`
- `moltzap-l3-action-v1`

Notes that bind:

- `ConversationId` and START `TxnId` share their preimage components
  and differ only in their domain constant. This is the separate
  domain separation that `endpoints/daemon.md` requires and it is
  what makes an identical START retry restart-safe.
- A MULTICAST `TxnId` is not derived. The BEGIN author draws 16 fresh
  random bytes. A daemon MUST refuse a BEGIN whose `TxnId` collides
  with a live or committed `TxnId` in that conversation rather than
  guessing which candidate is meant (`endpoints/daemon.md` — reply).
- A conversation's first record has `offset` 0 and its previous hash
  is the genesis derivation above, which binds the chain root to the
  conversation. There is no all-zero previous hash.
- `MessageId`, `OperationId`, `PrincipalId`, and `RouterInstanceId`
  are drawn at random, never derived.

## 5. X.509 AgentCard profile

The AgentCard is one immutable MoltZap-native X.509 certificate per
`AgentId` (`identity.md` — AgentCard). This section fixes its exact
DER.

### 5.1 Object identifiers

The MoltZap arc is derived from the project's DNS name under the
ITU-T X.667 UUID arc, so it requires no registration authority and can
never collide:

```
uuid5(NAMESPACE_DNS, "moltzap.xyz") = 9bf2bc38-cc61-5db6-acd4-775d712f47c9
MoltZap arc = 2.25.207290692779462626256938133231573616585
```

| Name | OID | DER of the OID |
|---|---|---|
| MoltZap arc | `2.25.207290692779462626256938133231573616585` | `0x06 14 69 82 B7 F2 DE 8E 99 C6 8A F6 ED AC EA 9D EB D7 89 BD 8F 49` |
| `id-moltzap-routing` | MoltZap arc `.1` | `0x06 15 69 82 B7 F2 DE 8E 99 C6 8A F6 ED AC EA 9D EB D7 89 BD 8F 49 01` |

`.2` and beyond are unassigned and MUST NOT be used until a later
accepted decision assigns them.

Externally owned OIDs used by this profile:

| Name | OID |
|---|---|
| `id-Ed25519` | `1.3.101.112` |
| `id-at-commonName` | `2.5.4.3` |
| `id-ce-basicConstraints` | `2.5.29.19` |
| `id-ce-keyUsage` | `2.5.29.15` |
| `id-ce-subjectAltName` | `2.5.29.17` |

Rationale: an unregistered IANA Private Enterprise Number arc would be
squatting on a namespace the project does not own. The UUID arc is the
registration-free construction defined for exactly this case, and
deriving the UUID from `moltzap.xyz` makes the arc reproducible by
anyone rather than an arbitrary number.

### 5.2 DER constraints

The AgentCard's canonical form is its DER encoding. A decoder MUST:

1. parse strict DER per X.690 §10, not BER: definite lengths only,
   minimal length encodings, minimal `INTEGER` two's-complement
   content, `BOOLEAN` `TRUE` encoded as `0xFF`, `BIT STRING` unused
   bits exactly 0 for every key and signature, `SET OF` elements in
   ascending encoded order, and no non-minimal tag or length octets;
2. reject any trailing byte after the outermost `SEQUENCE`;
3. verify that re-encoding the parsed certificate reproduces the
   input bytes exactly, and reject the certificate otherwise.

Rule 3 is mandatory, not advisory: an `AgentCardThumbprint` is a hash
over these bytes and unanimity depends on every member computing the
same one.

### 5.3 Certificate fields

| Field | Assignment |
|---|---|
| `version` | v3, encoded as `INTEGER 2` |
| `serialNumber` | the `AgentId`'s 16 bytes read as an unsigned big-endian integer, DER-encoded as a positive `INTEGER` (17 content octets when the high bit is set) |
| `signature` (in `tbsCertificate`) | `AlgorithmIdentifier` with `algorithm` = `id-Ed25519` and `parameters` **absent** (RFC 8410 §3) |
| `issuer` | exactly one `RDNSequence` entry, one `AttributeTypeAndValue`, type `id-at-commonName`, value `UTF8String` `"MoltZap Registry"` |
| `validity.notBefore` | the card's issue time (section 5.4) |
| `validity.notAfter` | `GeneralizedTime` `99991231235959Z` |
| `subject` | exactly one `RDNSequence` entry, one `AttributeTypeAndValue`, type `id-at-commonName`, value `UTF8String` equal to the canonical `AgentName` |
| `subjectPublicKeyInfo` | `algorithm` = `id-Ed25519` with `parameters` absent; `subjectPublicKey` = `BIT STRING`, 0 unused bits, the 32 raw Ed25519 public key bytes |
| `issuerUniqueID`, `subjectUniqueID` | absent |
| `extensions` | exactly the four in section 5.5, in that order |
| `signatureAlgorithm` (outer) | byte-identical to `tbsCertificate.signature` |
| `signatureValue` | `BIT STRING`, 0 unused bits, the 64-byte Ed25519 signature over the DER of `tbsCertificate` |

`notAfter` uses RFC 5280's own no-well-defined-expiry convention
rather than fighting the format; it realizes the card's immutability
and absence of expiry, and it is not a refresh horizon.

### 5.4 Validity encoding

RFC 5280 §4.1.2.5 governs the time type and MoltZap adds no exception:

- a `notBefore` before 2050-01-01T00:00:00Z is `UTCTime`
  `YYMMDDHHMMSSZ`;
- a `notBefore` at or after that instant is `GeneralizedTime`
  `YYYYMMDDHHMMSSZ`;
- seconds are always present, the value is always UTC, and the `Z`
  suffix is required;
- fractional seconds are forbidden.

`notBefore` is truncated to whole seconds and is the card's immutable
issue time (`identity.md` — AgentCard).

### 5.5 Extension set

The extension set is closed. Exactly these four extensions appear, in
this exact order. A certificate carrying any other extension, a
repeated extension, or a different order is rejected.

| # | Extension | Critical | Content |
|---|---|---|---|
| 1 | `id-ce-basicConstraints` | yes | `cA` = FALSE (encoded as an empty `SEQUENCE`, since DER omits a `DEFAULT FALSE`), `pathLenConstraint` absent |
| 2 | `id-ce-keyUsage` | yes | exactly `digitalSignature`, encoded as the minimal `BIT STRING` `0x03 02 07 80` |
| 3 | `id-ce-subjectAltName` | no | exactly two `uniformResourceIdentifier` `GeneralName`s, in this order: `moltzap://agent/<AgentId text>`, then `moltzap://principal/<PrincipalId text>` |
| 4 | `id-moltzap-routing` | yes | `OCTET STRING` whose content is `det-cbor(ServiceRoutes)` (section 5.7) |

`subjectAltName` is non-critical. RFC 5280 §4.2.1.6 requires a
critical `subjectAltName` only when the subject field is an empty
sequence, which it never is here, so non-critical is the assigned
choice rather than a requirement.

`id-moltzap-routing` is critical on purpose. A card is unusable
without its routes, there is no fallback, and criticality also stops a
generic PKIX validator from accepting a MoltZap card as a TLS or
client-authentication credential.

`extendedKeyUsage`, `subjectKeyIdentifier`, `authorityKeyIdentifier`,
`cRLDistributionPoints`, `authorityInfoAccess`, `certificatePolicies`,
and every other extension are absent. Gate 1 has no revocation, no
path building, and no rotation, so those extensions would advertise
capabilities that do not exist.

### 5.6 The MoltZap URI names

The two SAN URIs are built from section 2.2 textual identifiers:

```
moltzap://agent/agt_<22 base64url characters>
moltzap://principal/prn_<22 base64url characters>
```

A verifier MUST parse both, MUST require exactly two names in that
order, and MUST reject any other `GeneralName` choice, an extra name,
or a name whose typed prefix does not match its position.

### 5.7 `ServiceRoutes` and `ServiceRoute`

The routing extension carries the Registry, Router, and Ledger
routing information the endpoint requires (`identity.md` — AgentCard).

`ServiceRoutes` is a closed CBOR map:

| Key | Field | Type |
|---|---|---|
| 1 | `registry` | `ServiceRoute` |
| 2 | `router` | `ServiceRoute` |
| 3 | `ledger` | `ServiceRoute` |

`ServiceRoute` is a `tstr` holding an absolute origin and nothing
else:

```abnf
service-route = "https://" host [ ":" port ]
host          = reg-name / IPv4address / "[" IPv6address "]"
port          = 1*5DIGIT
```

Binding rules:

- the scheme is exactly `https`, with no exception and no loopback
  carve-out. `identity.md` — HTTP request authentication makes TLS
  mandatory for every Registry, Router, and Ledger domain POST, and
  the only loopback exception on record is the daemon's local MCP
  surface, which is not a service route. A route with any other scheme
  is rejected;
- the host is lowercase;
- the default port 443 MUST be omitted; any other port is written
  explicitly with no leading zero;
- there is no path, no trailing `/`, no query, no fragment, and no
  userinfo. A route that carries a path is rejected;
- an operation's route is formed by appending the operation path from
  section 9.2 to the route.

Rationale: a base URL that may carry a path lets one deployment write
`https://h/v1` and another `https://h`, and both then build different
request targets that the RFC 9421 `@path` component covers. Origin
only removes that whole class.

### 5.8 Attestation chain

The chain has exactly one certificate: the AgentCard itself.

- the trust anchor is the Registry attestation Ed25519 public key,
  supplied to every verifying process as deployment configuration
  (section 1.3);
- an intermediate CA, a self-signed Registry certificate on the wire,
  a cross-signature, and PKIX path building are all absent and MUST be
  rejected;
- CRL, OCSP, and `authorityInfoAccess` retrieval never occur.

Verification of an AgentCard is exactly:

1. strict DER parse and re-encode equality (section 5.2);
2. every field and extension matches section 5.3 and 5.5;
3. `tbsCertificate.signature` equals the outer `signatureAlgorithm`
   byte for byte and both name `id-Ed25519` with absent parameters;
4. the Ed25519 signature over `DER(tbsCertificate)` verifies under
   the configured Registry attestation key using the rules of
   section 6.5;
5. `issuer` equals the constant DN in section 5.3 byte for byte.

Step 5 is a format check only. Trust comes solely from step 4's
pinned key; the issuer DN is a label and never a trust input.

A verifier that holds only the 32-byte anchor key and a
`TranscriptRecord` can complete every step above with no live
Registry, which is what makes a record self-contained
(`control-plane.md` — TranscriptRecord).

### 5.9 Registry attestation key and submitted SPKI

A `SubjectPublicKeyInfo` for Ed25519 is exactly 44 DER bytes:

```
30 2A 30 05 06 03 2B 65 70 03 21 00 <32 raw public key bytes>
```

Both the deployment's Registry attestation key and a registration
request's submitted SPKI use exactly this encoding. A decoder MUST
reject any other length, any present `parameters`, and any non-zero
unused-bits count.

`SpkiThumbprint = SHA-256` over those 44 bytes.

### 5.10 Card issuance inputs

The Registry, not the caller, supplies `ServiceRoutes` from its own
deployment configuration. A registration request carries no routing
field. An agent therefore cannot mint a card that points peers at a
Router or Ledger of its choosing.

## 6. COSE profiles

Two closed, domain-separated COSE application profiles exist. A
signature valid under one MUST fail under the other
(`identity.md` — Attributed L1 message).

| Profile | Structure | CBOR tag | Purpose |
|---|---|---|---|
| `moltzap-l1-message-v1` | `COSE_Sign1` | 18 | attributed L1 message |
| `moltzap-l3-action-v1` | `COSE_Sign` | 98 | endpoint action certificate |

Both are always tagged. An untagged structure is rejected.

### 6.1 Headers

The protected header is a closed CBOR map serialized as a `bstr` per
RFC 9052 §3. Only these labels appear:

| Label | Name | Value |
|---|---|---|
| 1 | `alg` | `-8` (EdDSA) |
| 4 | `kid` | `bstr(32)`, the signer's `AgentCardThumbprint` |

Both labels are mandatory in every protected header, including each
per-signature protected header of a `COSE_Sign`. A protected header
carrying any other label — including label 2 `crit`, label 3
`content type`, label 5 `IV`, and any registered or private label —
is rejected.

The unprotected header MUST be the empty map `{}` (0xA0) everywhere:
body and per-signature. Nothing in Gate 1 is carried unsigned.

`crit` behavior is therefore closed by construction: because the
header label set is closed and every admitted label is
mandatory-to-understand, a `crit` array can only ever be redundant or
unsatisfiable. A present `crit` label is rejected in both profiles and
in every position.

### 6.2 Structures

`COSE_Sign1` (tag 18):

```
18([ protected : bstr, {} , payload : bstr, signature : bstr(64) ])
```

`COSE_Sign` (tag 98):

```
98([ protected : bstr, {}, payload : bstr,
     [ COSE_Signature, + ] ])

COSE_Signature = [ protected : bstr, {}, signature : bstr(64) ]
```

The payload is always present and never `null`; detached payloads are
rejected. For `COSE_Sign`, the signature array is ordered by the
signer's `AgentId`, bytewise ascending, with no duplicate signer. A
decoder MUST reject any other order.

### 6.3 External authenticated data

`external_aad` is never empty. It is the UTF-8 octets of the profile's
literal context string:

| Profile | `external_aad` octets |
|---|---|
| `moltzap-l1-message-v1` | `6D 6F 6C 74 7A 61 70 2D 6C 31 2D 6D 65 73 73 61 67 65 2D 76 31` (21 bytes) |
| `moltzap-l3-action-v1` | `6D 6F 6C 74 7A 61 70 2D 6C 33 2D 61 63 74 69 6F 6E 2D 76 31` (20 bytes) |

The same `external_aad` is used for the body of a `COSE_Sign` and for
each of its `COSE_Signature` entries.

Cross-profile rejection therefore has two independent causes: the
RFC 9052 `Sig_structure` context string differs (`"Signature1"`
against `"Signature"`), and the `external_aad` differs. Both MUST
hold; an implementation MUST NOT rely on only one.

### 6.4 Sig_structure

The signed bytes are exactly RFC 9052 §4.4:

```
Sig_structure = [ context : tstr, body_protected : bstr,
                  ? sign_protected : bstr,
                  external_aad : bstr, payload : bstr ]
```

with `context` = `"Signature1"` for `COSE_Sign1` and `"Signature"` for
each `COSE_Signature` of a `COSE_Sign`, and `sign_protected` present
only in the latter. `Sig_structure` is encoded under section 3.

### 6.5 Ed25519 algorithm rules

Every signature in MoltZap — card attestation, L1 message, L3 action,
and RFC 9421 request authentication — is PureEdDSA over edwards25519
per RFC 8032, with no prehash and no context string. Signatures are 64
bytes; public keys are 32 bytes.

Verification is closed so that two implementations cannot disagree
about whether one signature is valid, which unanimity depends on. A
verifier MUST:

1. use the cofactorless verification equation `[S]B = R + [k]A`;
2. reject a signature whose scalar `S` is not canonically reduced,
   that is `S >= L`;
3. reject a non-canonical encoding of the point `R` or of the public
   key `A`;
4. reject a public key `A` of small order.

An implementation MUST NOT accept a signature under a cofactored
equation that these rules reject, and MUST NOT reject one they accept.

Rationale: Ed25519 verification criteria vary across libraries. In a
protocol where a certificate is valid only if every member's
verification agrees, a permissive verifier and a strict verifier
disagreeing on one signature is a liveness bug in the best case and a
split view in the worst.

## 7. CBOR structure catalog

Every structure below is a closed map (section 3.2) or a closed union
(section 3.3). A key marked optional is omitted when absent.

### 7.1 L1 — attributed message

`UnsignedMessage` is the payload of the `moltzap-l1-message-v1`
`COSE_Sign1`.

| Key | Field | Type | Rules |
|---|---|---|---|
| 1 | `protocol` | `tstr` | exact `v2/VERSION` value |
| 2 | `sender` | `bstr(16)` | sender `AgentId` |
| 3 | `senderCard` | `bstr(32)` | sender `AgentCardThumbprint` |
| 4 | `recipients` | array of `bstr(16)` | nonempty, bytewise ascending, no duplicate |
| 5 | `messageId` | `bstr(16)` | |
| 6 | `body` | `bstr` | nonempty, opaque to L1 and L2 |

`SignedMessage` is the tagged `COSE_Sign1` over `det-cbor` of that
map. The exact `SignedMessage` bytes are what a sender transmits, what
Router stores and returns, and what every recipient verifies. Router
MUST NOT decode or re-encode key 6.

`Delivery`:

| Key | Field | Type |
|---|---|---|
| 1 | `routerInstance` | `bstr(16)` |
| 2 | `sequence` | `uint` |
| 3 | `message` | `bstr` — exact `SignedMessage` bytes |

### 7.2 L3 protocol messages

`UnsignedMessage.body` is `det-cbor` of a closed union:

```
[ kind : tstr, payload : map ]
```

The seven kinds are closed. Their L1 sender, explicit recipient set,
canonical ordering, and self-inclusion are fixed here.

| Kind | L1 sender | Explicit recipient `AgentId` set | Sender included | Ordering of the set |
|---|---|---|---|---|
| `start_proposal` | the starter | every other epoch-0 member | no | bytewise ascending |
| `start_signature` | each named member other than the starter | `{ starter }` | not applicable | single element |
| `begin` | the contending member | every epoch-0 member | **yes** | bytewise ascending |
| `ack` | each epoch-0 member | every other epoch-0 member | no | bytewise ascending |
| `action_proposal` | the grant author | every other epoch-0 member | no | bytewise ascending |
| `action_signature` | each member other than the author | `{ author }` | not applicable | single element |
| `commit_notice` | the appending author | every other epoch-0 member | no | bytewise ascending |

Self-delivery rule, stated once: a protocol message includes its
sender in the recipient set exactly when the message's effect on any
member's fold depends on its position in the global Router order.
`begin` is the only such kind, because the winning candidate is the
earliest valid BEGIN in `RouterSequence` order after the committed
head (`endpoints/tasks.md` — Contention and grant). Including the
contender means every member, the contender included, decides the
winner from the identical delivery feed, with no asymmetric path that
reads a position out of a send result and no dependency on recovering
a lost send result to learn one's own position.

Every other kind excludes its sender: the sender already holds the
fact, and the fact's meaning does not depend on where it landed in the
order. A member's own START signature, ACK, and final action signature
are produced locally and never sent to itself.

Payload maps:

`start_proposal`

| Key | Field | Type |
|---|---|---|
| 1 | `conversationId` | `bstr(16)` |
| 2 | `actionBinding` | `bstr` — `det-cbor(ActionBinding)` for the START |

`start_signature`

| Key | Field | Type |
|---|---|---|
| 1 | `conversationId` | `bstr(16)` |
| 2 | `txnId` | `bstr(16)` |
| 3 | `coseSignature` | `bstr` — `det-cbor(COSE_Signature)` |

`begin`

| Key | Field | Type |
|---|---|---|
| 1 | `conversationId` | `bstr(16)` |
| 2 | `epoch` | `uint`, exactly 0 |
| 3 | `txnId` | `bstr(16)` |
| 4 | `base` | `Base` union |
| 5 | `routerInstance` | `bstr(16)` |

`ack`

| Key | Field | Type |
|---|---|---|
| 1 | `conversationId` | `bstr(16)` |
| 2 | `epoch` | `uint`, exactly 0 |
| 3 | `txnId` | `bstr(16)` |
| 4 | `beginSequence` | `uint` — the `RouterSequence` at which the ACKed BEGIN was delivered |

`beginSequence` makes "ACK that exact candidate" mechanical: two
BEGINs with different positions are different candidates even if a
Byzantine contender reuses a `TxnId`.

`action_proposal`

| Key | Field | Type |
|---|---|---|
| 1 | `conversationId` | `bstr(16)` |
| 2 | `txnId` | `bstr(16)` |
| 3 | `actionBinding` | `bstr` — `det-cbor(ActionBinding)` for the MULTICAST |

`action_signature`

| Key | Field | Type |
|---|---|---|
| 1 | `conversationId` | `bstr(16)` |
| 2 | `txnId` | `bstr(16)` |
| 3 | `coseSignature` | `bstr` — `det-cbor(COSE_Signature)` |

`commit_notice`

| Key | Field | Type |
|---|---|---|
| 1 | `conversationId` | `bstr(16)` |
| 2 | `epoch` | `uint`, exactly 0 |
| 3 | `offset` | `uint` |
| 4 | `recordHash` | `bstr(32)` |

BEGIN and ACK carry no signature of their own. Their attribution is
the enclosing L1 `COSE_Sign1`, which is sufficient because grant
evidence is volatile and Ledger never reconstructs or evaluates it
(`control-plane.md` — Mechanical admission).

### 7.3 L3 action certificate

`ActionBinding` is the payload of the `moltzap-l3-action-v1`
`COSE_Sign`.

| Key | Field | Type | Rules |
|---|---|---|---|
| 1 | `protocol` | `tstr` | exact `v2/VERSION` value |
| 2 | `conversationId` | `bstr(16)` | |
| 3 | `epoch` | `uint` | exactly 0 in Gate 1 |
| 4 | `epochDescriptor` | `EpochDescriptor` | complete; carried in every action |
| 5 | `routerInstance` | `bstr(16)` | MUST equal key 4's `routerInstance` |
| 6 | `txnId` | `bstr(16)` | |
| 7 | `base` | `Base` union | `genesis` iff `kind` is `START` |
| 8 | `author` | `bstr(16)` | MUST be a member of key 4 |
| 9 | `kind` | `tstr` | exactly `START` or `MULTICAST` |
| 10 | `content` | array of `ContentPart` | nonempty |
| 11 | `contentDigest` | `bstr(32)` | derivation of section 4 over key 10 |
| 12 | `selection` | `Selection` | present iff `kind` is `MULTICAST`; absent otherwise |

`EpochDescriptor`

| Key | Field | Type | Rules |
|---|---|---|---|
| 1 | `epoch` | `uint` | exactly 0 |
| 2 | `members` | array of `MemberEntry` | at least 2, ordered by `agentId` bytewise ascending, no duplicate |
| 3 | `routerInstance` | `bstr(16)` | the instance in force when the conversation started |

`MemberEntry`

| Key | Field | Type |
|---|---|---|
| 1 | `agentId` | `bstr(16)` |
| 2 | `card` | `bstr` — complete AgentCard DER |

`Selection`

| Key | Field | Type |
|---|---|---|
| 1 | `actionId` | `tstr` matching section 2.5 |
| 2 | `replyFingerprint` | `bstr(32)` |

`Base` union

| Discriminant | Value | Used by |
|---|---|---|
| `genesis` | `{}` | START only |
| `record` | `{ 1: offset : uint, 2: recordHash : bstr(32) }` | MULTICAST only |

`ContentPart` union

| Discriminant | Value |
|---|---|
| `text` | `tstr` |
| `data` | `JsonValue` (section 3.4) |

`ContentPart` and the `LookupRequest.selector` union of section 7.5
are the two unions whose arm values are not maps. Raw
bytes, URLs, files, filenames, media types, metadata, images, and
audio have no arm and MUST be rejected
(`endpoints/tasks.md` — ContentPartV1).

The `EpochDescriptor` appears inside every `ActionBinding`, not only
in START, so a single record verifies offline with no other record
present. Ledger MUST require that a MULTICAST's `epochDescriptor` is
byte-identical to the descriptor committed by that conversation's
START, and that key 5 equals key 4's `routerInstance`. That equality
is the mechanical form of old-instance fencing
(`data-plane.md` — Router restart).

### 7.4 `TranscriptRecord`

| Key | Field | Type |
|---|---|---|
| 1 | `protocol` | `tstr` |
| 2 | `conversationId` | `bstr(16)` |
| 3 | `epoch` | `uint` |
| 4 | `offset` | `uint` |
| 5 | `previousHash` | `bstr(32)` |
| 6 | `recordHash` | `bstr(32)` |
| 7 | `certificate` | `bstr` — exact tagged `COSE_Sign` bytes |

Keys 2 and 3 duplicate `ActionBinding` keys 2 and 3 so a reader can
index and page without decoding COSE. A verifier MUST check that they
equal the corresponding binding fields and reject the record
otherwise.

Every other fact that `control-plane.md` lists as record content —
`RouterInstanceId`, the action binding, the author, the deterministic
content, the selected action and `ReplyFingerprint`, and the complete
member and card verification descriptor — is present inside key 7's
signed `ActionBinding`. The record contains them by containment, not
by an unsigned copy. There is deliberately no unsigned duplicate of a
signed fact that could disagree with it.

`previousHash` for `offset` 0 is the genesis derivation of section 4.
`recordHash` is the derivation of section 4 over keys 1 through 5 and
key 7.

### 7.5 Registry operation bodies

`RegisterRequest`

| Key | Field | Type |
|---|---|---|
| 1 | `operationId` | `bstr(16)` |
| 2 | `principalId` | `bstr(16)` |
| 3 | `agentName` | `tstr` matching section 2.4 |
| 4 | `spki` | `bstr(44)` per section 5.9 |

`RegisterResult` union

| Discriminant | Value |
|---|---|
| `registered` | `{ 1: card : bstr }` |
| `name_taken` | `{}` |
| `invalid_key` | `{}` |
| `idempotency_conflict` | `{}` |

`LookupRequest`

| Key | Field | Type |
|---|---|---|
| 1 | `selector` | `[ "agentId", bstr(16) ]` or `[ "agentName", tstr ]` |

`LookupResult` union

| Discriminant | Value |
|---|---|
| `found` | `{ 1: card : bstr }` |
| `not_found` | `{}` |

`ListRequest`

| Key | Field | Type |
|---|---|---|
| 1 | `cursor` | `bstr`, optional — a `ListCursor` per section 8.1 |

`ListResult` union

| Discriminant | Value |
|---|---|
| `page` | `{ 1: cards : array of bstr, 2: cursor : bstr optional }` |
| `cursor_invalid` | `{}` |

Enumeration order is `AgentId` bytewise ascending, and the next page
begins strictly after the cursor's recorded last `AgentId`. An absent
response cursor means the caller has reached the end. Page size is a
Registry deployment bound and is neither requested nor advertised
(`control-plane.md` — Common HTTP contract).

### 7.6 Router operation bodies

`SendRequest`

| Key | Field | Type |
|---|---|---|
| 1 | `expectedInstance` | `bstr(16)` |
| 2 | `mode` | `tstr`, exactly `initial` or `retry` |
| 3 | `message` | `bstr` — exact `SignedMessage` bytes |

`SendResult` union

| Discriminant | Value |
|---|---|
| `accepted` | `{ 1: routerInstance : bstr(16), 2: sequence : uint }` |
| `router_restarted` | `{ 1: routerInstance : bstr(16) }` |
| `idempotency_conflict` | `{}` |
| `retry_identity_unknown` | `{}` |

`router_restarted` carries the authenticated current instance so
recovery never has to parse a cursor or send a message to discover it
(`data-plane.md` — Poll).

`PollRequest`

| Key | Field | Type |
|---|---|---|
| 1 | `cursor` | `bstr`, optional; absence is the tail anchor |

`PollResult` union

| Discriminant | Value |
|---|---|
| `batch` | `{ 1: routerInstance : bstr(16), 2: deliveries : array of Delivery, 3: cursor : bstr }` |
| `feed_gap` | `{ 1: routerInstance : bstr(16) }` |
| `router_restarted` | `{ 1: routerInstance : bstr(16) }` |
| `cursor_invalid` | `{}` |

A `batch` may have an empty `deliveries` array; that is how an empty
tail anchor and a 25-second timeout both report the current instance
and the next cursor. `feed_gap` and `router_restarted` never carry a
partial batch and have no `deliveries` key at all.

### 7.7 Ledger operation bodies

`AppendRequest`

| Key | Field | Type |
|---|---|---|
| 1 | `certificate` | `bstr` — exact tagged `COSE_Sign` bytes |

`AppendResult` union

| Discriminant | Value |
|---|---|
| `committed` | `{ 1: conversationId : bstr(16), 2: epoch : uint, 3: txnId : bstr(16), 4: offset : uint, 5: recordHash : bstr(32) }` |
| `stale_base` | `{ 1: headOffset : uint, 2: headHash : bstr(32) }` |
| `idempotency_conflict` | `{}` |
| `not_author` | `{}` |
| `certificate_invalid` | `{ 1: reason : tstr }` |

`certificate_invalid.reason` is drawn from this closed set and nothing
else. It names the mechanical check that failed and never carries free
text, a decoder message, or a policy statement:

`encoding`, `profile`, `version`, `action_kind`, `binding`, `epoch`,
`router_instance`, `content_digest`, `signer_set`, `signature`,
`card`.

`ReadRequest`

| Key | Field | Type |
|---|---|---|
| 1 | `mode` | `[ "forward", { 1: conversationId : bstr(16), 2: afterOffset : uint optional } ]` or `[ "exact", { 1: conversationId : bstr(16), 2: epoch : uint, 3: txnId : bstr(16) } ]` |

An absent `afterOffset` reads from `offset` 0.

`ReadResult` union

| Discriminant | Value |
|---|---|
| `page` | `{ 1: records : array of TranscriptRecord, 2: nextOffset : uint optional }` |
| `transaction` | `{ 1: record : TranscriptRecord }` |
| `not_found` | `{}` |
| `unknown_conversation` | `{}` |

`page` answers `forward` mode; `transaction` and `not_found` answer
`exact` mode. An absent `nextOffset` means the page reached the
current committed head. A caller that is not a fixed epoch-0 member of
the named conversation receives `unknown_conversation`, identical to
the response for a conversation that does not exist, so a read cannot
probe for the existence of a conversation the caller does not belong
to.

`ConversationsListRequest`

| Key | Field | Type |
|---|---|---|
| 1 | `cursor` | `bstr`, optional — a `ConversationsCursor` per section 8.1 |

`ConversationsListResult` union

| Discriminant | Value |
|---|---|
| `page` | `{ 1: conversations : array of ConversationHead, 2: cursor : bstr optional }` |
| `cursor_invalid` | `{}` |

`ConversationHead`

| Key | Field | Type |
|---|---|---|
| 1 | `conversationId` | `bstr(16)` |
| 2 | `epoch` | `uint` |
| 3 | `headOffset` | `uint` |
| 4 | `headHash` | `bstr(32)` |
| 5 | `routerInstance` | `bstr(16)` — from the committed epoch descriptor |

Key 5 is what lets a daemon compare every reconciled epoch descriptor
against the instance a poll just returned and fence the mismatches
before opening protocol work (`endpoints/daemon.md` — SharedCore
network loop).

Enumeration order is `conversationId` bytewise ascending, and the next
page begins strictly after the cursor's recorded last
`conversationId`. Results are always scoped to the authenticated
member.

Reconciliation has no message kind of its own. It is exactly these two
Ledger routes: `conversations:list` to learn every committed head, then
`actions:read` in `forward` mode per conversation
(`control-plane.md` — Commit notification and recovery). A
`commit_notice` (section 7.2) is a wake-up hint, never a reconciliation
input.

## 8. Cursors

### 8.1 The common cursor construction

Every continuation cursor is opaque to its holder and
integrity-protected by the service that issued it. All three use one
construction:

```
Cursor = det-cbor([ plain : bstr, tag : bstr(16) ])
```

`plain` is `det-cbor` of that cursor's plain map. `tag` is the first
16 bytes of

```
HMAC-SHA-256( K_process, det-cbor([ domain, plain ]) )
```

where `domain` is the cursor's literal domain constant from section 4.

`K_process` is 32 bytes drawn from a cryptographically secure random
source at process start. It is never persisted and never transmitted.
A cursor minted before a service restart therefore fails its tag check
after the restart, and the holder restarts pagination. That is
acceptable for all three cursors, and section 8.3 states why it does
not weaken Router restart reporting.

Version 1 is the only defined version of any cursor. A later version
changes key 1 and takes a wire-catalog revision; it never changes the
meaning of version 1.

Every cursor binds the authenticated caller, so one agent's cursor is
never usable by another.

### 8.2 The three cursor plain maps

`PollCursorPlain`, domain `moltzap-poll-cursor-v1`:

| Key | Field | Type |
|---|---|---|
| 1 | `version` | `uint`, exactly 1 |
| 2 | `routerInstance` | `bstr(16)` |
| 3 | `agentId` | `bstr(16)` — the authenticated recipient |
| 4 | `nextSequence` | `uint` — the next feed sequence to return |

`ListCursorPlain`, domain `moltzap-list-cursor-v1`, issued by the
Registry for `identities:list`:

| Key | Field | Type |
|---|---|---|
| 1 | `version` | `uint`, exactly 1 |
| 2 | `agentId` | `bstr(16)` — the authenticated caller |
| 3 | `lastAgentId` | `bstr(16)` — the last card on the previous page |

`ConversationsCursorPlain`, domain
`moltzap-conversations-cursor-v1`, issued by the Ledger for
`conversations:list`:

| Key | Field | Type |
|---|---|---|
| 1 | `version` | `uint`, exactly 1 |
| 2 | `agentId` | `bstr(16)` — the authenticated member |
| 3 | `lastConversationId` | `bstr(16)` — the last entry on the previous page |

Enumeration resumes strictly after the recorded last value, in the
ascending order that section 7.5 and section 7.7 fix.

### 8.3 Rejection rules

A Router evaluates a presented `PollCursor` in this exact order and
returns the first matching outcome:

| Order | Condition | Result |
|---|---|---|
| 1 | not deterministic CBOR, wrong shape, or key 1 not exactly 1 | `cursor_invalid` |
| 2 | key 2 does not equal the current `RouterInstanceId` | `router_restarted` with the current instance |
| 3 | recomputed tag does not equal the presented tag, compared in constant time | `cursor_invalid` |
| 4 | key 3 does not equal the authenticated caller `AgentId` | `cursor_invalid` |
| 5 | key 4 is greater than the current global tail plus 1 | `cursor_invalid` |
| 6 | key 4 is older than the caller's retained feed window | `feed_gap` with the current instance |
| 7 | otherwise | `batch` |

Ordering matters, and step 2 comes before the integrity check on
purpose. `data-plane.md` — Router restart requires that a cursor from
a different instance return `router_restarted`, and a cursor minted by
a previous instance cannot pass a tag check whose key died with that
instance. Reading key 2 before verifying the tag is what makes that
required outcome reachable. It reveals nothing: the poll is already
authenticated for one `AgentId`, and every successful poll — including
an empty omitted-cursor anchor — returns the current instance to that
same caller anyway (`data-plane.md` — Poll).

A Registry `ListCursor` and a Ledger `ConversationsCursor` are
evaluated in this order:

| Order | Condition | Result |
|---|---|---|
| 1 | not deterministic CBOR, wrong shape, or key 1 not exactly 1 | `cursor_invalid` |
| 2 | recomputed tag does not equal the presented tag, compared in constant time | `cursor_invalid` |
| 3 | key 2 does not equal the authenticated caller `AgentId` | `cursor_invalid` |
| 4 | otherwise | `page` |

Neither carries an instance, so neither has a `router_restarted` arm.

A `PollCursor` never appears where a `LedgerOffset` is expected. The
types differ in shape, so an implementation that passes one for the
other fails decoding rather than silently reading the wrong feed. The
three cursor kinds are likewise not interchangeable: each binds a
different domain constant, so presenting one where another is expected
fails at step 2 or 3.

## 9. HTTP binding

### 9.1 Media types and framing

| Context | Value |
|---|---|
| Domain POST request `Content-Type` | `application/vnd.moltzap+cbor` |
| Domain POST response `Content-Type` | `application/vnd.moltzap+cbor` |
| Domain POST `Accept` | `application/vnd.moltzap+cbor` |
| `GET /healthz` | no request or response body, no `Content-Type` |

No parameters, including `charset`, are permitted on the media type. A
request with any other `Content-Type` is rejected with 415.

A MoltZap-owned media type rather than `application/cbor` matters
because `content-type` is an RFC 9421 covered component: a signature
made for a MoltZap operation cannot be replayed against a service that
expects generic CBOR, and the reverse.

Every domain body is exactly one deterministic CBOR item. Chunked
transfer coding is permitted at the HTTP layer; content coding
(`Content-Encoding`) is not, in either direction, because it would put
bytes between the digest and the body.

### 9.2 Routes

| Service | Method and path | Body | Result union |
|---|---|---|---|
| Registry | `POST /v1/identities:register` | `RegisterRequest` | `RegisterResult` |
| Registry | `POST /v1/identities:lookup` | `LookupRequest` | `LookupResult` |
| Registry | `POST /v1/identities:list` | `ListRequest` | `ListResult` |
| Registry | `GET /healthz` | none | none |
| Router | `POST /v1/messages:send` | `SendRequest` | `SendResult` |
| Router | `POST /v1/deliveries:poll` | `PollRequest` | `PollResult` |
| Router | `GET /healthz` | none | none |
| Ledger | `POST /v1/actions:append` | `AppendRequest` | `AppendResult` |
| Ledger | `POST /v1/actions:read` | `ReadRequest` | `ReadResult` |
| Ledger | `POST /v1/conversations:list` | `ConversationsListRequest` | `ConversationsListResult` |
| Ledger | `GET /healthz` | none | none |

Paths are exact and case-sensitive. No trailing slash is accepted. No
query string is accepted on any route; the RFC 9421 `@query` component
therefore always covers the empty query.

### 9.3 Status mapping

One rule governs the split: **the HTTP status describes the request
envelope; the CBOR discriminant describes the domain outcome.**

Every authenticated, well-formed, version-matched domain POST returns
`200` and a closed tagged result — including a domain refusal such as
`feed_gap`, `idempotency_conflict`, `retry_identity_unknown`,
`stale_base`, `name_taken`, or `certificate_invalid`. Those are
outcomes of a valid request, not envelope failures.

| Condition | Status | Error tag |
|---|---|---|
| domain result, success or refusal arm | 200 | — |
| unknown path | 404 | `not_found` |
| wrong method on a known path | 405 | `method_not_allowed` |
| `Content-Type` or `Accept` not the MoltZap media type | 415 | `unsupported_media_type` |
| body larger than the configured decode bound | 413 | `payload_too_large` |
| body is not deterministic CBOR, or violates a closed schema at any depth | 400 | `malformed` |
| `moltzap-protocol` absent, malformed, or unequal | 412 | `protocol_version_mismatch` |
| `Signature`, `Signature-Input`, or `Content-Digest` absent or unparsable | 401 | `unauthenticated` |
| `Content-Digest` does not match the body | 401 | `digest_mismatch` |
| signature does not verify, or covered components or `tag` are wrong | 401 | `signature_invalid` |
| `created`/`expires` outside the permitted window | 401 | `signature_expired` |
| `(keyid, nonce)` already seen inside the validity horizon | 401 | `nonce_replayed` |
| registration admission code absent or wrong | 403 | `admission_denied` |
| configured concurrency bound exceeded | 429 | `overloaded` |
| a required dependency is unavailable | 503 | `unavailable` |
| any other failure | 500 | `internal` |

`GET /healthz` returns `200` when ready and `503` when not, with an
empty body in both cases and no domain data of any kind
(`control-plane.md` — Common HTTP contract).

A non-200 response to a domain POST is `det-cbor` of a closed
`TransportError` union with the tag from the table above and the
value `{}`, carried with the MoltZap media type. `GET /healthz` is not
a domain POST and carries no body in either outcome. `TransportError`
values never carry a reason string, a stack, a decoder path, or a
retry hint. The envelope taxonomy above is closed; no other tag
exists.

Order of checks on an inbound domain POST is fixed, so a negative
vector has exactly one expected outcome:

1. path and method;
2. media type;
3. decode bound;
4. `moltzap-protocol`;
5. RFC 9421 authentication, including digest and replay;
6. registration admission code, on the register route only;
7. CBOR decode against the closed request schema;
8. domain processing.

Version is checked before authentication so a version mismatch is
reported before state change and before any nonce is retained.

### 9.4 RFC 9421 — common rules

Exactly one signature is present on every domain POST. Its label is
`moltzap` and no other label is accepted; a request carrying a second
signature, or a signature under any other label, is rejected with
`signature_invalid`.

Covered components appear in this exact order, as one Inner List on
one field line:

1. `@method`
2. `@authority`
3. `@path`
4. `@query`
5. `content-digest`
6. `content-type`
7. `moltzap-protocol`

Signature parameters follow that Inner List in this exact order:

1. `created`, an integer
2. `expires`, an integer
3. `keyid`, a string
4. `nonce`, a string
5. `alg`, the string `ed25519`
6. `tag`, a string

- `alg` is always `ed25519` and always present.
- `nonce` is 16 bytes from a cryptographically secure random source,
  encoded as 22 unpadded base64url characters under the same trailing
  rules as section 2.2.
- `created` and `expires` are integer seconds since the UNIX epoch.
  A server rejects unless `created <= now + 5` and `now <= expires`
  and `expires - created <= 300`. The 5-second allowance is the only
  clock-skew tolerance in the protocol.
- `Content-Digest` uses RFC 9530 with exactly one entry,
  `sha-256=:<base64>:`. No other algorithm is accepted.
- Replay rejection is keyed on `(keyid, nonce)` for the validity
  horizon, with the retention behavior each service owns
  (`identity.md` — Normal profile).
- `@query` covers the empty query on every route (section 9.2).

A fixed parameter order is required so two independent encoders
produce byte-equal `Signature-Input` field values for the vector
corpus. A verifier still derives the signature base from the received
field value, as RFC 9421 requires.

### 9.5 RFC 9421 — normal profile

Used by every domain POST except registration.

| Element | Value |
|---|---|
| `keyid` | `moltzap://agent/<AgentId text>` |
| `tag` | `moltzap-control-v1` for Registry and Ledger; `moltzap-data-v1` for Router send and poll |
| Key | the caller's AgentCard Ed25519 key |
| Card carriage | the caller's complete AgentCard DER in the `MoltZap-Card` header, base64url unpadded |

`MoltZap-Card` is the header that realizes "the request embeds the
caller AgentCard" (`identity.md` — Normal profile). It is not a
covered component: the card is bound by `keyid`, which names the
`AgentId` the card's SAN asserts, and the server verifies the card
under the pinned Registry anchor before using its key. A request whose
`MoltZap-Card` does not verify, or whose agent SAN does not equal
`keyid`, is rejected with `signature_invalid`.

### 9.6 RFC 9421 — bootstrap profile

Used only by `POST /v1/identities:register`, the sole pre-card
exception.

| Element | Value |
|---|---|
| `keyid` | `moltzap://spki/<SpkiThumbprint text>` |
| `tag` | `moltzap-control-v1` |
| Key | the submitted Ed25519 key, proving possession |
| Card carriage | none; `MoltZap-Card` MUST be absent |
| Admission code | `Authorization: MoltZap-Admission <token68>` |

Covered components are the seven of section 9.4 in that same order,
plus `authorization` appended as the eighth and last. Signature
parameters and their order are unchanged.

The two profiles share the `moltzap-control-v1` tag because
registration is a control operation (`identity.md` — Normal profile).
They cannot be confused, because the covered-component sets differ and
the `keyid` URI shapes are disjoint: a bootstrap signature omits
`authorization` from a normal base and a normal signature includes a
`keyid` that no pre-card caller can present.

The admission code and the `Authorization` field MUST be redacted from
every log line, diagnostic, error body, and trace
(`cli.md` — Output and errors). The code itself matches RFC 9110
`token68` and is 8 to 512 characters.

## 10. Operation-equality preimages

Retry equality is over canonical operation bytes. Every preimage below
**excludes** `created`, `expires`, `nonce`, `keyid`, `alg`, `tag`,
`Signature`, `Signature-Input`, and `Content-Digest`, so a legitimate
retry that mints fresh RFC 9421 metadata still compares equal
(`layer-interfaces.md` — Retry identity).

| Route or tool | Retry identity key | Equality preimage | Scope |
|---|---|---|---|
| `identities:register` | `(SpkiThumbprint, OperationId)` | `H("moltzap-op-register-v1", operationId, principalId, agentName, spki)` | durable, Registry |
| `messages:send` | `(sender AgentId, MessageId)` | `H("moltzap-op-send-v1", signedMessageBytes)` | current Router instance, bounded cache |
| `actions:append` | `(ConversationId, epoch, TxnId)` | `H("moltzap-op-append-v1", certificateBytes)` | durable, Ledger |
| MCP `reply` | `TxnId` | `ReplyFingerprint` (section 4) | durable, daemon receipt or reconciled record |
| MCP `start_conversation` | `(caller AgentId, OperationId)` | `H("moltzap-op-start-v1", operationId, memberAgentIds, content)` | derived `ConversationId` and `TxnId` |

Rules that bind every row:

- a service stores the 32-byte digest, not the original bytes, as the
  equality witness;
- identical digest under the same key returns the original outcome;
- a different digest under the same key is `idempotency_conflict`;
- a key absent from the owning service's retention scope returns that
  service's documented outcome —
  `retry_identity_unknown` for Router send
  (`data-plane.md` — Send), and a normal fresh operation elsewhere;
- `memberAgentIds` in the start preimage is the canonicalized full
  roster including the caller, ordered bytewise ascending, so a
  reordered or self-including member list is the same operation and a
  changed roster is a conflict.

`start_conversation` needs no stored digest at the daemon: the
committed START's `EpochDescriptor` and `content` recompute the
preimage, which is why a START retry needs no local receipt
(`endpoints/daemon.md` — start_conversation).

## 11. MCP schemas

Every schema below is JSON Schema 2020-12 with
`"additionalProperties": false` at every object level and every
property required unless marked optional. The daemon rejects a value
that fails its schema.

Every published schema — each tool `inputSchema` and `outputSchema`,
each descriptor `payloadSchema`, and each notification schema — is
self-contained. A `$ref` never crosses a document boundary and no
`$id` is published.

The schema documents printed below elide `$defs` for readability. The
document a client actually receives carries a `$defs` object holding
exactly the transitive closure of the definitions its `$ref`s name,
appended as the document's last member, with its own members ordered
alphabetically by name. Every other member keeps the order printed
here. That rule is what makes the section 12.2 vectors both
byte-reproducible and resolvable.

The reusable definitions are:

| `$defs` name | Schema |
|---|---|
| `agentId` | `{"type":"string","pattern":"^agt_[A-Za-z0-9_-]{21}[AQgw]$"}` |
| `conversationId` | `{"type":"string","pattern":"^cnv_[A-Za-z0-9_-]{21}[AQgw]$"}` |
| `txnId` | `{"type":"string","pattern":"^txn_[A-Za-z0-9_-]{21}[AQgw]$"}` |
| `operationId` | `{"type":"string","pattern":"^opn_[A-Za-z0-9_-]{21}[AQgw]$"}` |
| `recordHash` | `{"type":"string","pattern":"^rec_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$"}` |
| `agentName` | `{"type":"string","minLength":3,"maxLength":32,"pattern":"^[a-z0-9]+(-[a-z0-9]+)*$"}` |
| `ledgerOffset` | `{"type":"integer","minimum":0}` |
| `actionId` | `{"type":"string","pattern":"^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$"}` |
| `timestamp` | `{"type":"string","pattern":"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$"}` |
| `contentPart` | `{"oneOf":[{"type":"object","additionalProperties":false,"required":["text"],"properties":{"text":{"type":"string"}}},{"type":"object","additionalProperties":false,"required":["data"],"properties":{"data":true}}]}` |
| `content` | `{"type":"array","minItems":1,"items":{"$ref":"#/$defs/contentPart"}}` |

Every timestamp is RFC 3339 UTC with exactly three fractional digits
and a literal `Z`. No other timestamp form appears on the MCP surface.

### 11.1 `server/discover` result

```json
{
  "resultType": "complete",
  "ttlMs": 0,
  "cacheScope": "private",
  "supportedVersions": ["2026-07-28"],
  "capabilities": {
    "tools": {},
    "extensions": {
      "xyz.moltzap/events-v1": { "agentId": "agt_…" }
    }
  },
  "_meta": {
    "io.modelcontextprotocol/serverInfo": {
      "name": "moltzap-agentd",
      "version": "<v2/VERSION>"
    }
  }
}
```

`supportedVersions` is exactly that one-element array.
`capabilities.extensions` has exactly the one MoltZap key.
`serverInfo` has exactly `name` and `version`; `name` is the constant
`moltzap-agentd` and `version` is the `v2/VERSION` value. `serverInfo`
never appears as a top-level discovery field
(`endpoints/daemon.md` — HTTP shape).

### 11.2 Client extension capability

Per request, at
`_meta["io.modelcontextprotocol/clientCapabilities"].extensions`:

```json
{ "xyz.moltzap/events-v1": {} }
```

The value object is closed and has no properties in Gate 1. A
`subscriptions/listen` without it fails with core error `-32021`
(`endpoints/daemon.md` — Turn-ready subscription).

### 11.3 `start_conversation`

`inputSchema`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["operationId", "members", "content"],
  "properties": {
    "operationId": { "$ref": "#/$defs/operationId" },
    "members": {
      "type": "array", "minItems": 1, "uniqueItems": true,
      "items": { "$ref": "#/$defs/agentName" }
    },
    "content": { "$ref": "#/$defs/content" }
  }
}
```

`members` names the other agents only. The caller is added implicitly;
an explicit self entry, an unknown name, or a duplicate is rejected
(`endpoints/daemon.md` — start_conversation). `uniqueItems` catches
the duplicate at the schema layer; the other two are SharedCore
checks.

`outputSchema`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["conversationId", "txnId", "ledgerOffset", "recordHash"],
  "properties": {
    "conversationId": { "$ref": "#/$defs/conversationId" },
    "txnId": { "$ref": "#/$defs/txnId" },
    "ledgerOffset": { "$ref": "#/$defs/ledgerOffset" },
    "recordHash": { "$ref": "#/$defs/recordHash" }
  }
}
```

### 11.4 `reply`

`inputSchema`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["txnId", "actionId", "payload"],
  "properties": {
    "txnId": { "$ref": "#/$defs/txnId" },
    "actionId": { "$ref": "#/$defs/actionId" },
    "payload": true
  }
}
```

`outputSchema` is byte-identical to `start_conversation`'s
`outputSchema`.

`payload` is unconstrained at the tool level and MUST validate against
the closed payload schema of the selected legal-action descriptor
before SharedCore consumes the grant. It cannot be closed statically
because the descriptor set is data in a turn notification, not a tool
registration (`endpoints/tasks.md` — Legal actions). A payload that
fails the descriptor's schema is `action_not_legal`.

### 11.5 Tool results

A successful `CallToolResult` has `resultType: "complete"`, a nonempty
`content` array whose first element is a text summary, and
`structuredContent` matching the tool's `outputSchema`.

A tool execution failure is a completed `CallToolResult` with
`isError: true`, a nonempty `content` explanation, and this closed
`structuredContent`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["code"],
  "properties": {
    "code": {
      "enum": ["txn_expired", "txn_consumed", "action_not_legal",
               "idempotency_conflict", "refused"]
    }
  }
}
```

There is no `message`, `cause`, `detail`, or `retryAfter` field.
`refused` carries no lower-layer taxonomy
(`endpoints/daemon.md` — Tool completion).

### 11.6 Subscription filter, acknowledgment, and close

`subscriptions/listen` params:

```json
{ "notifications": { "xyz.moltzap/turnReady": true } }
```

The `notifications` object is closed: exactly that key, exactly the
value `true`. Any other key, an absent key, or the value `false` is a
malformed MCP request.

The first stream message is exactly
`notifications/subscriptions/acknowledged`, echoing the accepted
filter:

```json
{
  "notifications": { "xyz.moltzap/turnReady": true },
  "_meta": { "io.modelcontextprotocol/subscriptionId": "<listen JSON-RPC id>" }
}
```

Every later `notifications/xyz.moltzap/turn_ready` carries the same
`_meta` subscriptionId.

A racing listener receives HTTP 409 with JSON-RPC error `-32000` and:

```json
{ "data": { "kind": "subscription_in_use" } }
```

`data` is closed to exactly `kind`, and `kind` to exactly that one
value.

Graceful server closure returns:

```json
{
  "resultType": "complete",
  "_meta": {
    "io.modelcontextprotocol/subscriptionId": "<listen JSON-RPC id>",
    "io.modelcontextprotocol/serverInfo": { "name": "moltzap-agentd", "version": "<v2/VERSION>" }
  }
}
```

SSE `id`, `event`, and `retry` fields are unused. An SSE comment line
is transport keepalive and carries no protocol meaning
(`endpoints/daemon.md` — Turn-ready subscription).

### 11.7 Legal-action descriptor and the Gate 1 action

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["actionId", "description", "payloadSchema"],
  "properties": {
    "actionId": { "$ref": "#/$defs/actionId" },
    "description": { "type": "string", "minLength": 1 },
    "payloadSchema": { "type": "object" }
  }
}
```

Gate 1 advertises exactly one descriptor:

| Field | Value |
|---|---|
| `actionId` | `openfloor.v1.speak` |
| `description` | `Contribute one message to this conversation.` |
| `payloadSchema` | `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,"required":["content"],"properties":{"content":{"$ref":"#/$defs/content"}}}` |

The payload's `content` maps directly onto `ActionBinding` key 10; the
daemon performs no rewriting between the JSON payload and the CBOR
content array beyond the `JsonValue` encoding of section 3.4.

### 11.8 Turn-ready notification

`notifications/xyz.moltzap/turn_ready` params:

```json
{
  "agentId": "agt_…",
  "conversationId": "cnv_…",
  "txnId": "txn_…",
  "expiresAt": "2026-07-29T05:00:00.000Z",
  "current": { "records": [ … ] },
  "crossConversation": [ { "conversationId": "cnv_…", "records": [ … ] } ],
  "legalActions": [ … ],
  "_meta": { "io.modelcontextprotocol/subscriptionId": "…" }
}
```

Every key is required; `records`, `crossConversation`, and
`legalActions` may be empty arrays. Determinism rules:

- `current.records` are ordered by `ledgerOffset` ascending;
- `crossConversation` groups are ordered by the raw 16-byte
  `ConversationId`, bytewise ascending — not by the base64url text,
  whose ordering differs;
- records inside a group are ordered by `ledgerOffset` ascending;
- the agent's own current conversation never appears as a
  cross-conversation group.

`expiresAt` is the grant's local-observation expiry, exactly 90
seconds after local observation (`endpoints/tasks.md` — TTL and no-reply behavior).

A record projection is:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["conversationId", "ledgerOffset", "recordHash", "author", "kind", "content"],
  "properties": {
    "conversationId": { "$ref": "#/$defs/conversationId" },
    "ledgerOffset": { "$ref": "#/$defs/ledgerOffset" },
    "recordHash": { "$ref": "#/$defs/recordHash" },
    "author": {
      "type": "object", "additionalProperties": false,
      "required": ["agentId", "agentName"],
      "properties": {
        "agentId": { "$ref": "#/$defs/agentId" },
        "agentName": { "$ref": "#/$defs/agentName" }
      }
    },
    "kind": { "enum": ["START", "MULTICAST"] },
    "content": { "$ref": "#/$defs/content" },
    "actionId": { "$ref": "#/$defs/actionId" }
  }
}
```

`actionId` is the only optional property and is present exactly when
`kind` is `MULTICAST`.

Cross-conversation material is full-content untrusted informational
context with no record-count or byte bound in Gate 1
(`endpoints/daemon.md` — Turn-ready notification).

## 12. Vector corpus

The corpus itself is a separate deliverable. This section fixes what
it must contain so its author chooses nothing.

### 12.1 Fixture material

Every vector is generated from exactly this material. No vector uses a
random value, a wall-clock read, or a locally chosen constant.

| Fixture | Value |
|---|---|
| Registry attestation seed | 32 bytes, each `0x00` |
| `alice` signing seed | 32 bytes, each `0x01` |
| `bob` signing seed | 32 bytes, each `0x02` |
| `carol` signing seed | 32 bytes, each `0x03` |
| `alice` `AgentId` | 16 bytes, each `0xA1` |
| `bob` `AgentId` | 16 bytes, each `0xB2` |
| `carol` `AgentId` | 16 bytes, each `0xC3` |
| `alice` `PrincipalId` | 16 bytes, each `0xD1` |
| `bob` `PrincipalId` | 16 bytes, each `0xD2` |
| `carol` `PrincipalId` | 16 bytes, each `0xD3` |
| `OperationId` | 16 bytes, each `0x11` |
| `MessageId` | 16 bytes, each `0x22` |
| `RouterInstanceId` | 16 bytes, each `0x33` |
| MULTICAST `TxnId` | 16 bytes, each `0x44` |
| `RouterSequence` of the fixture `begin` delivery | `7` |
| `nextSequence` of the fixture `PollCursor` | `8` |
| Router cursor `K_process` | 32 bytes, each `0x55` |
| Registry cursor `K_process` | 32 bytes, each `0x56` |
| Ledger cursor `K_process` | 32 bytes, each `0x57` |
| `AgentName`s | `alice`, `bob`, `carol` |
| Card `notBefore` | `2026-07-29T00:00:00Z` |
| RFC 9421 `created` | `1785283200` |
| RFC 9421 `expires` | `1785283500` |
| RFC 9421 `nonce` | 16 bytes, each `0x66` |
| Registry route | `https://registry.example` |
| Router route | `https://router.example` |
| Ledger route | `https://ledger.example` |
| Admission code | `moltzap-test-admission-code` |
| Initial content | `[["text","hello"]]` |
| Reply content | `[["text","world"],["data",{"n":1}]]` |

These seeds are test material and MUST NOT be accepted by any
production key loader.

Every `RouterSequence`-valued field in the corpus takes the fixture
sequence above: `Delivery` key 2, the `SendResult` `accepted` arm key
2, and `ack` key 4 are all `7`, and `PollCursorPlain` key 4 is `8`.
The two `TranscriptRecord` vectors sit at `LedgerOffset` `0` and `1`.

`ConversationId`, START `TxnId`, `ContentDigest`, `ReplyFingerprint`,
`RecordHash`, thumbprints, cursor integrity tags, and every signature
are derived from the material above by this chapter; the corpus does
not restate them as inputs.

### 12.2 Positive vectors

One positive vector exists for every structure this chapter assigns.
A vector records the input fixture selection, the expected bytes as
lowercase hex, and the section that governs it. At minimum:

1. `AgentCard` DER for `alice`, `bob`, and `carol`, plus each
   `AgentCardThumbprint`.
2. `SubjectPublicKeyInfo` DER and `SpkiThumbprint` for the submitted
   registration key.
3. `ServiceRoutes` CBOR and the complete `id-moltzap-routing`
   extension DER.
4. `UnsignedMessage` and the tagged `COSE_Sign1` for one message of
   every one of the seven L3 kinds, with the recipient set of section
   7.2.
5. `Delivery`.
6. `ActionBinding`, `EpochDescriptor`, `MemberEntry`, `Selection`,
   both `Base` arms, and both `ContentPart` arms, for one START and
   one MULTICAST.
7. The tagged `COSE_Sign` certificate for that START and that
   MULTICAST, with three signatures in canonical signer order.
8. `TranscriptRecord` at `offset` 0 and `offset` 1, with the genesis
   previous hash and the chained `recordHash`.
9. Every request body and every arm of every result union in sections
   7.5, 7.6, and 7.7 — including `feed_gap`, `router_restarted`,
   `cursor_invalid`, `retry_identity_unknown`, `idempotency_conflict`,
   `stale_base`, `not_author`, `name_taken`, `invalid_key`,
   `not_found`, and `unknown_conversation`, and one
   `certificate_invalid` per closed `reason`.
10. `PollCursor`, `ListCursor`, and `ConversationsCursor` bytes,
    each with its integrity tag.
11. `Sig_structure` bytes for both COSE profiles.
12. The RFC 9421 signature base string and the `Signature-Input` and
    `Signature` field values for one normal-profile request per route
    and for the bootstrap-profile registration request.
13. Every `TransportError` body in section 9.3.
14. Every derivation of section 4, as domain constant, preimage bytes,
    and digest.
15. Every canonical textual identifier of section 2.2 for the fixture
    values, and the two SAN URIs.
16. Every JSON document of section 11, serialized with the exact
    property order in which this chapter presents it and with `$defs`
    inlined under the rule at the head of section 11.

The positive corpus MUST be generated by two independent encoders and
MUST be byte-equal between them. "Independent" means the two encoders
do not share a CBOR, DER, COSE, or canonicalization implementation and
do not read each other's output. Both independent decoders MUST accept
every positive vector and reproduce the fixture values.

### 12.3 Negative vectors

Exactly one negative vector exists per rejection class, and every
class names the exact result the decoder or service MUST produce. The
classes are:

**CBOR determinism** — indefinite-length array; indefinite-length map;
indefinite-length byte string; indefinite-length text string;
non-preferred integer encoding; non-preferred length encoding;
out-of-order map keys; duplicate map key; unknown map key at the top
level; unknown map key nested inside `EpochDescriptor`; missing
required key; optional key present as `null`; an unassigned CBOR tag;
`undefined`; a simple value other than `true`, `false`, `null`;
binary16 float; binary32 float; NaN; `+Infinity`; negative zero;
invalid UTF-8; an unpaired surrogate; trailing bytes after the item.

**Unions** — unknown discriminant; array length 1; array length 3;
arm value of the wrong shape; `Base` `genesis` on a MULTICAST;
`Base` `record` on a START; `ContentPart` with a third arm.

**Identifiers** — 15-byte and 17-byte identifier; 31-byte and 33-byte
digest; textual identifier with an unknown prefix; textual identifier
with a non-canonical final character; textual identifier with padding;
an all-zero `AgentId` presented for card issuance.

**AgentName** — uppercase; underscore; leading hyphen; trailing
hyphen; double hyphen; 2 characters; 33 characters; a non-ASCII
confusable; leading whitespace.

**X.509** — BER indefinite length; non-minimal length octet;
non-minimal `INTEGER`; `BOOLEAN TRUE` encoded as `0x01`; non-zero
`BIT STRING` unused bits; trailing bytes after the certificate;
present Ed25519 `parameters`; `signatureAlgorithm` differing from
`tbsCertificate.signature`; a fifth extension; a missing extension;
extensions out of order; `subjectAltName` marked critical;
`id-moltzap-routing` marked non-critical; a third SAN name; SAN names
in the wrong order; `notAfter` other than `99991231235959Z`;
`notBefore` as `GeneralizedTime` before 2050; a route carrying a path;
a route with an explicit default port; a route whose scheme is not
`https`; a card signed by a key other than the pinned
attestation key; an issuer DN other than the constant.

**COSE** — untagged structure; tag 18 where 98 is expected and the
reverse; a `crit` label present; a `content type` label present; an
unknown protected label; a non-empty unprotected header; a missing
`alg`; a missing `kid`; an `alg` other than `-8`; a detached payload;
a `COSE_Sign` whose signatures are out of signer order; a duplicate
signer; a signature valid under the other profile's `external_aad`; a
signature valid under the other profile's `Sig_structure` context; a
signature with `S >= L`; a non-canonical `R`; a small-order public
key; one flipped bit in the sender, in the recipient set, in the
`MessageId`, in the body, and in `protocol`.

**Certificate admission** — a missing member signature; an extra
signature from a non-member; a signature from a member whose embedded
card does not match; an `epochDescriptor` differing from the committed
one; `routerInstance` differing from `epochDescriptor.routerInstance`;
a `contentDigest` that does not match `content`; an author outside
`members`; a `kind` other than `START` or `MULTICAST`; a `selection`
present on a START; a `selection` absent from a MULTICAST; a stale
base offset; a stale base hash.

**HTTP envelope** — an unknown path; `GET` on a POST route; a missing
`Content-Type`; `application/cbor`; a media type with a `charset`
parameter; a present `Content-Encoding`; a body over the decode bound;
a missing `moltzap-protocol`; a mismatched `moltzap-protocol`; a
missing `Signature`; a second signature; a signature label other than
`moltzap`; covered components in the wrong order; a missing covered
component; an `alg` other than `ed25519`; `expires - created` of 301;
`created` 6 seconds in the future; a replayed `(keyid, nonce)`; a
`Content-Digest` that does not match the body; a `Content-Digest`
algorithm other than `sha-256`; a wrong `tag` domain; a
`moltzap-data-v1` signature presented to Registry or Ledger; a
`moltzap-control-v1` signature presented to Router; a normal-profile
request with an absent `MoltZap-Card`; a `MoltZap-Card` whose agent
SAN does not equal `keyid`; a bootstrap-profile request carrying
`MoltZap-Card`; a bootstrap request omitting `authorization` from the
covered components; a missing admission code; a wrong admission code.

**Cursors** — a malformed `PollCursor`; version 2; a tampered
integrity tag; a cursor bound to another `AgentId`; a `PollCursor`
naming a previous `RouterInstanceId`, whose expected outcome is
`router_restarted` and not `cursor_invalid`; a `nextSequence` beyond
the tail; a `nextSequence` behind retention; a `ListCursor` presented
to `conversations:list` and the reverse, each failing on its domain
constant.

**MCP** — an unknown property in a tool input; a missing required
property; a `members` array containing a duplicate; an empty
`members`; an empty `content`; a `payload` that fails the descriptor
schema; a `subscriptions/listen` with an unknown notification key;
that filter set to `false`; a listen without the extension capability;
a second listen while one is active; a tool error
`structuredContent` carrying an extra property; a `code` outside the
closed enum.

Each negative vector records the exact expected outcome: the CBOR
result discriminant, the HTTP status and `TransportError` tag, the
`certificate_invalid.reason`, or the MCP error code from
`endpoints/daemon.md`. "Rejected" alone is not an expected outcome.

Both independent decoders MUST reject every negative vector with
exactly that outcome. A decoder that rejects for a different reason
fails the vector.

### 12.4 CI obligations

CI MUST fail when:

1. the positive corpus is empty, or any listed structure in section
   12.2 has no vector;
2. the two encoders disagree on any positive vector's bytes;
3. either decoder rejects a positive vector, or accepts a negative
   one, or produces an outcome other than the recorded one;
4. any rejection class in section 12.3 has no negative vector;
5. a wire constant appears in implementation source without appearing
   in this chapter — every map key, discriminant, domain constant,
   OID, prefix, media type, header name, status code, RFC 9421 `tag`,
   error tag, and MCP schema property;
6. a schema exists only in implementation source and not in this
   chapter.

Check 5 is the one that keeps the catalog authoritative rather than
descriptive. Without it the catalog silently becomes documentation of
whatever the code happened to do.

## 13. Change control

Any later wire change updates, in one atomic change:

1. this chapter;
2. a new accepted ADR;
3. the vector corpus, positive and negative;
4. the exact `v2/VERSION` value.

A map key is never reassigned or reused. A discriminant is never
redefined. A domain constant is never reused with different preimage
components; a changed derivation takes a new constant with a new
version suffix. An extension OID is never repurposed; a breaking
change to the MCP extension takes a new extension identifier
(`endpoints/daemon.md` — Discovery).

There is no extension bag, no reserved-for-future field, and no
unknown-field tolerance anywhere in this profile, so there is no
compatible way to add wire meaning without a version change
(`identity.md` — Attributed L1 message).

## Acceptance criteria

- Two independent implementations produce byte-equal encodings of the
  entire positive corpus, and both reject the entire negative corpus
  with the exact recorded outcome.
- No implementation source contains a wire constant absent from this
  chapter, and no MoltZap schema exists only in source.
- A signature made under one COSE profile fails under the other, for
  both the `Sig_structure` context and the `external_aad` reason
  independently.
- An AgentCard verifies from the pinned Registry attestation key
  alone, with no network access and no other certificate, and its
  strict-DER re-encoding equals the input bytes.
- A `TranscriptRecord` verifies completely offline from the pinned
  attestation key and the record itself.
- Every idempotent route recovers its original outcome from a retry
  whose RFC 9421 `created`, `expires`, `nonce`, and signature all
  differ, and conflicts when one operation byte differs.
- Recomputing every derivation in section 4 from its stated preimage
  reproduces the identifier, digest, or hash carried on the wire.
- A `PollCursor` naming a previous Router instance returns
  `router_restarted` with the current instance, while one from another
  agent or with a tampered tag is refused with `cursor_invalid` and
  reveals nothing about the feed window.
- Every result union arm and every `TransportError` tag has a test
  that observes it.
- `tools/list` returns exactly two tools and discovery reports exactly
  one supported MCP version and exactly one extension, whatever the
  legal-action descriptor set contains.

## Non-normative notes

Bytes and sizes, for orientation only. An `AgentCard` is roughly 320
to 400 DER bytes, dominated by the two SAN URIs and the routing
extension. An `EpochDescriptor` for three members therefore costs
roughly 1.1 kB, and it is repeated in every `ActionBinding`, so a
three-member MULTICAST certificate is roughly 1.5 kB before content.
That is a deliberate trade: `control-plane.md` permits later physical
compression precisely because the logical record is verbose, and it
requires that any such compression reconstruct these identical bytes.

The all-`0x01`-style fixture seeds in section 12.1 make a vector
diff readable at a glance: a wrong signer or a swapped identifier
shows up as an obviously wrong repeated byte rather than as
indistinguishable random hex.

## Decisions

- `../decisions/20260729-wire-profile-assigns-every-gate-1-byte.md`
- `../decisions/20260728-network-wire-is-http-post-polling.md`
- `../decisions/20260728-gate-1-identity-profile.md`
- `../decisions/20260728-transcript-is-mechanical-atomic-commit.md`
- `../decisions/20260728-open-floor-v1.md`
- `../decisions/20260728-endpoint-daemon-speaks-modern-mcp.md`
- `../decisions/20260728-model-surface-is-start-reply-listen.md`
- `../decisions/20260721-x509-card-container.md`
