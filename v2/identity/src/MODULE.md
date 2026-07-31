# v2/identity/src

_`v2/identity/src`_

## Purpose

Public identity contracts: immutable agent cards, identifiers,
and the signing and request-authentication profiles every other v2
package builds on. `identity` sits at the root of the v2 dependency
graph and imports no other v2 package.

## Public surface

### [`AgentCard`](./agent-card.ts#L104)

_Interface_

```ts
export interface AgentCard {
  readonly agentId: AgentIdValue;
  readonly principalId: PrincipalIdValue;
  readonly agentName: AgentNameValue;
  readonly publicKey: Ed25519PublicKeyValue;
  readonly issuedAt: string;
}
```

Immutable public identity fields carried by an AgentCard.

### [`AgentCard`](./agent-card.ts#L399)

_Variable_

```ts
export const AgentCard = Object.assign(agentCardSchema, {
  verify: verifyAgentCard,
}) as unknown as Schema.Schema<AgentCard, unknown> &
  Readonly<{
    readonly verify: typeof verifyAgentCard;
  }>
```

Verifies immutable Registry attestation without exposing JOSE mechanics.

### [`AgentCardDigest`](./identity-values.ts#L117)

_TypeAlias_

```ts
export type AgentCardDigest = typeof AgentCardDigest.Type;
```

Validated nominal value decoded by AgentCardDigest.

### [`AgentCardDigest`](./identity-values.ts#L111)

_Variable_

```ts
export const AgentCardDigest = canonicalValue(
  "AgentCardDigest",
  "acd_",
  DIGEST_BYTE_LENGTH,
)
```

Digest binding a message to one complete immutable AgentCard.

### [`AgentCardVerificationError`](./agent-card.ts#L243)

_Class_

```ts
export class AgentCardVerificationError extends Data.TaggedError(
  "AgentCardVerificationError",
) {}
```

A parsed AgentCard does not verify against the pinned Registry signer.

### [`AgentId`](./identity-values.ts#L81)

_TypeAlias_

```ts
export type AgentId = typeof AgentId.Type;
```

Validated nominal value decoded by AgentId.

### [`AgentId`](./identity-values.ts#L75)

_Variable_

