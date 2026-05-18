# Error Taxonomy

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

All errors are Effect tagged errors unless noted. "Raised at" means the
effect fails with this type; callers pattern-match on `._tag`.

```text
Error                       Package/File                 Raised when
─────────────────────────── ──────────────────────────── ──────────────────────────────
NotConnectedError           @moltzap/protocol             sendRpc() called while
                            transport/rpc-errors.ts       stateRef=None; or socket
                            → NotConnectedError           closed mid-call during
                                                         failAllPending() sweep
                                                         (ws-client.ts → sendRpcEffect)
                            ┗━ callers: catch and surface
                               to user as "not connected"

RpcTimeoutError             @moltzap/protocol             No response frame in
                            transport/rpc-errors.ts       timeoutMs (default 30_000ms)
                            → RpcTimeoutError             (ws-client.ts → sendRpcEffect,
                                                         timeout race)
                            ┗━ callers: retry or report
                               timeout to user

RpcServerError              @moltzap/protocol             Server returned JSON-RPC
                            transport/rpc-errors.ts       error frame with unknown
                            → RpcServerError              code; or ConversationArchi-
                                                         vedError (code 4002) etc.
                                                         (ws-client.ts → sendRpcEffect)
                            ┗━ inspect .code for known
                               protocol codes

MalformedFrameError         @moltzap/protocol             JSON.parse fails or
                            transport/wire-errors.ts      decodeServerInbound rejects
                            → MalformedFrameError         the shape
                                                         (frame.ts → decodeFrame;
                                                         ws-client.ts → handleIncoming)
                            ┗━ logged + dropped (1-of-50
                               logged); never propagates
                               to callers

AgentNotFoundError          @moltzap/client               AgentsLookupByName returns
                            runtime/errors.ts             no agents for the requested
                            → AgentNotFoundError          name
                                                         (service.ts → resolveAgentName)
                            ┗━ surface to user as
                               "agent not found"

DuplicateServerRpcHandler-  @moltzap/client               handleServerRpc() called
Error                       runtime/errors.ts             twice for same definition
                            → DuplicateServerRpcHandlerError
                                                         (ws-client.ts → handleServerRpc)
                            ┗━ programming error; never
                               retry

RegisterAgentError          @moltzap/client               HTTP register endpoint
                            auth.ts                       returned non-2xx, or
                            → RegisterAgentError          request/decode failed
                            ┗━ print .message to user

DispatchAdmissionTimedOut   @moltzap/client               dispatch/request RPC +
                            channel-core-errors.ts        awaitDispatchRelease
                            → DispatchAdmissionTimedOut   exceeded admissionTimeoutMs
                                                         (default 30s)
                                                         (channel-core.ts →
                                                         dispatchAdmission)
                            ┗━ fail-closed: treated as
                               "deny"; message dropped

DispatchLeaseExpired        @moltzap/client               InboundHandler took longer
                            channel-core-errors.ts        than leaseTimeoutMs (default
                            → DispatchLeaseExpired        90s) inside dispatchWithLease
                                                         (channel-core.ts →
                                                         dispatchWithLease, timeout branch)
                            ┗━ logged as warning; handler
                               result discarded; lease
                               server-side times out

ServiceInputError           @moltzap/client               Local socket daemon received
                            runtime/service-helpers.ts    unknown/invalid RPC method
                            → ServiceInputError           (service.ts → handleSocketRequest)
                            ┗━ daemon responds with error
                               to CLI caller

SocketRequestError          @moltzap/client               Unix-socket dial failed
                            cli/socket-client.ts          (ENOENT/ECONNREFUSED =
                            → SocketRequestError          daemon not running),
                                                         10s timeout, or RPC error
                            ┗━ CLI prints message to
                               stderr and exits 1
```

**Error propagation invariants**:
1. `MalformedFrameError` never escapes the reader fiber — logged + dropped.
2. Dispatch admission errors (timeout, network) are fail-closed to "deny";
   they do not propagate to `InboundHandler`.
3. `InboundHandler` errors propagate to the consumer fiber's
   `catchAllCause` → logged, then the fiber continues with the next item.

See also: [Inbound Dispatch Sequence](./03-inbound-dispatch.md) for where
`DispatchAdmissionTimedOut` and `DispatchLeaseExpired` are raised in context.
