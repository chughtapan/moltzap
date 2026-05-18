# Error Taxonomy

← Back to [package ARCHITECTURE](../../ARCHITECTURE.md)

All errors are Effect tagged errors unless noted. "Raised at" means the
effect fails with this type; callers pattern-match on `._tag`.

| Error | Package / File | Raised when | Caller guidance |
|---|---|---|---|
| `NotConnectedError` | `@moltzap/protocol`<br/>`transport/rpc-errors.ts → NotConnectedError` | `sendRpc()` called while `stateRef=None`; or socket closed mid-call during `failAllPending()` sweep<br/>`(ws-client.ts → sendRpcEffect)` | Catch and surface to user as "not connected" |
| `RpcTimeoutError` | `@moltzap/protocol`<br/>`transport/rpc-errors.ts → RpcTimeoutError` | No response frame in `timeoutMs` (default 30,000 ms)<br/>`(ws-client.ts → sendRpcEffect, timeout race)` | Retry or report timeout to user |
| `RpcServerError` | `@moltzap/protocol`<br/>`transport/rpc-errors.ts → RpcServerError` | Server returned JSON-RPC error frame with unknown code; or `ConversationArchivedError` (code 4002) etc.<br/>`(ws-client.ts → sendRpcEffect)` | Inspect `.code` for known protocol codes |
| `MalformedFrameError` | `@moltzap/protocol`<br/>`transport/wire-errors.ts → MalformedFrameError` | `JSON.parse` fails or `decodeServerInbound` rejects the shape<br/>`(frame.ts → decodeFrame; ws-client.ts → handleIncoming)` | Logged + dropped (1-of-50 logged); never propagates to callers |
| `AgentNotFoundError` | `@moltzap/client`<br/>`runtime/errors.ts → AgentNotFoundError` | `AgentsLookupByName` returns no agents for the requested name<br/>`(service.ts → resolveAgentName)` | Surface to user as "agent not found" |
| `DuplicateServerRpcHandlerError` | `@moltzap/client`<br/>`runtime/errors.ts → DuplicateServerRpcHandlerError` | `handleServerRpc()` called twice for same definition<br/>`(ws-client.ts → handleServerRpc)` | Programming error; never retry |
| `RegisterAgentError` | `@moltzap/client`<br/>`auth.ts → RegisterAgentError` | HTTP register endpoint returned non-2xx, or request/decode failed | Print `.message` to user |
| `DispatchAdmissionTimedOut` | `@moltzap/client`<br/>`channel-core-errors.ts → DispatchAdmissionTimedOut` | `dispatch/request` RPC + `awaitDispatchRelease` exceeded `admissionTimeoutMs` (default 30s)<br/>`(channel-core.ts → dispatchAdmission)` | Fail-closed: treated as "deny"; message dropped |
| `DispatchLeaseExpired` | `@moltzap/client`<br/>`channel-core-errors.ts → DispatchLeaseExpired` | `InboundHandler` took longer than `leaseTimeoutMs` (default 90s) inside `dispatchWithLease`<br/>`(channel-core.ts → dispatchWithLease, timeout branch)` | Logged as warning; handler result discarded; lease server-side times out independently |
| `ServiceInputError` | `@moltzap/client`<br/>`runtime/service-helpers.ts → ServiceInputError` | Local socket daemon received unknown/invalid RPC method<br/>`(service.ts → handleSocketRequest)` | Daemon responds with error to CLI caller |
| `SocketRequestError` | `@moltzap/client`<br/>`cli/socket-client.ts → SocketRequestError` | Unix-socket dial failed (`ENOENT`/`ECONNREFUSED` = daemon not running), 10s timeout, or RPC error | CLI prints message to stderr and exits 1 |

**Error propagation invariants**:
1. `MalformedFrameError` never escapes the reader fiber — logged + dropped.
2. Dispatch admission errors (timeout, network) are fail-closed to "deny";
   they do not propagate to `InboundHandler`.
3. `InboundHandler` errors propagate to the consumer fiber's
   `catchAllCause` → logged, then the fiber continues with the next item.

See also: [Inbound Dispatch Sequence](./03-inbound-dispatch.md) for where
`DispatchAdmissionTimedOut` and `DispatchLeaseExpired` are raised in context.
