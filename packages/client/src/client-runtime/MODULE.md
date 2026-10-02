# client/client-runtime

_`packages/client/src/client-runtime`_

## Purpose

Scoped MCP implementation of the public semantic HarnessEndpoint.

## Public surface

### [`acquireHarnessEndpoint`](./index.ts#L68)

_Function_

```ts
export function acquireHarnessEndpoint(
  endpoint: URL,
): Effect.Effect<HarnessEndpoint, ConnectError, Scope.Scope>
```

Acquire one real MCP-backed endpoint and its scoped connection.

**Returns:** An endpoint whose resources remain live for the caller's scope.

## Files

- `index.ts`
