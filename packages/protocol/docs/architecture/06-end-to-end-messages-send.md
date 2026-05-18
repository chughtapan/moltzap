# 06 — End-to-end `messages/send`

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

Concrete walk-through of one method, end to end:

```text
CLIENT                                              SERVER
──────                                              ──────
caller
  │  service.send({...})
  ▼
MoltZapWsClient.call(MessagesSend, params)
  │
  ▼  json-rpc-client.ts → call
  │
  │  next id = "wsclient-42"
  │  frame = {jsonrpc:"2.0", id:"wsclient-42",
  │           method:"messages/send", params:{...}}
  │  insert pending[wsclient-42] = {Deferred}
  │  write(JSON.stringify(frame))
  │  await Deferred
  │                                                 ─── WS frame ──▶
  │                                                                 decodeClientInbound(json)
  │                                                                   → {_tag: "ClientRequest",
  │                                                                      definition: MessagesSend,
  │                                                                      params}
  │                                                                 makeJsonRpcServer.handle(frame, ctx)
  │                                                                   ▼ json-rpc-server.ts → handle
  │                                                                 handlerByMethod.get("messages/send")
  │                                                                   ▼
  │                                                                 decodeRpcParams → ParamsOf<MessagesSend>
  │                                                                   ▼
  │                                                                 messageHandlers["messages/send"]
  │                                                                   .handle(params, dispatchCtx)
  │                                                                   ▼
  │                                                                 MessageService.send(...)
  │                                                                   ▼
  │                                                                 Exit.isSuccess → result
  │                                                                   ▼
  │                                                                 successResponse(frame, ms, result)
  │                                                                   ▼ logInfo "RPC request completed"
  │                                                <── WS frame ──   responseFrame(id, {result})
  │
  ▼  socket onmessage → decodeServerInbound → ResponseSuccess
  │
  ▼  client.resolve(frame)
  │  → pendingRef.modify(take("wsclient-42"))
  │  → Deferred.succeed(result)
  │
  ▼  await unblocks
  │  decodeRpcResult(MessagesSend, result)
  │
  ▼  ResultOf<MessagesSend> returned to caller
```

On the error arm, the server returns `{error: {code, message, data}}`,
`completePendingFrame` calls `wireErrorToRpcCallError`, and the caller
sees a `Deferred.fail` with either a `RegisteredTaggedError` (if the wire
code is in the registry) or `RpcServerError` (anything else).