```ts
export const AgentId = canonicalValue(
  "AgentId",
  "agt_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Canonical network identity minted by the Registry.

### [`AgentName`](./identity-values.ts#L131)

_TypeAlias_

```ts
export type AgentName = typeof AgentName.Type;
```

Validated nominal value decoded by AgentName.

### [`AgentName`](./identity-values.ts#L120)

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

### [`AgentSigningError`](./signing-errors.ts#L4)

_Class_

```ts
export class AgentSigningError extends Data.TaggedError("AgentSigningError") {}
```

A registered-agent or bootstrap HTTP request could not be signed.

### [`AuthenticatedHttp`](./authenticated-http.ts#L437)

_Class_

```ts
export class AuthenticatedHttp extends Context.Tag(
  "@moltzap/v2-identity/AuthenticatedHttp",
)<AuthenticatedHttp, AuthenticatedHttpService>() {
  static readonly signAgentRequest = signAgentRequest;

  static readonly verifyAgentRequest: (input: {
    readonly httpRequest: HttpServerRequest.HttpServerRequest;
    readonly bodyBytes: Uint8Array;
  }) => Effect.Effect<
    VerifiedAgentRequest,
    AuthenticationError,
    AuthenticatedHttp
  > = Effect.serviceFunctionEffect(
    AuthenticatedHttp,
    (service) => service.verifyAgentRequest,
  );

  static readonly layer = (input: {
    readonly liveNonceCapacity: number;
    readonly agentCardCacheCapacity: number;
    readonly registryLookupConcurrencyLimit: number;
  }): Layer.Layer<AuthenticatedHttp, never, Registry> =>
    Layer.effect(AuthenticatedHttp, makeService({ ...input }));
}
```

Registered-agent request signing and verification.

### [`AuthenticationFailedError`](./http-errors.ts#L10)

_Class_

```ts
export class AuthenticationFailedError extends Schema.TaggedError<AuthenticationFailedError>()(
  "AuthenticationFailedError",
  {},
) {}
```

The request does not prove the required identity or admission authority.

### [`Ed25519PublicKey`](./ed25519-public-key.ts#L233)

_TypeAlias_

```ts
export type Ed25519PublicKey = typeof Ed25519PublicKey.Type;
```

Validated immutable Ed25519 public JWK.

### [`Ed25519PublicKey`](./ed25519-public-key.ts#L202)

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

### [`InternalServerError`](./http-errors.ts#L58)

_Class_

```ts
export class InternalServerError extends Schema.TaggedError<InternalServerError>()(
  "InternalServerError",
  {},
) {}
```

An unexpected implementation failure prevented a closed result.

### [`InvalidAgentPrivateKeyError`](./agent-signing-authority.ts#L16)

_Class_

```ts
export class InvalidAgentPrivateKeyError extends Data.TaggedError(
  "InvalidAgentPrivateKeyError",
) {}
```

The supplied private-key material cannot act as an Ed25519 signer.

### [`MalformedRequestError`](./http-errors.ts#L4)

_Class_

```ts
export class MalformedRequestError extends Schema.TaggedError<MalformedRequestError>()(
  "MalformedRequestError",
  {},
) {}
```

The request representation is not valid for the selected operation.

### [`MessageId`](./identity-values.ts#L108)

_TypeAlias_

```ts
export type MessageId = typeof MessageId.Type;
```

Validated nominal value decoded by MessageId.

### [`MessageId`](./identity-values.ts#L102)

_Variable_

```ts
export const MessageId = canonicalValue(
  "MessageId",
  "msg_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Sender-scoped identity of one attributed message.

### [`MethodNotAllowedError`](./http-errors.ts#L22)

_Class_

```ts
export class MethodNotAllowedError extends Schema.TaggedError<MethodNotAllowedError>()(
  "MethodNotAllowedError",
  {},
) {}
```

The selected route does not accept the request method.

### [`MOLTZAP_VERSION`](./version.ts#L2)

_Variable_

```ts
export const MOLTZAP_VERSION = "2026.729.1"
```

Sole compatibility value for MoltZap-owned network boundaries.

### [`OperationId`](./identity-values.ts#L99)

_TypeAlias_

```ts
export type OperationId = typeof OperationId.Type;
```

Validated nominal value decoded by OperationId.

### [`OperationId`](./identity-values.ts#L93)

_Variable_

```ts
export const OperationId = canonicalValue(
  "OperationId",
  "opn_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Idempotency identity for a registration operation.

### [`OverloadedError`](./http-errors.ts#L46)

_Class_

```ts
export class OverloadedError extends Schema.TaggedError<OverloadedError>()(
  "OverloadedError",
  {},
) {}
```

A finite immediate resource permit is unavailable.

### [`PayloadTooLargeError`](./http-errors.ts#L34)

_Class_

```ts
export class PayloadTooLargeError extends Schema.TaggedError<PayloadTooLargeError>()(
  "PayloadTooLargeError",
  {},
) {}
```

The received body exceeds the selected route's derived representation cap.

### [`PrincipalId`](./identity-values.ts#L90)

_TypeAlias_

```ts
export type PrincipalId = typeof PrincipalId.Type;
```

Validated nominal value decoded by PrincipalId.

### [`PrincipalId`](./identity-values.ts#L84)

_Variable_

```ts
export const PrincipalId = canonicalValue(
  "PrincipalId",
  "prn_",
  IDENTIFIER_BYTE_LENGTH,
)
```

Opaque identity of the principal represented by an agent.

### [`Registry`](./registry.ts#L20)

_Class_

```ts
export class Registry extends Context.Tag("@moltzap/v2-identity/Registry")<
  Registry,
  RegistryClientService
>() {
  static readonly register = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.register,
  );

  static readonly lookup = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.lookup,
  );

  static readonly list = Effect.serviceFunctionEffect(
    Registry,
    (service) => service.list,
  );

  static readonly layer = (input: {
    readonly origin: URL;
    readonly registrySignerPublicKey: Ed25519PublicKey;
    readonly requestTimeout: Duration.Duration;
  }): Layer.Layer<Registry, never, HttpClient.HttpClient> =>
    Layer.effect(Registry, makeRegistryService(input));
}
```

Bootstrap registration and immutable identity resolution.

### [`RegistryConnectionError`](./registry/client.ts#L53)

_Class_

```ts
export class RegistryConnectionError extends Data.TaggedError(
  "RegistryConnectionError",
) {}
```

The Registry connection could not be established or used.

### [`RegistryInvalidResponseError`](./registry/client.ts#L63)

_Class_

```ts
export class RegistryInvalidResponseError extends Data.TaggedError(
  "RegistryInvalidResponseError",
) {}
```

A Registry response did not match the selected operation contract.

### [`RegistryListRequest`](./registry/operations.ts#L72)

_TypeAlias_

```ts
export type RegistryListRequest = typeof RegistryListRequest.Type;
```

Validated Registry list continuation request.

### [`RegistryListRequest`](./registry/operations.ts#L67)

_Variable_

```ts
export const RegistryListRequest = exactStruct({
  afterAgentId: Schema.optional(AgentId),
}).annotations({ identifier: "RegistryListRequest" })
```

Closed Registry list continuation request.

### [`RegistryListResult`](./registry/operations.ts#L87)

_TypeAlias_

```ts
export type RegistryListResult = Readonly<{
  kind: "page";
  agentCards: readonly VerifiedAgentCard[];
  hasMore: boolean;
}>;
```

One deterministic page of complete immutable AgentCards.

### [`RegistryLookupRequest`](./registry/operations.ts#L63)

_TypeAlias_

```ts
export type RegistryLookupRequest = typeof RegistryLookupRequest.Type;
```

Validated Registry lookup selector.

### [`RegistryLookupRequest`](./registry/operations.ts#L51)

_Variable_

```ts
export const RegistryLookupRequest = Schema.Union(
  exactStruct({ agentId: AgentId }),
  exactStruct({ agentName: AgentName }),
).annotations({
  identifier: "RegistryLookupRequest",
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
})
```

Closed Registry lookup selector.

### [`RegistryLookupResult`](./registry/operations.ts#L82)

_TypeAlias_

```ts
export type RegistryLookupResult =
  | Readonly<{ kind: "found"; agentCard: VerifiedAgentCard }>
