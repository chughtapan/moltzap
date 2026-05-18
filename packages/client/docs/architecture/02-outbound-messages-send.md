# Outbound `messages/send` Sequence

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

```text
  caller             MoltZapService        MoltZapWsClient      wire       server
    │                     │                      │               │            │
    │──service.send(──────▶│                     │               │            │
    │   convId, text,      │                     │               │            │
    │   {dispatchLeaseId}) │                     │               │            │
    │  (service.ts → MoltZapService.send)        │               │            │
    │                      │ isConversationArchived?             │            │
    │                      │  yes → Effect.fail(RpcServerError)  │            │
    │                      │  no → sendRpc(MessagesSend, {...})  │            │
    │                      │  (service.ts → send, the dispatchLeaseId branch) │
    │                      │                     │               │            │
    │                      │──sendRpc(def, params)──────────────▶│            │
    │                      │  (service.ts → sendRpc)             │            │
    │                      │                     │               │            │
    │                      │   client.sendRpc(definition,        │            │
    │                      │     params, opts)   │               │            │
    │                      │   (ws-client.ts → MoltZapWsClient.sendRpc)      │
    │                      │   timeoutMs = opts?.timeoutMs       │            │
    │                      │              ?? 30_000              │            │
    │                      │                     │               │            │
    │                      │   sendRpcEffect():  │               │            │
    │                      │   Ref.get(stateRef) │               │            │
    │                      │    None → fail(NotConnectedError)   │            │
    │                      │    Some → jsonRpcClient.call(       │            │
    │                      │      definition, params)            │            │
    │                      │   (ws-client.ts → sendRpcEffect)    │            │
    │                      │                     │               │            │
    │                      │   jsonRpcClient allocates JsonRpcId │            │
    │                      │   encodes JSON-RPC request frame    │            │
    │                      │   write(JSON.stringify(frame)) ─────▶──────────▶│
    │                      │                     │    {"jsonrpc":"2.0",       │
    │                      │                     │     "method":"messages/send",
    │                      │                     │     "id":"rpc-N",          │
    │                      │                     │     "params":{             │
    │                      │                     │       conversationId,      │
    │                      │                     │       parts:[{type:"text"  │
    │                      │                     │         text}],            │
    │                      │                     │       dispatchLeaseId?}}   │
    │                      │                     │               │            │
    │                      │   Deferred<ResultOf<MessagesSend>>  │            │
    │                      │   raced against 30s timeout         │            │
    │                      │                     │               │            │
    │                      │                     │ ◀────────────────response─│
    │                      │                     │  {"jsonrpc":"2.0",         │
    │                      │                     │   "id":"rpc-N",            │
    │                      │                     │   "result":{message:{id}}} │
    │                      │                     │               │            │
    │                      │   readerFiber decodes frame:        │            │
    │                      │   handleIncoming(raw) →             │            │
    │                      │   decodeFrames(raw) →               │            │
    │                      │   handleDecodedResponse(decoded) →  │            │
    │                      │   jsonRpcClient.resolve(frame)      │            │
    │                      │   (ws-client.ts → handleDecodedResponse)        │
    │                      │   settles Deferred → caller resumes │            │
    │ ◀── Effect.void ──────│                     │               │            │
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
