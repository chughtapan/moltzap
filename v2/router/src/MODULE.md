# v2/router/src

_`v2/router/src`_

## Purpose

Public Router contracts: opaque SignedMessages addressed to
explicit AgentIds, send results, and bounded endpoint-wide
PollCursors. Router carries no ConversationId, membership,
transaction, persistence, replay, or recovery semantics; those
belong to endpoint protocol code.

## Public surface

### [`PollCursor`](./router/values.ts#L144)

_TypeAlias_

```ts
export type PollCursor = typeof PollCursor.Type;
```

Validated opaque Router poll continuation.

### [`PollCursor`](./router/values.ts#L132)

_Variable_

```ts
export const PollCursor = Schema.String.pipe(
  Schema.filter(hasCanonicalCursorShape, {
    identifier: "PollCursor",
    description: "Canonical opaque Router poll continuation",
  }),
  Schema.brand("PollCursor"),
  Schema.annotations({
    identifier: "PollCursor",
    description: "Canonical opaque Router poll continuation",
  }),
)
```

Opaque, authenticated continuation for one caller and Router instance.

### [`Router`](./router.ts#L17)

_Class_

```ts
export class Router extends Context.Tag("@moltzap/v2-router/Router")<
  Router,
  RouterClientService
>() {
  static readonly send: (input: {
    readonly request: RouterSendRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterSendResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.send);

  static readonly poll: (input: {
    readonly request: RouterPollRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterPollResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.poll);

  static readonly layer = (input: {
    readonly origin: URL;
    readonly sendTimeout: Duration.Duration;
    readonly pollTimeout: Duration.Duration;
  }): Layer.Layer<Router, never, HttpClient.HttpClient> =>
    Layer.effect(Router, makeRouterClient(input));
}
```

Opaque message acceptance and endpoint-wide bounded polling.

### [`RouterConnectionError`](./router/errors.ts#L4)

_Class_

```ts
export class RouterConnectionError extends Data.TaggedError(
  "RouterConnectionError",
) {}
```

The Router connection could not be established or used.

### [`RouterInstanceId`](./router/values.ts#L120)

_TypeAlias_

```ts
export type RouterInstanceId = typeof RouterInstanceId.Type;
```

Validated Router process identity.

### [`RouterInstanceId`](./router/values.ts#L114)

_Variable_

```ts
export const RouterInstanceId = canonicalValue(
  "RouterInstanceId",
  "rti_",
  INSTANCE_BYTE_LENGTH,
)
```

Identifies one volatile Router process instance.

### [`RouterInvalidResponseError`](./router/errors.ts#L14)

_Class_

```ts
export class RouterInvalidResponseError extends Data.TaggedError(
  "RouterInvalidResponseError",
) {}
```

A Router response did not match the selected operation contract.

### [`RouterPollRequest`](./router/operations.ts#L242)

_Interface_

```ts
export interface RouterPollRequest {
  readonly pollCursor?: PollCursor;
}
```

One authenticated endpoint-wide poll request.

### [`RouterPollRequest`](./router/operations.ts#L251)

_Variable_

```ts
export const RouterPollRequest: Schema.Schema<
  RouterPollRequest,
  RouterPollRequestEncoded
> = closedStruct({
  pollCursor: Schema.optional(PollCursor),
}).annotations({ identifier: "RouterPollRequest" })
```

Exact Schema for one endpoint-wide poll request.

### [`RouterPollResult`](./router/operations.ts#L273)

_TypeAlias_

```ts
export type RouterPollResult =
  | Readonly<{
      kind: "batch";
      routerInstanceId: RouterInstanceId;
      signedMessages: readonly SignedMessageValue[];
      pollCursor: PollCursor;
    }>
```

Closed outcome of one endpoint-wide bounded poll.

### [`RouterPollResult`](./router/operations.ts#L300)

_Variable_

```ts
export const RouterPollResult: Schema.Schema<
  RouterPollResult,
  RouterPollResultEncoded
> = Schema.Union(batch, feedGap, cursorInvalid).annotations({
  identifier: "RouterPollResult",
})
```

Exact Schema for every closed poll outcome.

### [`RouterRequestTimeoutError`](./router/errors.ts#L9)

_Class_

```ts
export class RouterRequestTimeoutError extends Data.TaggedError(
  "RouterRequestTimeoutError",
) {}
```

The configured complete Router call deadline expired.

### [`RouterSendRequest`](./router/operations.ts#L145)

_Interface_

```ts
export interface RouterSendRequest {
  readonly expectedRouterInstanceId: RouterInstanceId;
  readonly mode: "initial" | "retry";
  readonly signedMessage: SignedMessageValue;
}
```

One authenticated request to accept or recover an opaque message.

### [`RouterSendRequest`](./router/operations.ts#L172)

_Variable_

```ts
export const RouterSendRequest: Schema.Schema<
  RouterSendRequest,
  RouterSendRequestEncoded
> = closedStruct({
  expectedRouterInstanceId: RouterInstanceId,
  mode: Schema.Literal("initial", "retry"),
  signedMessage: SignedMessage,
}).annotations({ identifier: "RouterSendRequest" })
```

Exact Schema for one send request.

### [`RouterSendResult`](./router/operations.ts#L201)

_TypeAlias_

```ts
export type RouterSendResult =
  | Readonly<{
      kind: "accepted";
      routerInstanceId: RouterInstanceId;
      signedMessageDigest: SignedMessageDigest;
    }>
```

Closed outcome of accepting or recovering an opaque message.

### [`RouterSendResult`](./router/operations.ts#L230)

_Variable_

```ts
export const RouterSendResult: Schema.Schema<
  RouterSendResult,
  RouterSendResultEncoded
> = Schema.Union(
  accepted,
  routerRestarted,
  messageInvalid,
  idempotencyConflict,
  retryIdentityUnknown,
).annotations({ identifier: "RouterSendResult" })
```

Exact Schema for every closed send outcome.

### [`SignedMessageDigest`](./router/values.ts#L129)

_TypeAlias_

```ts
export type SignedMessageDigest = typeof SignedMessageDigest.Type;
```

Validated SignedMessage equality receipt.

### [`SignedMessageDigest`](./router/values.ts#L123)

_Variable_

```ts
export const SignedMessageDigest = canonicalValue(
  "SignedMessageDigest",
  "smd_",
  DIGEST_BYTE_LENGTH,
)
```

Equality receipt for one complete retained SignedMessage.

## Files

- `index.ts`
- `router.ts`
- `errors.ts`
- `operations.ts`
- `values.ts`
