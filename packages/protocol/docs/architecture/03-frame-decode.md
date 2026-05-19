# 03 — Frame decode pipeline

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

The single decode entry point is `decodeFrame` (wire.ts); the two
direction-typed wrappers in `rpc-registry.ts` narrow what *kind* of frame
is admissible on which side:

```text
raw socket payload
       │
       ▼  JSON.parse  (caller's responsibility — wire layer takes `unknown`)
       │
       ▼
decodeFrame(parsed)                                                   wire.ts → decodeFrame
       │
   ┌───┴────────────────────┬─────────────────────────────┐
   ▼                        ▼                             ▼
validateRequestFrame   validateResponseFrame      validateNotificationFrame
   │                        │                             │
{_tag:"Request"}        {_tag:"Response"}            {_tag:"Notification"}
   │                        │                             │
   └────────────────┬───────┴─────────────────────────────┘
                    │  (all three pre-validated by Ajv against the
                    │   generic JSON-RPC envelope schemas)
                    │
       ┌────────────┴────────────┐
       ▼                         ▼
decodeServerInbound        decodeClientInbound        rpc-registry.ts → decodeServerInbound / decodeClientInbound
(used by client)           (used by server)
       │                         │
   for Request:              for Request:
     decodeRpcRequest(           decodeRpcRequest(
       taskCallbackMethods)        rpcMethods)
     → ServerRequest             → ClientRequest
   for Response:             for Response:
     decodeResponseFrame         decodeResponseFrame
     → ResponseSuccess           → ResponseSuccess
       | ResponseError             | ResponseError
   for Notification:         for Notification:
     decodeNotification          decodeNotification
       (notificationDefs)          (notificationDefs)
     → Notification              → Notification
       │                         │
       ▼                         ▼
DecodedServerInbound       DecodedClientInbound
(discriminated union)      (discriminated union)
```

Both wrappers **fail closed with `MalformedFrameError`** on any mismatch —
including a response frame whose `id` is `null` (rpc-registry.ts →
`decodeClientInbound`, null-id guard), since a null id has no pending call
to resolve.

Client-inbound `Request` frames are restricted to `taskCallbackMethods`
(the subset the server is allowed to call back into the client — e.g.
`dispatch/authorize`). Server-inbound `Request` frames cover the full
`rpcMethods` set.
