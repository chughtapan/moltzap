# client/endpoint/harness-endpoint

_`packages/client/src/endpoint/harness-endpoint`_

## Purpose

Scoped MCP implementation of the public semantic HarnessEndpoint.

## Public surface

### [`acquireHarnessEndpoint`](./index.ts#L61)

_Function_

```ts
export function acquireHarnessEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope>
```

Acquire one real MCP-backed endpoint and its scoped connection.

**Returns:** An endpoint whose resources remain live for the caller's scope.

### [`ConnectError`](./capability.ts#L27)

_Class_

```ts
export class ConnectError extends Data.TaggedError("ConnectError")<{
  readonly reason: ConnectFailure;
}> {
  override get message(): string {
    return `connect failed: ${this.reason}`;
  }
}
```

Acquiring the endpoint connection failed.

### [`HarnessEndpoint`](./capability.ts#L54)

_Interface_

```ts
export interface HarnessEndpoint {
  readonly send: (
    input: SendInput,
    options?: Readonly<{
      failureDelivery?: FailureDelivery;
      idempotencyKey?: string;
    }>,
  ) => Effect.Effect<
    SendResult,
    SendError | CollectiveError | FirewallSendError
  >;
  readonly messages: Stream.Stream<InboundDelivery, ListenError>;
}
```

Structural runtime capability owned by one scoped endpoint connection.
Every send is one operation or one collective response; the stream yields
inbound items.

A host whose tool returns before the send completes passes
`failureDelivery: "inbound"`: a refused gather, all_gather or response
then completes and its error arrives as an `operationFailed` item on the
stream. A multicast has no operation id, so its failure is always returned.
A firewall refusal always returns on the send call before creating an intent,
including when inbound failure delivery was requested.

### [`InboundDelivery`](./capability.ts#L36)

_Interface_

```ts
export interface InboundDelivery {
  readonly item: InboundItem;
  readonly guidance?: LocalGuidance;
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}
```

One inbound item plus its transport-only acknowledgment.

## Files

- `capability.ts`
- `index.ts`
