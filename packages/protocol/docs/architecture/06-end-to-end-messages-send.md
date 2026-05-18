# 06 — End-to-end `messages/send`

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Concrete walk-through of one method, end to end:

```mermaid
sequenceDiagram
    participant Caller
    participant Client as "MoltZapWsClient<br/>(json-rpc-client.ts → call)"
    participant Server as "makeJsonRpcServer<br/>(json-rpc-server.ts → handle)"

    Caller->>Client: service.send({...})
    Note over Client: next id = "wsclient-42"<br/>frame = {jsonrpc:"2.0", id:"wsclient-42",<br/>method:"messages/send", params:{...}}<br/>insert pending[wsclient-42] = {Deferred}<br/>write(JSON.stringify(frame))<br/>await Deferred
    Client->>Server: WS frame (messages/send, id: wsclient-42)
    Note over Server: decodeClientInbound(json)<br/>→ {_tag: "ClientRequest", definition: MessagesSend, params}<br/>handlerByMethod.get("messages/send")<br/>decodeRpcParams → ParamsOf&lt;MessagesSend&gt;<br/>messageHandlers["messages/send"].handle(params, dispatchCtx)<br/>MessageService.send(...)<br/>Exit.isSuccess → result<br/>successResponse — logInfo "RPC request completed"
    Server-->>Client: WS frame (responseFrame id: wsclient-42, {result})
    Note over Client: socket onmessage → decodeServerInbound → ResponseSuccess<br/>client.resolve(frame)<br/>pendingRef.modify(take("wsclient-42"))<br/>Deferred.succeed(result)<br/>await unblocks<br/>decodeRpcResult(MessagesSend, result)
    Client-->>Caller: ResultOf&lt;MessagesSend&gt;
```

On the error arm, the server returns `{error: {code, message, data}}`,
`completePendingFrame` calls `wireErrorToRpcCallError`, and the caller
sees a `Deferred.fail` with either a `RegisteredTaggedError` (if the wire
code is in the registry) or `RpcServerError` (anything else).
