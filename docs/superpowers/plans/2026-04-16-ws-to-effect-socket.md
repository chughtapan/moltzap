# ws → @effect/platform/Socket migration scope

Author: migration-scope agent, 2026-04-16
Status: scoping + side-by-side POC only; main migration lands in a separate session.

## 0. TL;DR

Replace the `ws` npm package on both client and server paths with `@effect/platform/Socket` (+ `@effect/platform-node/NodeSocket`). Five source files currently import `ws`; three of them drive lifecycle (client `ws-client.ts`, server `app/server.ts`, protocol `test-client.ts`) and two are type-only / test-only (`server/src/ws/connection.ts`, `22-malformed-frame-ratelimit.integration.test.ts`). The POC (`packages/client/src/ws-client-effect.ts`, 438 LOC incl. docstrings) re-exercises three §5 behavioural invariants (happy path, §5.1 pre-open close, §5.3 timeout-no-retry) through an in-process `@effect/platform` WebSocket server fed by `NodeSocketServer.makeWebSocket`. POC test: 3/3 passing in ~250ms.

The migration is best done in three ordered slices so each slice can ship and be reverted independently: **(1) client**, **(2) server**, **(3) remove `ws` from package.json graph**.

## 1. Call-site inventory

Every line that imports or references the `ws` package, what it does, and the `@effect/platform` replacement. Line numbers are current on `main` at 0d2f55b.

