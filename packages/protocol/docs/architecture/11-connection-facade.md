# 11 — Connection facade

> **STUB — outline only.** Architect tier, Spec A (#595), sub-issue #603.
> Impl-staff fills the prose, the sequence diagram, the state diagram,
> and the worked walk-throughs at impl-staff cutover time.

`Connection<Ctx>` owns the wire pipeline: `JSON.parse → decode*Inbound
→ frame discrimination → dispatch to internal correlator OR dispatcher
→ encode → JSON.stringify → write`. Two constructors fix the direction
at scope-acquisition time:

- `makeServerConnection<Ctx>(config): Effect<Connection<Ctx>, never, Scope>`
- `makeClientConnection<Ctx>(config): Effect<Connection<Ctx>, never, Scope>`

This document explains how Connection composes with the surrounding
caller (server `socket-handler.ts`, client `ws-client.ts`, conformance
`test-server.ts` / `test-client.ts`) and what invariants the pipeline
preserves.

Symbol citations: cite `Connection.onRequestDecoded`, never
`connection.ts:NNN` (per `feedback_no_line_number_doc_citations`).

## H2 outline (impl-staff fills)

### 1. Pipeline overview

- Inbound: `SocketLike.runRaw` → JSON.parse → `decode*Inbound` →
  `Match.tag` over the four arms (Request / ResponseSuccess /
  ResponseError / Notification) → dispatch to the correlator (response
  arms) or the hook chain → dispatcher (request arm).
- Outbound: `Connection.call` / `notify` / `sendError` →
  `definition.encodeRequest` / `notificationFrame` / `encodeErrorResponse`
  → `JSON.stringify` → `SocketLike.write`.
- Cite the entry symbols: `Connection.runRaw`, `Connection.call`,
  `decodeServerInbound`, `decodeClientInbound`.

### 2. The `onRequestDecoded` hook seam

- Where the hook fires in the pipeline (post-decode, pre-dispatch).
- How the auth gate in `socket-handler.ts` registers via this hook
  and short-circuits with `Connection.sendUnauthorized`.
- Hook composition: multiple hooks fire in registration order; the
  first failing hook short-circuits.
- `HookFailure = RegisteredTaggedError | RpcServerError`; how the
  serialized response derives from `wireErrorFromInstance`.

### 3. Handler registration contract

- The five invariants (key = `def.method`, duplicate-key rejection,
  idempotent unregister, idempotent unsubscribe, in-flight semantics,
  decode-vs-dispatch snapshot).
- Cross-link to the spec section "Handler registration contract" in
  issue #595's body for the authoritative phrasing.
- Sequence diagram: `register` → frame arrives mid-registration →
  observed by next-frame dispatch (snapshot rule).
- Sequence diagram: in-flight `handler` → `unregister` → new frame
  observes empty map; in-flight call completes normally.

### 4. Error channels (LSP-citation table)

| Symbol | Channel | When |
|---|---|---|
| `Connection.call` | `RpcCallError \| SocketWriteError \| ConnectionClosedError \| RequestTimeoutError` | Outbound RPC |
| `Connection.notify` | `SocketWriteError \| ConnectionClosedError` | Outbound notification |
| `Connection.sendError` (+ helpers) | `SocketWriteError \| ConnectionClosedError` | Outbound error responses |
| `Connection.register` | `DuplicateHandlerError` | Duplicate method key |
| `Connection.runRaw` | `SocketReadError \| DispatchPanic` | Inbound pump (recoverable errors consumed inline) |

Note: per-frame *recoverable* failures (decode errors, schema rejection,
hook-rejected auth) become JSON-RPC error responses inside the pump.
They do NOT escape via `runRaw`'s Effect error channel.

### 5. Scope + lifecycle

- `makeServerConnection` / `makeClientConnection` return
  `Effect<Connection<Ctx>, never, Scope.Scope>` — caller owns the
  scope (Spec A "Invariants").
- Scope-close runs the correlator finalizer:
  `failAllPending(ConnectionClosedError)`.
- Reconnect on the client side: `WsClient.activeCallbackRegistry`
  (the renamed `appCallbackHandlersRef`) lives OUTSIDE any single
  Connection's scope; on reconnect, `ws-client.onReconnect` iterates
  the registry and re-registers every entry into the freshly
  constructed Connection.

### 6. The `queuedHandler` sibling utility

- Why backpressure is OUT of Connection (Spec A Decision D1 = B).
- Wrapper shape: `queuedHandler(handler, { capacity, onFull })`
  returns a `RpcHandler<Ctx, D>` shape-compatible with `register`.
- Default policy `rejectWithBusy` emits the "QueueFull" wire shape
  documented in Spec A "Golden frames" §9.

### 7. Migration map (post-cutover)

| Legacy site (symbol) | Connection replacement |
|---|---|
| `socket-handler.handleFrame` + `parseFrame` + `handleRequestFrame` + `handleResponseFrame` | `Connection.runRaw(socket)` + `Connection.onRequestDecoded(authGate)` |
| `socket-handler.makeSendFrame` + `sendInvalidRequest` | `Connection.sendError` + `Connection.sendInvalidRequest` |
| `acquireConnectionRpcClient` (in `server/transport/connection.ts`) | `Connection.call` on a per-socket `Connection<DispatchContext>` |
| `WsClient.handleIncoming` + `handleDecodedFrame` + `handleDecodedResponse` + `handleDecodedServerRequest` | `Connection.runRaw(socket)` |
| `WsClient.buildInboundServerReply` + `appCallbackRpcHandlers` (per-callback `makeJsonRpcServer` rebuild) | Dynamic `Connection.register(def, queuedHandler(handler, ...))` |
| `WsClient.writeQueueFullRejection` | `queuedHandler({ onFull: rejectWithBusy })` policy |
| `WsClient.dispatchInboundServerRequest` + `writeInboundServerReply` | Connection's internal dispatcher |
| Five direct `encodeErrorResponse` call sites | `Connection.sendError` (or one of the three named helpers per D4) |
| `protocol/testing/conformance/_shared/driver/test-server.ts` + `test-client.ts` (pipeline reimplementations) | Connection-backed test drivers |

### 8. Conformance & golden frames

- The conformance suite's `clientConformance.runClientConformanceSuite`
  factory signature does NOT change (Assumption 3) — only the internal
  driver swaps to Connection.
- The nine golden-frame fixtures (Spec A "Golden frames" §1–§9) each
  become an AC: encode equality vs literal bytes, decode equality vs
  shape, no mutation.
- The bounded property test (Spec A AC12) asserts Connection's
  behavior matches the captured `legacy-dispatch-oracle.json` snapshot
  for ≤8 handlers, ≤16 frames, ≤256-char params, depth ≤4, ≤8 array
  elements, ≤16 method names.

### 9. Open clarifications (architect-flagged, for impl-staff)

- **`RemoteTaggedError` vs `RegisteredTaggedError`.** Spec A AC1 lists
  both. This architect treats them as the same closed union; impl-staff
  may keep the type alias or introduce a `RemoteTaggedError`
  wrapper class. Either way, the wire-decode path stays unchanged.
- **`register(def, handler)` redundancy.** The handler already carries
  its `definition`; passing `def` twice is a typed redundancy for
  generic anchoring. Impl-staff may collapse to
  `register(handler: RpcHandler<Ctx, D>)`; the architect preserves the
  spec's literal shape to keep AC review tight.
- **`onRequestDecoded` sync return.** Spec literal is `Subscription`
  (sync); a sync-backed `Set.add` over a private mutable structure
  satisfies it. Impl-staff may lift to `Effect<Subscription, never,
  never>` for symmetry with `register` if review requires it.
