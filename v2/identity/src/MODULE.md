# v2/identity/src

_`v2/identity/src`_

## Purpose

Public identity contracts: immutable agent cards, identifiers,
and the signing and request-authentication profiles every other v2
package builds on. `identity` sits at the root of the v2 dependency
graph and imports no other v2 package.

## Public surface

### [`AgentCardDigest`](./identity-values.ts#L107)

_TypeAlias_

```ts
export type AgentCardDigest = typeof AgentCardDigest.Type;
```

Validated nominal value decoded by AgentCardDigest.

### [`AgentCardDigest`](./identity-values.ts#L101)

_Variable_

```ts
export const AgentCardDigest = canonicalValue(
  "AgentCardDigest",
  "acd_",
  DIGEST_BYTE_LENGTH,
)
```

Digest binding a message to one complete immutable AgentCard.

### [`AgentId`](./identity-values.ts#L71)

_TypeAlias_

```ts
export type AgentId = typeof AgentId.Type;
```

Validated nominal value decoded by AgentId.

### [`AgentId`](./identity-values.ts#L65)

_Variable_

```ts
export const AgentId = canonicalValue(
  "AgentId",
  "agt_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Canonical network identity minted by the Registry.

### [`AgentName`](./identity-values.ts#L121)

_TypeAlias_

```ts
export type AgentName = typeof AgentName.Type;
```

Validated nominal value decoded by AgentName.

### [`AgentName`](./identity-values.ts#L110)

_Variable_

```ts
export const AgentName = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(32),
  Schema.pattern(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  Schema.brand("AgentName"),
  Schema.annotations({
    identifier: "AgentName",
    description: "Registry-wide immutable agent handle",
  }),
)
```

Immutable Registry-wide human-facing agent handle.

### [`AgentSigningAuthority`](./agent-signing-authority.ts#L11)

_Interface_

```ts
export interface AgentSigningAuthority {
  readonly [agentSigningAuthorityBrand]: "AgentSigningAuthority";
}
```

Opaque authority over one imported Ed25519 private key.

### [`AgentSigningAuthority`](./agent-signing-authority.ts#L98)

_Variable_

```ts
export const AgentSigningAuthority = Object.freeze({
  fromPkcs8,
  publicKey,
})
```

Loads and identifies one Ed25519 signing authority without exposing its
private key or a generic signing operation.

### [`Ed25519PublicKey`](./ed25519-public-key.ts#L119)

_TypeAlias_

```ts
export type Ed25519PublicKey = typeof Ed25519PublicKey.Type;
```

Validated immutable Ed25519 public JWK.

### [`Ed25519PublicKey`](./ed25519-public-key.ts#L88)

_Variable_

```ts
export const Ed25519PublicKey = Schema.transform(
  publicKeyRepresentation,
  publicKeyValueSchema,
  {
    strict: true,
    decode: (value) =>
      Object.freeze({
        crv: value.crv,
        kty: value.kty,
        x: value.x,
      }),
    encode: (value) => ({
      crv: value.crv,
      kty: value.kty,
      x: value.x,
    }),
  },
).pipe(
  Schema.brand("Ed25519PublicKey"),
  Schema.annotations({
    identifier: "Ed25519PublicKey",
    description: "Exact immutable Ed25519 public JWK",
    parseOptions: {
      exact: true,
      onExcessProperty: "error",
    },
  }),
)
```

Exact immutable Ed25519 public JWK.

### [`InvalidAgentPrivateKeyError`](./agent-signing-authority.ts#L16)

_Class_

```ts
export class InvalidAgentPrivateKeyError extends Data.TaggedError(
  "InvalidAgentPrivateKeyError",
) {}
```

The supplied private-key material cannot act as an Ed25519 signer.

### [`MessageId`](./identity-values.ts#L98)

_TypeAlias_

```ts
export type MessageId = typeof MessageId.Type;
```

Validated nominal value decoded by MessageId.

### [`MessageId`](./identity-values.ts#L92)

_Variable_

```ts
export const MessageId = canonicalValue(
  "MessageId",
  "msg_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Sender-scoped identity of one attributed message.

### [`MOLTZAP_VERSION`](./index.ts#L19)

_Variable_

```ts
export const MOLTZAP_VERSION = "2026.729.1"
```

The sole MoltZap compatibility value. Every MoltZap-owned network
schema and all six v2 package manifests carry exactly this value;
there is no range negotiation and no per-layer version. `v2/VERSION`
is its source of truth, and a boundary check fails the build when the
two drift.

The MCP revision, simulator definition ID, EventCatalog schema, and
RunLedger storage version are independent namespaces and never imply
compatibility with this value.

### [`OperationId`](./identity-values.ts#L89)

_TypeAlias_

```ts
export type OperationId = typeof OperationId.Type;
```

Validated nominal value decoded by OperationId.

### [`OperationId`](./identity-values.ts#L83)

_Variable_

```ts
export const OperationId = canonicalValue(
  "OperationId",
  "opn_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Idempotency identity for a registration operation.

### [`PrincipalId`](./identity-values.ts#L80)

_TypeAlias_

```ts
export type PrincipalId = typeof PrincipalId.Type;
```

Validated nominal value decoded by PrincipalId.

### [`PrincipalId`](./identity-values.ts#L74)

_Variable_

```ts
export const PrincipalId = canonicalValue(
  "PrincipalId",
  "prn_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Opaque identity of the principal represented by an agent.

## Files

- `agent-signing-authority.ts`
- `ed25519-public-key.ts`
- `identity-values.ts`
- `index.ts`