| File:line | Current | Replacement | Notes |
| --- | --- | --- | --- |
| `packages/client/src/ws-client.ts:1` | `import WebSocket from "ws"` | `import * as Socket from "@effect/platform/Socket"` + `import * as NodeSocket from "@effect/platform-node/NodeSocket"` | Client-side WS lifecycle. |
| `packages/client/src/ws-client.ts:75` | `private ws: WebSocket \| null` | `Ref<Option<{ writer: (s: string) => Effect<void, SocketError>; shutdown: Effect<void> }>>` | No raw handle; socket identity flows through the scope + writer closure. |
| `packages/client/src/ws-client.ts:193–194` | `new WebSocket(url)` | `Socket.makeWebSocket(url)` (Effect-returning, needs `WebSocketConstructor` layer) | `.replace(/^http/, "ws") + "/ws"` stays — just URL shaping. |
| `packages/client/src/ws-client.ts:210–247` | `ws.on("open"/"message"/"close"/"error", …)` | Single `Socket.toChannelString(socket, "utf-8")` consumer running on a forked fiber; open/close surfaced via the channel's success and error channels | Event emitter → typed stream. |
| `packages/client/src/ws-client.ts:259` | `this.ws.readyState !== WebSocket.OPEN` | Replace with `Ref.get` on the connection state (`None` = not connected) — there is no `readyState` on `Socket` | Gotcha; see §4. |
| `packages/client/src/ws-client.ts:277` | `this.ws.send(JSON.stringify(frame))` | `yield* writer(JSON.stringify(frame))` where `writer` is obtained from `socket.writer` (Scope-managed) | Sync → Effect. |
| `packages/client/src/ws-client.ts:378–401` | `setTimeout(..., jitter)` reconnect backoff | `Effect.sleep(Duration) + Schedule.jittered + Schedule.exponential` retry loop | Drives reconnects via TestClock once this lands. |
| `packages/protocol/src/test-client.ts:1` | `import WebSocket from "ws"` | `import * as Socket from "@effect/platform/Socket"` + a small ManagedRuntime that owns the socket Scope, or internally delegate to `MoltZapWsClient` | `MoltZapTestClient` keeps the same class-surface (`register`/`connect`/`connectJwt`/`rpc`/`waitForEvent`/`close`/`drainEvents`) — only the innards change. |
| `packages/protocol/src/test-client.ts:82–135` | `new Promise((resolve, reject) => { const ws = new WebSocket(this.wsUrl); ws.on("open"/"message"/…) })` | Open socket inside a ManagedRuntime scope; consumer fiber pushes `ResponseFrame` → `pending.get(id)?.resolve`, events → `eventWaiters` | Promise-returning public API is preserved (the guard already carries `#ignore-sloppy-code` pragmas for this file because tests need `await rpc(...)`). |
| `packages/protocol/package.json:39,63` | `peerDependencies.ws ^8.0.0`, `devDependencies.ws ^8.18.0` | Drop `peerDependencies.ws`. Add `@effect/platform` + `@effect/platform-node` to `dependencies` (so the test-client carries its own runtime). | Peer is vestigial — only `test-client.ts` uses `ws` inside `@moltzap/protocol`. |
| `packages/server/src/app/server.ts:5` | `import { WebSocketServer, type WebSocket as WsWebSocket } from "ws"` | `import { HttpServerRequest }` (already imported) + `upgrade` effect; drop `WebSocketServer` | Server upgrade now lives inside an HttpRouter route. |
| `packages/server/src/app/server.ts:287` | `const wss = new WebSocketServer({ noServer: true })` | Delete. | Replaced by a `/ws` HttpRouter route that calls `HttpServerRequest.upgrade`. |
| `packages/server/src/app/server.ts:289–427` | `handleWsConnection(ws: WsWebSocket)` that registers `on("message"/"close"/"error")` and calls `ws.send(...)` | `Effect.gen(function* () { const req = yield* HttpServerRequest; const socket = yield* req.upgrade; /* ctx setup */; yield* socket.runRaw(handleRaw, { onOpen: ... }) })` inside a route + `Effect.forkScoped`. Writes via the `socket.writer` captured in a Ref held by `MoltZapConnection`. | The per-connection `malformedFrameCount` stays local to the fiber's closure. |
| `packages/server/src/app/server.ts:431–447` | `http.createServer(nodeHandler); server.on("upgrade", …) { wss.handleUpgrade(request, socket, head, (ws) => handleWsConnection(ws)) }` | Delete the raw `server.on("upgrade")` hook. Route `/ws` inside `HttpRouter` via `HttpRouter.get("/ws", handler)` where the handler yields `HttpServerRequest.upgrade`. | `NodeHttpServer.makeHandler` handles the Node upgrade internally once a route calls `upgrade`. |
| `packages/server/src/app/server.ts:514–525` | `conn.ws.close()` per-connection + `wss.close(callback)` | `Scope.close` each connection's scope (captured in `MoltZapConnection.shutdown`); global SocketServer handled by `NodeHttpServer` shutdown + `runtime.dispose()` | Drain still relies on the 500ms sleep — unrelated to this migration. |
| `packages/server/src/ws/connection.ts:1` | `import type { WebSocket as WsWebSocket } from "ws"` | Replace with a first-class write function type, e.g. `readonly write: (raw: string) => Effect.Effect<void, Socket.SocketError>` + `readonly shutdown: Effect.Effect<void>` | Public shape of `MoltZapConnection` changes (affects broadcaster); see §5 Slice 2. |
| `packages/server/src/ws/connection.ts:6` | `ws: WsWebSocket` field | Drop. Add `write` + `shutdown` as above. | |
| `packages/server/src/ws/broadcaster.ts:27,45` | `conn.ws.send(raw)` | `Effect.runFork(conn.write(raw))` — Broadcaster stays synchronous in shape (callers rely on it) but each per-connection write is an Effect forked off the calling fiber | See gotcha §4.2 (Broadcaster sync API keeps callers simple, but semantics shift from "fire-and-forget sync send" to "fire-and-forget forked Effect"). |
| `packages/server/src/__tests__/integration/22-malformed-frame-ratelimit.integration.test.ts:20` | `import WebSocket from "ws"` | Replace with `Socket.makeWebSocket(url)` + `Socket.toChannelString` — or, more cleanly, keep the raw frame API by wrapping a tiny `sendRawFrames(url, frames)` helper around `Socket.runRaw` | Only place in the test suite using raw `ws` to bypass the `MoltZapTestClient` validator; simplest to keep it raw via the new Effect Socket. |
| `packages/client/package.json:41` | `"ws": "^8.18.0"` | Remove. | |
| `packages/server/package.json:53` | `"ws": "^8.18.0"` | Remove. | |
| `packages/protocol/package.json:63` | dev `"ws": "^8.18.0"` | Remove. | |
| `packages/openclaw-channel/package.json:34` | `"ws": "^8.18.0"` | Remove — already unused in code, only `ws://` URL string-shaping. | `packages/openclaw-channel/src/test-utils/container-core.ts:49–50` is string-replace, not an import. |
| `packages/evals/package.json:72` | `"ws": "^8.18.0"` | Remove — no imports. | |

