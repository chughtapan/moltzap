# router/src

_`packages/router/src`_

## Purpose

Public Router contracts: opaque SignedMessages addressed to
explicit AgentIds, send results, and bounded endpoint-wide
PollCursors. Router carries no ConversationId, membership,
transaction, persistence, replay, or recovery semantics; those
belong to the endpoint Harness in `@moltzap/client`.

## Public surface

### [`PollCursor (type)`](./router/contract.ts#L98)

_TypeAlias_

```ts
export type PollCursor = typeof PollCursor.Type;
```

Validated opaque Router poll continuation.

### [`PollCursor (value)`](./router/contract.ts#L86)

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

### [`Router`](./router.ts#L86)

_Class_

```ts
export class Router extends Context.Tag("@moltzap/router/Router")<
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

### [`RouterConnectionError`](./router/contract.ts#L274)

_Class_

```ts
export class RouterConnectionError extends Data.TaggedError(
  "RouterConnectionError",
) {}
```

The Router connection could not be established or used.

### [`RouterInstanceId (type)`](./router/contract.ts#L74)

_TypeAlias_

```ts
export type RouterInstanceId = typeof RouterInstanceId.Type;
```

Validated Router process identity.

### [`RouterInstanceId (value)`](./router/contract.ts#L68)

_Variable_

```ts
export const RouterInstanceId = canonicalValue(
  "RouterInstanceId",
  "rti_",
  INSTANCE_BYTE_LENGTH,
)
```

Identifies one volatile Router process instance.

### [`RouterInvalidResponseError`](./router/contract.ts#L284)

_Class_

```ts
export class RouterInvalidResponseError extends Data.TaggedError(
  "RouterInvalidResponseError",
) {}
```

A Router response did not match the selected operation contract.

### [`RouterPollRequest (type)`](./router/contract.ts#L206)

_Interface_

```ts
export interface RouterPollRequest {
  readonly pollCursor?: PollCursor;
}
```

One authenticated endpoint-wide poll request.

### [`RouterPollRequest (value)`](./router/contract.ts#L215)

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

### [`RouterPollResult (type)`](./router/contract.ts#L237)

_TypeAlias_

```ts
export type RouterPollResult =
  | Readonly<{
      kind: "batch";
      routerInstanceId: RouterInstanceId;
      signedMessages: readonly LiveSignedMessage[];
      pollCursor: PollCursor;
    }>
  | Readonly<{
      kind: "feed_gap";
      routerInstanceId: RouterInstanceId;
    }>
  | Readonly<{ kind: "cursor_invalid" }>;
```

Closed outcome of one endpoint-wide bounded poll.

### [`RouterPollResult (value)`](./router/contract.ts#L264)

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

### [`RouterRequestTimeoutError`](./router/contract.ts#L279)

_Class_

```ts
export class RouterRequestTimeoutError extends Data.TaggedError(
  "RouterRequestTimeoutError",
) {}
```

The configured complete Router call deadline expired.

### [`RouterSendRequest (type)`](./router/contract.ts#L101)

_Interface_

```ts
export interface RouterSendRequest {
  readonly expectedRouterInstanceId: RouterInstanceId;
  readonly mode: "initial" | "retry";
  readonly signedMessage: LiveSignedMessage;
}
```

One authenticated request to accept or recover an opaque message.

### [`RouterSendRequest (value)`](./router/contract.ts#L136)

_Variable_

```ts
export const RouterSendRequest: Schema.Schema<
  RouterSendRequest,
  RouterSendRequestEncoded
> = closedStruct({
  expectedRouterInstanceId: RouterInstanceId,
  mode: Schema.Literal("initial", "retry"),
  signedMessage: SignedMessage.live,
}).annotations({ identifier: "RouterSendRequest" })
```

Exact Schema for one send request.

### [`RouterSendResult (type)`](./router/contract.ts#L165)

_TypeAlias_

```ts
export type RouterSendResult =
  | Readonly<{
      kind: "accepted";
      routerInstanceId: RouterInstanceId;
      signedMessageDigest: SignedMessageDigest;
    }>
  | Readonly<{
      kind: "router_restarted";
      routerInstanceId: RouterInstanceId;
    }>
  | Readonly<{ kind: "message_invalid" }>
  | Readonly<{ kind: "idempotency_conflict" }>
  | Readonly<{ kind: "retry_identity_unknown" }>;
```

Closed outcome of accepting or recovering an opaque message.

### [`RouterSendResult (value)`](./router/contract.ts#L194)

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

### [`SignedMessageDigest (type)`](./router/contract.ts#L83)

_TypeAlias_

```ts
export type SignedMessageDigest = typeof SignedMessageDigest.Type;
```

Validated SignedMessage equality receipt.

### [`SignedMessageDigest (value)`](./router/contract.ts#L77)

_Variable_

```ts
export const SignedMessageDigest = canonicalValue(
  "SignedMessageDigest",
  "smd_",
  DIGEST_BYTE_LENGTH,
)
```

Equality receipt for one complete retained SignedMessage.

## Package subpaths

### `@moltzap/router/server`

#### [`RouterServer`](./server.ts#L33)

_Namespace_

#### [`RouterServer.StartupError`](./server.ts#L38)

_Class_

```ts
  export class StartupError extends Data.TaggedError(
    "RouterServerStartupError",
  )<{
    readonly phase: "configuration" | "listener";
    readonly detail?: string;
  }> {
    /** Rejected environment values never enter the operator message. */
    override get message(): string {
      const detail = this.detail === undefined ? "" : `: ${this.detail}`;
      return `moltzap-router startup failed in phase ${this.phase}${detail}`;
    }
  }
```

Closed Router startup phase.

#### [`RouterServer.help`](./server.ts#L35)

_Variable_

```ts
  export const help = processHelp
```

Usage text listing the Router process's environment variables.

#### [`RouterServer.layer`](./server.ts#L85)

_Variable_

```ts
  export const layer: Layer.Layer<never, StartupError> =
    Layer.scopedDiscard(runRouterServer)
```

Complete production Router process composition.

```mermaid
flowchart LR
  Binary["moltzap-router"] --> Server["RouterServer.layer"]
  Server --> App["buildRouterApp"]
  App --> Http["makeRouterHttpApp"]
  Http --> Authentication["AuthenticatedHttp"]
  Authentication --> Rpc["private Router RPC"]
  Rpc --> Operations["send or poll"]
  Operations --> State["feed, cursor, and poll waiters"]
  State --> Response["exact HTTP response"]
```

## Files

- `index.ts`
- `router.ts`
- `router/contract.ts`
- `router/feed.ts`
- `router/http.ts`
- `router/poll-cursor.ts`
- `router/poll-waiters.ts`
- `router/poll.ts`
- `router/README.md`
- `router/rpc.ts`
- `router/send.ts`
- `server.ts`
