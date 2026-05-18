# 07 — Server-initiated callback: `dispatch/authorize`

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Same client/server runtime, reversed roles. The server holds a `JsonRpcClient`
instance per moderator connection (lives in `@moltzap/server-core`); the
client holds a `JsonRpcServer` wired with `taskCallbackHandlers`.

```text
SERVER (forked fiber)                               CLIENT (moderator)
─────────────────────                               ──────────────────
AppHost.runAuthorizeDispatch
  │
  ▼  perConnectionClient.call(
       DispatchAuthorize, {dispatchId, …})
  │  pending["server-7"] = Deferred
  │  await
  │                                                 ─── WS frame ──▶
  │                                                                 decodeServerInbound(json)
  │                                                                   → {_tag: "ServerRequest",
  │                                                                      definition: DispatchAuthorize,
  │                                                                      params}
  │                                                                 client-side JsonRpcServer.handle
  │                                                                   ▼
  │                                                                 taskCallbackHandlers
  │                                                                   ["dispatch/authorize"]
  │                                                                   .handle(params, ctx)
  │                                                                   ▼
  │                                                                 moderator app code emits verdict
  │                                                                 → {decision: "grant" | "deny" | "hold"}
  │                                                                   ▼
  │                                                <── WS frame ──   responseFrame(id, {result: verdict})
  │
  ▼  serverside.resolve(frame)
  │  → Deferred.succeed(verdict)
  │
  ▼  back into AppHost: emit dispatch/release{verdict}
     to the original recipient connection
```

`taskCallbackMethods` is the **strict subset** of `rpcMethods` allowed
in this direction; `decodeServerInbound` rejects any other method as
`MalformedFrameError`, so a misconfigured server can't smuggle a
non-callback request through the client's inbound path.