Out-of-scope callers of `ws` (documentation + code samples that are not shipped from our `src`):

- `README.md:30` — example snippet. Update as a doc pass once code is migrated.
- `docs/guides/two-agent-chat.mdx:13` — same.

## 2. API mapping per concern

### 2a. Connect lifecycle (open → auth/connect → active)

Current (`ws-client.ts:189–248`):

```
Effect.async((resume) => {
  const ws = new WebSocket(url);
  ws.on("open",  () => runtime.runPromiseExit(sendRpcEffect("auth/connect", ...)).then(settle));
  ws.on("close", () => settle(Exit.fail(NotConnectedError))); // §5.1 no-hang
  ws.on("error", () => settle(Exit.fail(NotConnectedError)));
})
```

Replacement:

```
Effect.gen(this, function* () {
  const socket = yield* Socket.makeWebSocket(url, { openTimeout: "30 seconds" });
  const write  = yield* socket.writer; // Scope-managed; closes on scope close
  yield* Ref.set(this.stateRef, Option.some({ write }));

  // Reader fiber: runRaw dispatches every frame through handleIncoming
  yield* Effect.forkScoped(
    socket.runRaw((data) =>
      typeof data === "string"
        ? handleIncoming(data)
        : handleIncoming(new TextDecoder().decode(data))
    )
  );

  // auth/connect as the first send — failure (incl. pre-open SocketError)
  // short-circuits because makeWebSocket's Effect fails with OpenTimeout
  // or the runRaw channel surfaces a SocketCloseError.
  return yield* this.sendRpcEffect("auth/connect", { agentKey, minProtocol, maxProtocol });
});
```

The pre-open close/error behaviour (§5.1) is naturally preserved: if the socket never opens, `Socket.makeWebSocket` fails with `SocketGenericError{reason: "Open" | "OpenTimeout"}`, which we catch and map to `NotConnectedError`. If the socket opens then closes before `auth/connect` returns, the forked reader fiber's channel fails with `SocketCloseError`; we fail all pendings (`§5.2`) and re-raise as `NotConnectedError`.

### 2b. Reading frames (event-based → stream-based)

Current: `ws.on("message", (data) => handleIncoming(data.toString()))`. Handler is synchronous + runForked into a `ManagedRuntime`.

Replacement: `socket.runRaw((data) => handleIncoming(data))` runs the handler inside the socket fiber's scope. Handler is an Effect so rate-limited logging and malformed-frame counting compose naturally:

```
const handleIncoming = (raw: string | Uint8Array): Effect.Effect<void> =>
  Effect.gen(this, function* () {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const decoded = yield* decodeFrame(text).pipe(
      Effect.catchTag("MalformedFrameError", (err) =>
        this.logMalformed(err.raw).pipe(Effect.as(null))
      ),
    );
    if (decoded === null) return;
    // same Response / Event dispatch as before, but via Ref.modify
  });
```

Alternative — `Socket.toChannelString(socket, "utf-8")` gives us a `Channel<Chunk<string>, Chunk<...>, SocketError, ...>`. Useful if we want to compose with `Stream.fromChannel` and apply rate limiting via `Stream.throttle` at the protocol layer, but for the POC `runRaw` is enough.

### 2c. Writing frames (method call → Queue offer or Writer)

Current: `this.ws.send(JSON.stringify(frame))` — synchronous, throws on not-open.

Replacement: `socket.writer` yields a function `(chunk) => Effect<void, SocketError>`. The returned writer is owned by the socket's `Scope`, so closing the scope also flushes/closes. We stash it in a `Ref` so `sendRpcEffect` can look it up:

```
const send = (frame: RequestFrame) =>
  Ref.get(this.stateRef).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(new NotConnectedError({ message: MSG_NOT_CONNECTED })),
      onSome: ({ write }) => write(JSON.stringify(frame))
        .pipe(Effect.mapError(() => new NotConnectedError({ message: MSG_NOT_CONNECTED }))),
    }))
  );
```

