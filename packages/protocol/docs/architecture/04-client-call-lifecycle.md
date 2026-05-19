# 04 — Client call lifecycle (originator)

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

> **Spec F (#617) status:** the originator described here is still the
> wire-level implementation post-Spec-F, but it is no longer a
> directly-exported public symbol. The lifecycle guarantees in this
> document (pending insert-before-write, scope-finalizer, atomic
> insert / take, late-frame drop) survive Spec F unchanged — they
> apply to the originator embedded inside
> `dispatch.ts → buildServerDispatcher` /
> `buildAgentClientDispatcher` / `buildTaskMasterDispatcher` via the
> internalized `makeJsonRpcClient` helper. The public surface moves
> to `Connection.call` (see
> [11 — Typed dispatcher](./11-typed-dispatcher.md)); the internal
> originator's contract is unchanged. This doc will be folded into
> 11 when the §6 FRI cutover deletes the last legacy consumer.

`makeJsonRpcClient` is **scope-bound**: closing the scope runs
`failAllPending(NotConnectedError)` so no caller is ever orphaned on a
hung Deferred (in `json-rpc-client.ts → failAllPending`).

```text
caller
   │
   ▼  call(definition, params)                                  json-rpc-client.ts → call
   │
   ▼  counterRef.modify(n → [n+1, n+1])
   │       generates `${idPrefix}-${next}` JsonRpcId
   │
   ▼  requestFrame(id, definition, params) → RequestFrame
   │
   ▼  Deferred.make<unknown, RpcCallError>()
   │
   ▼  pendingRef.update(set(id, {method, definition, deferred}))
   │       ─── pending map insert BEFORE write (#310 contract)
   │
   ▼  config.write(JSON.stringify(frame))
   │       │
   │       ├─ ok        →  proceed to Deferred.await
   │       │
   │       └─ failure   →  Deferred.fail(NotConnectedError);
   │                       Effect.fail bubbles, ensuring() removes from map
   │
   ▼  Deferred.await(deferred)
   │       ↑
   │       │  ── unblocked by `resolve(frame)` when matching inbound arrives
   │       │
   │       ▼  decodeRpcResult(definition, result)
   │             │
   │             ├─ success → ResultOf<D>
   │             │
   │             └─ RpcResultDecodeError → RpcServerError
   │                                       code: -32603,
   │                                       "Invalid result for method: …"
   │
   └─ ensuring(pendingRef.remove(id))  ── runs on success, failure, OR interrupt
                                          (Issue #310 contract)
```

Inbound response routing (in `json-rpc-client.ts → resolve`):

```text
ResponseFrame arrives at the transport
   │
   ▼  client.resolve(frame)
   │
   ▼  frame.id === null  →  return false (drop; nothing to settle)
   │
   ▼  pendingRef.modify(takePendingEntry(frame.id))
   │       atomic Get-then-Remove
   │
   ▼  Option.match
        │
        ├─ None  →  return false   ── late frame, deferred already cleaned up
        │
        └─ Some(entry)  →  completePendingFrame
                              │
                              ├─ frame.error  →  Deferred.fail(wireErrorToRpcCallError)
                              │                      │
                              │                      └─ errorClassFor(code) → tagged-class
                              │                          ctor; else RpcServerError fallback
                              │
                              └─ frame.result →  Deferred.succeed(result)
```

The pending-map uses atomic `Ref.modify` for both insert and take, so two
inbound responses with the same id (server bug) at worst resolve once and
then race-lose harmlessly (second take sees `None`).
