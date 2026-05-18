# 03 — Server request handling

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`makeJsonRpcServer` builds a method→handler map at construction time and
serves through a single `handle(frame, ctx)` entry point:

```text
ResponseFrame ← makeJsonRpcServer.handle(frame, ctx)            json-rpc-server.ts → handle
                       │
                       ▼
            handlerByMethod.get(frame.method)
                       │
              ┌────────┴─────────────┐
              │ undefined            │ RpcHandler
              ▼                      ▼
       methodNotFoundResponse   decodeRpcParams(handler.definition, frame.params)
       code: -32601                       │
              │                  ┌────────┴─────────────┐
              │                  │ Failure              │ Success
              │                  ▼                      ▼
              │           invalidParamsResponse    handler.handle(params, ctx)
              │           code: -32602                  │
              │                  │              ┌──────┴───────────────┐
              │                  │              │ Exit.isSuccess       │ Exit.isFailure
              │                  │              ▼                      ▼
              │                  │       successResponse           failureResponse(cause)
              │                  │       logInfo + result               │
              │                  │              │              wireErrorFromInstance(failure)
              │                  │              │                       │
              │                  │              │              ┌────────┴────────┐
              │                  │              │              │ tagged-error    │ generic cause
              │                  │              │              ▼                 ▼
              │                  │              │      knownWireErrorResponse  internalErrorResponse
              │                  │              │      logWarning + code         logError + cause
              │                  │              │      from registry             code: -32603
              └────────┬─────────┴──────────────┴───────────────┴─────────────────┘
                       ▼
                  ResponseFrame
```

Tagged error mapping (in `json-rpc-server.ts → wireErrorFromInstance`): the
server uses `isRegisteredErrorInstance` to check whether the failure carries
a `static readonly code`/`message` set by `registerErrorClass`. If so, the
class's code + the instance's message + the instance's `data` ride the wire.
Anything else collapses to `InternalError` (-32603) with `Cause.pretty(cause)`
logged but **not** sent to the client.

Handlers are bound via the `handler(definition, fn)` factory (in
`json-rpc-server.ts → handler`). The cast erases descriptor-typed params to
`unknown` for storage; runtime `decodeRpcParams` produces the `ParamsOf<D>`
shape, so the erasure is safe.