```

Closed domain outcome from one public identity lookup.

### [`RegistryRegisterRequest`](./registry/operations.ts#L47)

_TypeAlias_

```ts
export type RegistryRegisterRequest = typeof RegistryRegisterRequest.Type;
```

Validated Registry bootstrap registration request.

### [`RegistryRegisterRequest`](./registry/operations.ts#L39)

_Variable_

```ts
export const RegistryRegisterRequest = exactStruct({
  operationId: OperationId,
  principalId: PrincipalId,
  agentName: AgentName,
  publicKey: Ed25519PublicKey,
}).annotations({ identifier: "RegistryRegisterRequest" })
```

Closed Registry bootstrap registration request.

### [`RegistryRegisterResult`](./registry/operations.ts#L75)

_TypeAlias_

```ts
export type RegistryRegisterResult =
  | Readonly<{ kind: "registered"; agentCard: VerifiedAgentCard }>
```

Closed domain outcome from one bootstrap registration attempt.

### [`RegistryRequestTimeoutError`](./registry/client.ts#L58)

_Class_

```ts
export class RegistryRequestTimeoutError extends Data.TaggedError(
  "RegistryRequestTimeoutError",
) {}
```

The configured complete Registry call deadline expired.

### [`RouteNotFoundError`](./http-errors.ts#L16)

_Class_

```ts
export class RouteNotFoundError extends Schema.TaggedError<RouteNotFoundError>()(
  "RouteNotFoundError",
  {},
) {}
```

No exact HTTP route owns the request target.

### [`SignedMessage`](./signed-message.ts#L145)

_Interface_

```ts
export interface SignedMessage {
  readonly senderAgentId: AgentIdValue;
  readonly agentCardDigest: AgentCardDigestValue;
  readonly recipientAgentIds: readonly AgentIdValue[];
  readonly messageId: MessageIdValue;
  readonly body: Uint8Array;
}
```

Immutable attributed-message fields exposed to Router consumers.

### [`SignedMessage`](./signed-message.ts#L460)

_Variable_

```ts
export const SignedMessage = Object.assign(signedMessageSchema, {
  sign,
  verify,
  encodedByteLength,
  maximumEncodedByteLength: MAXIMUM_ENCODED_BYTES,
}) as unknown as Schema.Schema<SignedMessage, unknown> &
  Readonly<{
    readonly sign: typeof sign;
    readonly verify: typeof verify;
    readonly encodedByteLength: typeof encodedByteLength;
    readonly maximumEncodedByteLength: number;
  }>
