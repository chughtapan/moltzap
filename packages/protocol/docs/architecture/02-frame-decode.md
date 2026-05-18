# 02 — Frame decode pipeline

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The single decode entry point is `decodeFrame` (wire.ts); the two
direction-typed wrappers in `rpc-registry.ts` narrow what *kind* of frame
is admissible on which side:

```mermaid
flowchart TD
    RAW["raw socket payload"]
    PARSE["JSON.parse<br>(caller's responsibility — wire layer takes unknown)"]
    DECODE["decodeFrame(parsed)"]
    VRQ["validateRequestFrame<br>→ {_tag: &quot;Request&quot;}"]
    VRS["validateResponseFrame<br>→ {_tag: &quot;Response&quot;}"]
    VNF["validateNotificationFrame<br>→ {_tag: &quot;Notification&quot;}"]
    NOTE["all three pre-validated by Ajv<br>against generic JSON-RPC envelope schemas"]
    DSI["decodeServerInbound<br>(used by client)"]
    DCI["decodeClientInbound<br>(used by server)"]
    OUT_S["DecodedServerInbound<br>(discriminated union)"]
    OUT_C["DecodedClientInbound<br>(discriminated union)"]

    RAW --> PARSE --> DECODE
    DECODE --> VRQ
    DECODE --> VRS
    DECODE --> VNF
    VRQ --> NOTE
    VRS --> NOTE
    VNF --> NOTE
    NOTE --> DSI
    NOTE --> DCI
    DSI --> OUT_S
    DCI --> OUT_C
```

**Annotations:**

- `decodeFrame` — `wire.ts → decodeFrame`
- `decodeServerInbound` / `decodeClientInbound` — `rpc-registry.ts → decodeServerInbound / decodeClientInbound`

For `decodeServerInbound` (used by client):
- Request frames: `decodeRpcRequest(taskCallbackMethods)` → `ServerRequest`
- Response frames: `decodeResponseFrame` → `ResponseSuccess | ResponseError`
- Notification frames: `decodeNotification(notificationDefs)` → `Notification`

For `decodeClientInbound` (used by server):
- Request frames: `decodeRpcRequest(rpcMethods)` → `ClientRequest`
- Response frames: `decodeResponseFrame` → `ResponseSuccess | ResponseError`
- Notification frames: `decodeNotification(notificationDefs)` → `Notification`

Both wrappers **fail closed with `MalformedFrameError`** on any mismatch —
including a response frame whose `id` is `null` (rpc-registry.ts →
`decodeClientInbound`, null-id guard), since a null id has no pending call
to resolve.

Client-inbound `Request` frames are restricted to `taskCallbackMethods`
(the subset the server is allowed to call back into the client — e.g.
`dispatch/authorize`). Server-inbound `Request` frames cover the full
`rpcMethods` set.
