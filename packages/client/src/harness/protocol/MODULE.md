# client/harness/protocol

_`packages/client/src/harness/protocol`_

## Purpose

Daemon MCP schemas and ports; hosts use the names and operations entrypoints.

## Public surface

### [`decodeHarnessMessageReadyEvent`](./operations.ts#L242)

_Function_

```ts
export function decodeHarnessMessageReadyEvent(
  value: unknown,
): Effect.Effect<HarnessMessageReadyEvent, ParseResult.ParseError>
```

Decode one exact pending-delivery notification payload.

**Returns:** The validated pending delivery.

### [`decodeHarnessReadInboxResult`](./operations.ts#L151)

_Variable_

```ts
export const decodeHarnessReadInboxResult =
  Schema.decodeUnknown(inboxResultSchema)
```

Decode a bounded inbox page received through the MCP transport.

### [`decodeHarnessSendErrorData`](./operations.ts#L253)

_Function_

```ts
export function decodeHarnessSendErrorData(
  value: unknown,
): Effect.Effect<HarnessSendErrorData, ParseResult.ParseError>
```

Decode the error data of one refused `send_message` call.

**Returns:** The collective failure or send reason it carries.

### [`decodeHarnessSendResult`](./operations.ts#L275)

_Function_

```ts
export function decodeHarnessSendResult(
  value: unknown,
): Effect.Effect<HarnessSendResult, ParseResult.ParseError>
```

Decode one `send_message` result, ignoring fields this release does not
name.

**Returns:** The operation id a gather names and the local firewall's guidance
on the admitted send, each if any.

## Files

- `operations.ts`
