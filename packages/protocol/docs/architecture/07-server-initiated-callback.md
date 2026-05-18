# 07 — Server-initiated callback: `dispatch/authorize`

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Same client/server runtime, reversed roles. The server holds a `JsonRpcClient`
instance per moderator connection (lives in `@moltzap/server-core`); the
client holds a `JsonRpcServer` wired with `taskCallbackHandlers`.

```mermaid
sequenceDiagram
    participant Server as "SERVER (forked fiber)
    participant Client as "CLIENT (moderator)

    Note over Server: perConnectionClient.call(DispatchAuthorize, {dispatchId, …})<br>pending["server-7"] = Deferred<br>await
    Server->>Client: WS frame (dispatch/authorize, id: server-7)
    Note over Client: decodeServerInbound(json)<br>→ {_tag: "ServerRequest", definition: DispatchAuthorize, params}<br>taskCallbackHandlers["dispatch/authorize"].handle(params, ctx)<br>moderator app code emits verdict<br>→ {decision: "grant" | "deny" | "hold"}
    Client-->>Server: WS frame (responseFrame id: server-7, {result: verdict})
    Note over Server: serverside.resolve(frame)<br>Deferred.succeed(verdict)<br>emit dispatch/release{verdict} to original recipient connection
```

`taskCallbackMethods` is the **strict subset** of `rpcMethods` allowed
in this direction; `decodeServerInbound` rejects any other method as
`MalformedFrameError`, so a misconfigured server can't smuggle a
non-callback request through the client's inbound path.
