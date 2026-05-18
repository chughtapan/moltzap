# Outbound `messages/send` Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```mermaid
sequenceDiagram
    participant caller
    participant svc as MoltZapService
    participant wsClient as MoltZapWsClient
    participant wire
    participant server

    caller->>svc: service.send(convId, text, {dispatchLeaseId})<br/>(service.ts → MoltZapService.send)
    Note over svc: isConversationArchived?<br/>yes → Effect.fail(RpcServerError)<br/>no → sendRpc(MessagesSend, {...})<br/>(service.ts → send, the dispatchLeaseId branch)

    svc->>wsClient: sendRpc(def, params)<br/>(service.ts → sendRpc)
    Note over wsClient: client.sendRpc(definition, params, opts)<br/>(ws-client.ts → MoltZapWsClient.sendRpc)<br/>timeoutMs = opts?.timeoutMs ?? 30_000

    Note over wsClient: sendRpcEffect():<br/>Ref.get(stateRef)<br/>None → fail(NotConnectedError)<br/>Some → jsonRpcClient.call(definition, params)<br/>(ws-client.ts → sendRpcEffect)

    Note over wsClient: jsonRpcClient allocates JsonRpcId<br/>encodes JSON-RPC request frame
    wsClient->>server: write(JSON.stringify(frame))<br/>{"jsonrpc":"2.0","method":"messages/send",<br/>"id":"rpc-N","params":{conversationId,<br/>parts:[{type:"text",text}],dispatchLeaseId?}}
    Note over wsClient: Deferred&lt;ResultOf&lt;MessagesSend&gt;&gt;<br/>raced against 30s timeout

    server-->>wsClient: {"jsonrpc":"2.0","id":"rpc-N",<br/>"result":{message:{id}}}
    Note over wsClient: readerFiber decodes frame:<br/>handleIncoming(raw) → decodeFrames(raw) →<br/>handleDecodedResponse(decoded) →<br/>jsonRpcClient.resolve(frame)<br/>(ws-client.ts → handleDecodedResponse)<br/>settles Deferred → caller resumes
    wsClient-->>svc: Effect.void
    svc-->>caller: Effect.void
```

**dispatchLeaseId path**: when `opts.dispatchLeaseId` is set, the param is
forwarded verbatim in the JSON-RPC params frame. The server uses it to
mark a dispatch lease as consumed, preventing the TM from timing it out.
`MoltZapChannelCore.sendReply` passes `this.leaseIdInFlight` automatically
when the caller does not supply an explicit lease id (channel-core.ts →
`sendReply`, the auto-lease branch).

**Error paths**:
- `NotConnectedError` — `stateRef` is `None` (not connected yet, or
  disconnect raced); fails immediately without a network round-trip.
- `RpcTimeoutError` — no response within 30 s; in-flight Deferred is
  cancelled; the outstanding JSON-RPC id is left unreserved on the server.
- `RpcServerError` — server returned an `error` response frame; code/message
  forwarded verbatim. `ConversationArchivedError` (code 4002) is one example.

See also: [Error Taxonomy](./05-error-taxonomy.md) for full error type
descriptions and propagation invariants.
