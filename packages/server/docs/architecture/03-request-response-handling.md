# Request → Response Handling

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`handleFrame(raw)` decodes once via `decodeClientInbound` (from `@moltzap/protocol`),
then `Match.value` routes by the discriminated tag:

```text
raw string from socket
   │
   ▼ JSON.parse  ────────────── parse fail →  handleParseFailure (rate-limited log)
   │                                          + sendFrame(encodeErrorResponse(
   │                                              null, {code: -32700,
   │                                              message: "Invalid JSON"}))
   │
   ▼ decodeClientInbound(parsed)              ── @moltzap/protocol → rpc-registry.ts → decodeClientInbound
   │
   │       MalformedFrameError  →  sendInvalidRequest(null)
   │
   ▼ Match.value(decoded).pipe(
        Match.tag("ResponseSuccess", ({id, result}) => handleResponseFrame(...)),
        Match.tag("ResponseError",   ({id, error})  => handleResponseFrame(...)),
        Match.tag("Notification",    () => sendInvalidRequest(null)),  ← server doesn't take notifications
        Match.tag("ClientRequest",   ({definition, params, id}) =>
                                       handleRequestFrame(
                                         definition.encodeRequest(id, params))),
        Match.exhaustive,
      )                                                      app/server.ts → handleFrame, the Match.value dispatch block
   │
   │
   ┌── ClientRequest path ──┐         ┌── Response* path ────┐
   ▼                        │         ▼                       │
handleRequestFrame(frame)             handleResponseFrame(frame)
   │                                  │
   ▼ conn = connections.get(connId)   ▼  conn.jsonRpcClient.resolve(frame)
   │   if undefined → return          │      ↑
   │                                  │      │  routes the response to the
   ▼ isConnect = frame.method ===     │      │  Deferred this server-side
   │            Connect.name          │      │  client created when calling
   │                                  │      │  out via dispatch/authorize
   ▼ !isConnect && !conn.auth         │      │  or any other S→C callback
   │   → sendFrame(encodeErrorResp(   │      │
   │     id, {code: Unauthorized,     │      ▼  matched? log warning if no
   │      message: "Not authenticated.│         pending entry matches
   │      Send network/connect first."}))
   │
   ▼ jsonRpcServer.handle(frame, {auth, connId})    ── @moltzap/protocol
   │                                                   makeJsonRpcServer.handle
   │
   │  Inside makeJsonRpcServer:
   │   ─ handlerByMethod.get(frame.method)
   │   ─ decodeRpcParams(handler.definition, frame.params)
   │   ─ rpcHandler.handle(params, ctx) — Effect<unknown, unknown, R>
   │     ↑
   │     │ runs INSIDE dispatchRuntime so R = AppTags is resolved
   │     │ structurally; the handler body can `yield* XServiceTag`
   │     │ freely.
   │     ▼
   │   ─ Exit.isSuccess  → successResponse(frame, ms, value)
   │     Exit.isFailure  → failureResponse(frame, ms, cause)
   │                          ├─ tagged error in registry → knownWireErrorResponse
   │                          └─ otherwise → internalErrorResponse (-32603)
   │
   ▼ sendFrame(response)
   │
   ▼ if (isConnect) fireConnectionHooks
        │
        ├─ db.selectFrom("agents").select("name")...
        ├─ for hook of connectionHooks:
        │     runUserHook(hook, {agentId, agentName, ownerUserId, connId},
        │                  "Connection hook", logContext)
        │     # USER_HOOK_TIMEOUT_MS = 2_000
```

## See also

- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md) — how the socket and reader fiber are set up
- [§04 Server-initiated callback](./04-server-initiated-callback.md) — `handleResponseFrame` settles server-originated Deferreds
- [§07 HTTP routes](./07-http-routes.md) — parallel HTTP surface
