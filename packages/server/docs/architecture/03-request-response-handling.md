# Request → Response Handling

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

`handleFrame(raw)` decodes once via `decodeClientInbound` (from `@moltzap/protocol`),
then `Match.value` routes by the discriminated tag:

```mermaid
flowchart TD
    A["raw string from socket"]
    A -->|"JSON.parse"| B{"parse ok?"}
    B -->|"fail"| B1["handleParseFailure (rate-limited log)<br/>+ sendFrame(encodeErrorResponse(null,<br/>{code: -32700, message: 'Invalid JSON'}))"]
    B -->|"ok"| C["decodeClientInbound(parsed)<br/><i>@moltzap/protocol → rpc-registry.ts</i>"]
    C -->|"MalformedFrameError"| C1["sendInvalidRequest(null)"]
    C -->|"ok"| D["Match.value(decoded)<br/><i>app/server.ts → handleFrame</i>"]

    D -->|"ResponseSuccess / ResponseError"| E["handleResponseFrame(frame)"]
    D -->|"Notification"| D1["sendInvalidRequest(null)<br/>(server doesn't accept notifications)"]
    D -->|"ClientRequest"| F["handleRequestFrame(frame)"]

    E --> E1["conn.jsonRpcClient.resolve(frame)<br/>routes response to the Deferred created<br/>when calling out via dispatch/authorize<br/>or any other S→C callback"]
    E1 --> E2{"pending entry<br/>matched?"}
    E2 -->|"no"| E3["log warning"]

    F --> F1{"conn = connections.get(connId)<br/>found?"}
    F1 -->|"no"| F1a["return"]
    F1 -->|"yes"| F2["isConnect = (frame.method === Connect.name)"]
    F2 --> F3{"!isConnect &&<br/>!conn.auth?"}
    F3 -->|"yes"| F3a["sendFrame(encodeErrorResp(id,<br/>{code: Unauthorized,<br/>message: 'Not authenticated.<br/>Send network/connect first.'})"]
    F3 -->|"no"| F4["jsonRpcServer.handle(frame, {auth, connId})<br/><i>@moltzap/protocol → makeJsonRpcServer.handle</i>"]

    F4 --> F5["handlerByMethod.get(frame.method)<br/>decodeRpcParams(handler.definition, frame.params)<br/>rpcHandler.handle(params, ctx)<br/>runs inside dispatchRuntime — R = AppTags resolved<br/>structurally; handler body can yield* XServiceTag freely"]

    F5 --> F6{"Exit?"}
    F6 -->|"isSuccess"| F6a["successResponse(frame, ms, value)"]
    F6 -->|"isFailure — tagged error"| F6b["knownWireErrorResponse"]
    F6 -->|"isFailure — untagged"| F6c["internalErrorResponse (-32603)"]

    F6a --> G["sendFrame(response)"]
    F6b --> G
    F6c --> G

    G --> H{"isConnect?"}
    H -->|"yes"| I["fireConnectionHooks<br/>db.selectFrom('agents').select('name')…<br/>for hook of connectionHooks:<br/>runUserHook(hook, {agentId, agentName, ownerUserId, connId}, …)<br/>USER_HOOK_TIMEOUT_MS = 2_000"]
    H -->|"no"| J["done"]
```

## See also

- [§02 WebSocket connection lifecycle](./02-ws-connection-lifecycle.md) — how the socket and reader fiber are set up
- [§04 Server-initiated callback](./04-server-initiated-callback.md) — `handleResponseFrame` settles server-originated Deferreds
- [§07 HTTP routes](./07-http-routes.md) — parallel HTTP surface