The old behaviour "throw on `send()` if `readyState !== OPEN`" maps to the `None` branch of the `Ref`, and write failures post-open (e.g. socket closed mid-write) map to the writer's `SocketError`.

Server-side equivalent on `MoltZapConnection`: replace `ws: WsWebSocket` with `write: (raw: string) => Effect<void, SocketError>` + `shutdown: Effect<void>`. The `Broadcaster` still exposes a synchronous API to its callers (handlers) but `conn.write(raw)` has to be `Effect.runFork`-ed. This is an observable semantic change — see gotcha §4.2.

### 2d. Close / disconnect (sync side effect → scope-managed Effect)

Current: `this.ws?.close()` (sync). Public API already returns `Effect<void, never>` on client, so the shape stays; we just wrap `Scope.close` instead of `ws.close()`.

Replacement: `makeWebSocket` acquires the socket inside a provided `Scope`; closing that scope closes the socket. The client owns a `Scope.CloseableScope` per connection, closing it in `close()` / before each reconnect attempt.

### 2e. Error events (on("error") → Channel error channel)

Current: `ws.on("error", …)` logs then treats the error as terminal; `ws.on("close", …)` drains pendings.

Replacement: `runRaw` returns `Effect<void, SocketError | E>`. When the socket errors, the Effect fails. We catch in the forked reader fiber:

```
Effect.forkScoped(
  socket.runRaw(handleIncoming).pipe(
    Effect.catchAll((err) =>
      this.logSocketError(err).pipe(
        Effect.zipRight(this.failAllPending(MSG_NOT_CONNECTED)),
        Effect.zipRight(this.onDisconnectCallback),
      )
    )
  )
)
```

`SocketCloseError` carries `code` and `closeReason`, which we can surface to `onDisconnect` for the first time (see gotcha §4.3).

### 2f. Reconnect with jittered exponential backoff (setTimeout → Effect.sleep + Schedule)

Current (`ws-client.ts:378–401`): raw `setTimeout(..., jitter)` loop. `ws-client.test.ts` explicitly flags this as out-of-reach for TestClock and falls back to `vi.useFakeTimers()`.

Replacement:

```
const reconnectSchedule =
  Schedule.exponential(Duration.millis(BASE_RECONNECT_DELAY_MS), 2).pipe(
    Schedule.jittered,
    Schedule.either(Schedule.spaced(Duration.millis(MAX_RECONNECT_DELAY_MS))),
  );

const reconnectLoop = this.connectEffect().pipe(
  Effect.retry(reconnectSchedule),
  Effect.onExit((exit) => {
    if (Exit.isSuccess(exit)) return this.onReconnectCallback(exit.value);
    return Effect.void;
  }),
);
```

This is the single biggest latent win: the current test suite cannot drive the reconnect delay through TestClock; the Effect-native version can, because `Effect.sleep` uses `Clock.sleep`.

### 2g. Malformed-frame rate limiting (same — keep the counter)

The 1/50/100 cadence counter lives inside the `handleIncoming` Effect. No API change. Counter stays mutable (guarded by the single consumer fiber); if we want to be fully referentially transparent, wrap it in a `Ref<number>` — trivial.

## 3. Behavioural invariants to preserve

Every §5 invariant from the file header of `ws-client.ts`, mapped to the test that enforces it. The test *setup* will swap `ws` for the Effect Socket (or better, for a real in-process `@effect/platform` WS server), but the **assertions** must still fire.

### §5.1 — connect() does not hang on pre-open failure

- `packages/client/src/ws-client.test.ts:178–231`, tests "rejects immediately when the socket closes before open", "rejects immediately when the socket errors before open", "resolves with HelloOk on the happy open → auth/connect path".
  - After migration, the first two test cases should drive an `NodeSocketServer` that closes/resets without handshake. The assertion `rejects.toThrow(/WebSocket not connected/)` stays.

### §5.2 — pending RPCs fail on disconnect

- `packages/client/src/ws-client.test.ts:237–271`.
  - After migration: open a connection, issue an RPC, then close the server socket (or call `client.disconnect()`). Assertion unchanged.

### §5.3 — no automatic retry on timeout