```

Opaque attributed message operations and exact representation Schema.

### [`SignedMessageSigningError`](./signed-message.ts#L289)

_Class_

```ts
export class SignedMessageSigningError extends Data.TaggedError(
  "SignedMessageSigningError",
) {}
```

A message cannot be signed under the supplied immutable identity.

### [`SignedMessageVerificationError`](./signed-message.ts#L294)

_Class_

```ts
export class SignedMessageVerificationError extends Data.TaggedError(
  "SignedMessageVerificationError",
) {}
```

A SignedMessage does not bind to the supplied verified AgentCard.

### [`UnavailableError`](./http-errors.ts#L52)

_Class_

```ts
export class UnavailableError extends Schema.TaggedError<UnavailableError>()(
  "UnavailableError",
  {},
) {}
```

A required service or durable operation cannot currently complete.

### [`UnsupportedMediaTypeError`](./http-errors.ts#L40)

_Class_

```ts
export class UnsupportedMediaTypeError extends Schema.TaggedError<UnsupportedMediaTypeError>()(
  "UnsupportedMediaTypeError",
  {},
) {}
```

The selected route cannot consume the request content framing.

### [`VerifiedAgentCard`](./agent-card.ts#L228)

_TypeAlias_

```ts
export type VerifiedAgentCard = AgentCard & Brand.Brand<"VerifiedAgentCard">;
```

AgentCard verified against a deployment-pinned Registry signer.

### [`VerifiedAgentRequest`](./registered-agent-request.ts#L6)

_TypeAlias_

```ts
export type VerifiedAgentRequest = Readonly<{
  readonly callerAgentId: AgentId;
  readonly agentCard: VerifiedAgentCard;
  readonly request: unknown;
}> &
```

Request body and caller identity established by AuthenticatedHttp.

### [`VerifiedSignedMessage`](./signed-message.ts#L283)

_TypeAlias_

```ts
export type VerifiedSignedMessage = SignedMessage &
  Brand.Brand<"VerifiedSignedMessage">;
```

SignedMessage whose sender attribution and signature are verified.

### [`VersionMismatchError`](./http-errors.ts#L28)

_Class_

```ts
export class VersionMismatchError extends Schema.TaggedError<VersionMismatchError>()(
  "VersionMismatchError",
  {},
) {}
```

The request carries a different MoltZap compatibility value.

## Files

- `agent-card.ts`
- `agent-signing-authority.ts`
- `authenticated-http.ts`
- `ed25519-public-key.ts`
- `http-errors.ts`
- `identity-values.ts`
- `index.ts`
- `registered-agent-request.ts`
- `registry.ts`
- `client.ts`
- `operations.ts`
- `signed-message.ts`
- `signing-errors.ts`
- `version.ts`
