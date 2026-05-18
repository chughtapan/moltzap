# 04 — Client call lifecycle

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`makeJsonRpcClient` is **scope-bound**: closing the scope runs
`failAllPending(NotConnectedError)` so no caller is ever orphaned on a
hung Deferred (in `json-rpc-client.ts → failAllPending`).

```mermaid
flowchart TD
    CALLER["caller"]
    CALL["call(definition, params)"]
    COUNTER["counterRef.modify(n → [n+1, n+1])<br>generates idPrefix-next JsonRpcId"]
    FRAME["requestFrame(id, definition, params) → RequestFrame"]
    DEFERRED["Deferred.make&lt;unknown, RpcCallError&gt;()"]
    PENDING["pendingRef.update(set(id, {method, definition, deferred}))<br>pending map insert BEFORE write (#310 contract)"]
    WRITE["config.write(JSON.stringify(frame))"]
    WRITE_OK["proceed to Deferred.await"]
    WRITE_FAIL["Deferred.fail(NotConnectedError)<br>Effect.fail bubbles, ensuring() removes from map"]
    AWAIT["Deferred.await(deferred)<br>(unblocked by resolve(frame) when matching inbound arrives)"]
    DECODE_RESULT["decodeRpcResult(definition, result)"]
    RESULT_OK["ResultOf&lt;D&gt;"]
    RESULT_ERR["RpcServerError<br>code: -32603<br>\"Invalid result for method: …\""]
    ENSURE["ensuring(pendingRef.remove(id))<br>runs on success, failure, OR interrupt (#310 contract)"]

    CALLER --> CALL --> COUNTER --> FRAME --> DEFERRED --> PENDING --> WRITE
    WRITE -->|"ok"| WRITE_OK --> AWAIT
    WRITE -->|"failure"| WRITE_FAIL
    AWAIT --> DECODE_RESULT
    DECODE_RESULT -->|"success"| RESULT_OK
    DECODE_RESULT -->|"RpcResultDecodeError"| RESULT_ERR
    RESULT_OK --> ENSURE
    RESULT_ERR --> ENSURE
    WRITE_FAIL --> ENSURE
```

Inbound response routing (in `json-rpc-client.ts → resolve`):

```mermaid
flowchart TD
    ARRIVE["ResponseFrame arrives at the transport"]
    RESOLVE["client.resolve(frame)"]
    NULL_CHECK{"frame.id === null?"}
    DROP_NULL["return false<br>(drop; nothing to settle)"]
    TAKE["pendingRef.modify(takePendingEntry(frame.id))<br>atomic Get-then-Remove"]
    OPTION{"Option.match"}
    NONE["return false<br>(late frame, deferred already cleaned up)"]
    COMPLETE["completePendingFrame"]
    ERROR_ARM["frame.error<br>→ Deferred.fail(wireErrorToRpcCallError)<br>errorClassFor(code) → tagged-class ctor;<br>else RpcServerError fallback"]
    SUCCESS_ARM["frame.result<br>→ Deferred.succeed(result)"]

    ARRIVE --> RESOLVE --> NULL_CHECK
    NULL_CHECK -->|"yes"| DROP_NULL
    NULL_CHECK -->|"no"| TAKE --> OPTION
    OPTION -->|"None"| NONE
    OPTION -->|"Some(entry)"| COMPLETE
    COMPLETE -->|"frame.error"| ERROR_ARM
    COMPLETE -->|"frame.result"| SUCCESS_ARM
```

The pending-map uses atomic `Ref.modify` for both insert and take, so two
inbound responses with the same id (server bug) at worst resolve once and
then race-lose harmlessly (second take sees `None`).