- `packages/client/src/ws-client.test.ts:287–362`, uses `TestClock.adjust(Duration.millis(30_000))`.
  - Already TestClock-driven via `@effect/vitest`'s `it.effect`. Post-migration it becomes even cleaner because the handshake also runs on the TestClock (no need to preheat it via Promise-land).

### §5.4 — malformed frames logged + dropped

- `packages/client/src/ws-client.test.ts:437–558`, three cases: "ignores a non-JSON frame while a pending RPC is outstanding", "routes a well-formed event frame to onEvent", "does NOT route an event frame missing the event name field".
  - Post-migration the fake-ws `vi.mock` goes away entirely; these test scenarios drive the real Effect Socket through an in-process server. The assertions — no Deferred resolved/rejected on malformed frames, `onEvent` called on valid events, `logger.warn` called — all stay unchanged.

### Reconnect backoff (not §5 but same test file)

- `packages/client/src/ws-client.test.ts:377–430`. This test's comment explicitly notes: *"Flagging this for a future refactor: routing the reconnect backoff through `Effect.sleep` / `Effect.schedule` would let us drive it with TestClock alongside the RPC timeout."* The migration is that refactor. Post-migration, rewrite the test as an `it.effect` using `TestClock.adjust(Duration.seconds(1))`.

### Typed-manifest overload (not §5 but same file)

- `packages/client/src/ws-client.test.ts:564–658`. Purely a compile-time + wire-level check. Fully preserved: the POC keeps the same overload signature.

### Malformed-frame log cadence

- `packages/client/src/ws-client.test.ts:664–707`. Behavioural — stays as-is.

### close() vs pending-RPC interleave

- `packages/client/src/ws-client.test.ts:714–748`. `closeClient()` must drain pendings synchronously. Preserved: our `close()` closes the Scope, which closes the socket; the reader fiber's `runRaw` then fails, invoking `failAllPending` — all synchronously chained.

### ws.on("error") → close propagation

- `packages/client/src/ws-client.test.ts:754–793`. Preserved.

### Server-side malformed-frame rate-limit test

- `packages/server/src/__tests__/integration/22-malformed-frame-ratelimit.integration.test.ts:80–132`. Two assertions:
  1. Server stays up under 101 garbage frames (**101 ≥ 95 ParseError responses back; post-flood `registerAndConnect` succeeds**).
  2. ParseError response for unparseable frame has `id: null`.
  - Post-migration the `sendRawFrames(url, frames)` helper is rewritten to open a `Socket.makeWebSocket` and `writer(frame)` for each frame, with a `runRaw` reader filling a response array. Assertions unchanged.

## 4. Gotchas

### 4.1. Heartbeat / ping-pong

`ws` auto-handles ping/pong frames below the app layer; `@effect/platform/Socket` does **not** surface an opinionated heartbeat. Current code already relies on TCP keepalive for liveness (there is no explicit ping code in `ws-client.ts`). Two reasonable options after migration:

1. **Status quo** — rely on TCP keepalive (Node default 2h, too long for prod). Accept that a silently-broken socket may not be detected until the next RPC times out.
2. **App-level heartbeat** — `Effect.repeat` a no-op `heartbeat/ping` RPC on a fiber alongside the reader. Already done on the server for presence (`packages/server/src/__tests__/integration/22-heartbeat.integration.test.ts`).

Recommendation: defer to follow-up; current behaviour is preserved (no ping, TCP keepalive only).

### 4.2. `ws.readyState === WebSocket.OPEN` checks

Two sites: `ws-client.ts:259` and `test-client.ts:140`. `@effect/platform/Socket` has no `readyState` — the socket is "open" as long as its scope is live. Replacement: track state in a `Ref<Option<ConnState>>`. `sendRpcEffect` checks `Ref.get(stateRef)` and fails with `NotConnectedError` on `None`. (Exactly the pattern the POC uses.)

### 4.3. Raw `CloseEvent.code` / `reason` propagation

`ws`'s `close` event carries `(code, reason)` but the current client ignores both — `onDisconnect` is called with no args. `@effect/platform/Socket`'s `SocketCloseError` carries `code` and `closeReason`; migration is an opportunity to thread them into `onDisconnect(reason?: { code: number; reason?: string })`. Not required; flagging for DX.

### 4.4. `upgradeReq` auth-header reading at upgrade time (server)

`packages/server/src/app/server.ts:431–447` currently uses Node's `upgrade` event where `request: IncomingMessage` is available. The current code does **not** read headers at upgrade — authentication happens post-upgrade via the first `auth/connect` RPC frame. This is convenient because `@effect/platform`'s `HttpServerRequest.upgrade` returns `Effect<Socket>` inside an HttpRouter route handler, and `HttpServerRequest.headers` is exposed there (see `HttpIncomingMessage.d.ts:31`). So if we ever want to read a header pre-upgrade, it's still accessible:

```
HttpRouter.get("/ws", Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest;
  const authHeader = req.headers["authorization"]; // available pre-upgrade
  const socket = yield* req.upgrade;
  // ...
}))
```

No gotcha today; bookmark for future header-based auth.

### 4.5. `MoltZapTestClient` cascades to many tests

`MoltZapTestClient` is used by every `.integration.test.ts` file in `packages/server/src/__tests__/integration/` (~28 files) plus `packages/openclaw-channel/src/__tests__/`, `packages/evals/`, and `packages/client/src/__tests__/service.integration.test.ts`. If we **preserve the public API of the class** — constructor, `register`, `connect`, `connectJwt`, `rpc`, `waitForEvent`, `drainEvents`, `close` — those ~28+ files need zero changes. This is the single biggest guardrail for keeping the migration scoped. The POC does not migrate the test-client; Slice 1 explicitly requires keeping the shape.

### 4.6. Broadcaster sync semantics shift

`packages/server/src/ws/broadcaster.ts` currently calls `conn.ws.send(raw)` synchronously. Callers rely on this being cheap — `broadcastToConversation` is called inside RPC handlers. Post-migration, `conn.write(raw)` is an Effect; we have to either:

1. **`Effect.runFork`** per connection (fire-and-forget, same semantics as `ws.send`).
2. **Return an Effect** from `broadcastToConversation` and update callers.

Recommendation: (1) — `Effect.runFork` at the broadcaster boundary. Keeps RPC handler sigs unchanged. The caller already doesn't await per-socket send success.

### 4.7. Server shutdown ordering

Current shutdown (`server.ts:502–537`) closes each WebSocket, then `wss.close`, then HTTP listener, then runtime dispose. Post-migration there is no standalone `wss` — the SocketServer is integrated into `NodeHttpServer`. Shutdown becomes: close each per-connection scope (triggers socket close + cleans up writer + reader fiber), then `NodeHttpServer` layer scope close (stops accepting new upgrades), then runtime dispose. SHUTDOWN_DRAIN_MS sleep stays (unrelated to this migration; noted in /review).

### 4.8. `new URL(agentKey as protocol)` patterns

None found. The current code builds the WS URL via string replace (`serverUrl.replace(/^http/, "ws") + "/ws"`). Same shape works for `Socket.makeWebSocket(url)`.

### 4.9. Register pending Deferred BEFORE writing (race discovered in POC)

`ws-client.ts:274–283` writes the frame via `ws.send(...)` FIRST, then registers the Deferred in `pendingRef`. That's safe for raw `ws` because `ws.send` is synchronous and atomic w.r.t. the event loop — the server-side receive (and any resulting close) can't be observed by the reader until the next tick.

Under `@effect/platform/Socket`, `write(...)` is an Effect that may yield to the scheduler. The reader fiber can interleave between `write` completing on-the-wire and `Ref.update(pendingRef, ...)` executing. Observed failure mode: server receives the frame, immediately sends `CloseEvent`, client's reader fiber sees `SocketCloseError`, runs `failAllPending` — but `pendingRef` is still empty because the current fiber hasn't registered its Deferred yet. Then the current fiber registers the Deferred, awaits it, and hangs forever.

**Fix applied in the POC**: register the Deferred before `write`, remove it in the `Left` branch of `Effect.either(write(...))` if the write fails. Real migration must do the same. See `ws-client-effect.ts:283–304` for the pattern.

### 4.10. Clean-close (code 1000) is NOT a failure

`@effect/platform/Socket` has a `defaultCloseCodeIsError = code => code !== 1000 && code !== 1006`. When the remote closes with code 1000 (normal), `runRaw` completes **successfully** (Effect's success channel), not via failure. If our `tapErrorCause` or `catchAll` only handles errors, a clean close goes unhandled — the reader fiber's Effect exits cleanly and nothing fires `failAllPending`. Pending RPCs hang forever.

**Fix applied in the POC**: use `Effect.onExit` instead of `Effect.tapErrorCause` so we fail pendings regardless of success/failure exit.

### 4.11. `NodeSocketServer.makeWebSocket` defaults to `::` wildcard (breaks dialable URL)

`new ws.WebSocketServer({ port: 0 })` binds to `::` (IPv6 wildcard). The server's `address()` return shape preserves the literal bind string, so `server.address.hostname` becomes `"::"` and the dialable URL is `ws://:::PORT` — invalid.

**Fix applied in the POC tests**: pass `host: "127.0.0.1"` explicitly to `NodeSocketServer.makeWebSocket({ port: 0, host: "127.0.0.1" })`. For the **server rewrite** (slice 2), this isn't a concern — production server is listening via `NodeHttpServer`, not `NodeSocketServer`. Only relevant when writing test harness servers.

### 4.12. `@effect/platform` version compatibility

`packages/client` and `packages/server` already depend on `@effect/platform ^0.96.0` and `@effect/platform-node ^0.106.0`. `@moltzap/protocol` does not. Migration of `test-client.ts` requires adding both to `@moltzap/protocol/dependencies` (currently protocol has **no workspace deps** — see `CLAUDE.md`: "None on other workspace packages (this is the leaf dependency)"). `@effect/platform` is not a workspace dep — it's an external package — so this doesn't violate the leaf-dependency invariant.

## 5. Order of operations

Sequential slices. Each should ship in its own PR so a mid-way regression doesn't require reverting the whole migration.

### Slice 1 — client (`ws-client.ts` + `test-client.ts`)

Rewrite `packages/client/src/ws-client.ts` against `@effect/platform/Socket`. Drop the `ws` import. Rewrite `packages/client/src/ws-client.test.ts` to drive an in-process WebSocket server (`NodeSocketServer.layerWebSocket`) instead of the `vi.mock("ws")` fake. Rewrite `packages/protocol/src/test-client.ts` — either (a) wrap `MoltZapWsClient` from `@moltzap/client` (would introduce a cycle; rejected) or (b) duplicate the Effect-native lifecycle inline (keeps `@moltzap/protocol` a leaf).

`runtime/frame.ts` and `runtime/errors.ts` are Effect-native already — no changes needed.

LOC touched (approx): ~450 lines of `ws-client.ts` rewritten, ~200 lines of `test-client.ts` rewritten, ~800 lines of `ws-client.test.ts` rewritten (fake WS infra goes away), ~50 lines of new POC integration tests. Net: **~1500 LOC touched**.

Risk: the `ws-client.test.ts` `vi.mock` pattern disappears. All inbound-frame scenarios need a real-ish server. The POC demonstrates this is tractable with `NodeSocketServer.layerWebSocket`.

### Slice 2 — server (`app/server.ts` + `ws/connection.ts` + `ws/broadcaster.ts`)

Rewrite `packages/server/src/app/server.ts` to route `/ws` via `HttpRouter` + `HttpServerRequest.upgrade`. Drop `WebSocketServer` import. Rewrite `MoltZapConnection` shape in `ws/connection.ts` (no more `ws: WsWebSocket`; add `write` + `shutdown`). Update `ws/broadcaster.ts` to `Effect.runFork` each per-connection write. Rewrite `packages/server/src/__tests__/integration/22-malformed-frame-ratelimit.integration.test.ts` to open the flood socket via `Socket.makeWebSocket` + `writer` instead of raw `ws`.

`MoltZapTestClient` is **already migrated** in Slice 1, so every other integration test picks up the new transport transparently via `@moltzap/protocol/test-client`.

LOC touched (approx): ~260 lines in `server.ts` (the `handleWsConnection` + upgrade block), ~20 lines in `connection.ts`, ~30 lines in `broadcaster.ts`, ~100 lines in `22-malformed-frame-ratelimit.integration.test.ts`. Net: **~410 LOC touched**.

Risk: `HttpServerRequest.upgrade` is undertested in this codebase (we have no existing usage). The `NodeHttpServer.makeHandler` path already runs through an HttpRouter so routing is fine; the question is whether `NodeHttpServer`'s built-in upgrade handling composes with our existing `http.createServer(nodeHandler)` pattern. If not, we either switch to `NodeHttpServer.layer` (full Effect-owned HTTP server) or keep the raw Node `server.on("upgrade")` and call `Socket.fromTransformStream` manually — either is tractable.

### Slice 3 — drop `ws` from package.json graph

Remove `"ws": "^8.18.0"` from `packages/client/package.json`, `packages/server/package.json`, `packages/openclaw-channel/package.json`, `packages/evals/package.json`. Remove `peerDependencies.ws` and `devDependencies.ws` from `packages/protocol/package.json`. Remove `@types/ws` devDeps where present. Update `docs/guides/two-agent-chat.mdx` + `README.md` snippets. Run `pnpm install` and `pnpm build && pnpm test` for confirmation.

LOC touched: ~20 lines across 5 package.json files, plus docs. Net: **~60 LOC + docs**.

Risk: none — code no longer references `ws` at all by this point.

**Total projected migration LOC: ~2000 source/test lines touched across 9 files.**

## 6. Test strategy

### Tests that survive as-is (no edits)

- Every `*.integration.test.ts` file under `packages/server/src/__tests__/integration/` that imports `MoltZapTestClient` from `@moltzap/protocol/test-client` — the class's public surface is preserved.
- `packages/openclaw-channel/src/__tests__/*.integration.test.ts` — ditto.
- `packages/client/src/__tests__/service.integration.test.ts` — ditto.
- `packages/evals/**/*` — no imports of `ws`.

### Tests that need to be rewritten

- `packages/client/src/ws-client.test.ts` — swap `vi.mock("ws")` + `FakeWebSocket` for an in-process `NodeSocketServer` or a `Socket.fromTransformStream` harness. All §5 assertions stay.
- `packages/server/src/__tests__/integration/22-malformed-frame-ratelimit.integration.test.ts` — swap raw `WebSocket` client for `Socket.makeWebSocket`. Assertions stay.
- `packages/client/src/ws-client.test.ts` reconnect-backoff test — flip from `vi.useFakeTimers()` to `TestClock.adjust(...)` now that the backoff is Effect-native.

### Tests added (in the POC, not wired into CI yet)

- `packages/client/src/ws-client-effect.test.ts` — three cases: happy-path connect+sendRpc, pre-open close doesn't hang (§5.1), RPC timeout with TestClock (§5.3).

## 7. Out of scope

- Heartbeat introduction (see §4.1).
- Threading `CloseEvent.code`/`reason` through `onDisconnect` (see §4.3).
- Changing the Broadcaster public shape (see §4.6).
- Migrating any adjacent Effect-native work (Kysely migration, app-host shape). Those are separate efforts tracked under `docs/superpowers/plans/`.

## 8. Open questions for the implementer

1. Does `NodeHttpServer.makeHandler(httpApp)` support WebSocket upgrades when the route calls `HttpServerRequest.upgrade`, or do we need to move to `NodeHttpServer.layer(serverOptions)` ownership model? The POC answers "yes for client-initiated, unknown for server-side". Slice 2 needs a 30-minute spike to confirm before writing a real rewrite.
2. Should `MoltZapConnection.write` return `Effect<void, SocketError>` or `Effect<void, never>` with logged-and-swallowed errors? The current `conn.ws.send()` branches bury errors under a `logger.warn` + continue. Recommend matching that: `Effect<void, never>` with internal `Effect.catchAll(logWarn)`.
3. Do we want `Schedule.exponential + jittered` or a hand-rolled jitter schedule that exactly matches the current `baseDelay * (0.5 + Math.random() * 0.5)`? Different jitter distributions observable to operators. Recommend matching current jitter via `Schedule.whileOutput(() => true, (_) => Duration.millis(baseDelay * (0.5 + Math.random() * 0.5)))` unless DX wants to simplify to stock `Schedule.jittered`.
