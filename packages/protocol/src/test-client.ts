import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashMap,
  ManagedRuntime,
  Option,
  Ref,
  Scope,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
} from "./schema/frames.js";

let requestCounter = 0;

interface ConnState {
  readonly write: (frame: string) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  readonly handshakeSettled: Deferred.Deferred<unknown, Error>;
}

interface EventWaiter {
  readonly eventName: string;
  readonly deferred: Deferred.Deferred<EventFrame, Error>;
}

export interface RegisterResponse {
  agentId: string;
  apiKey: string;
  claimUrl: string;
  claimToken: string;
}

/**
 * Effect-native test harness for the MoltZap JSON-RPC-over-WebSocket
 * protocol. Backed by `@effect/platform/Socket` +
 * `@effect/platform-node/NodeSocket` — no raw `ws` dependency. The socket
 * lifecycle (reader fiber, writer, scope) lives on an internal
 * `ManagedRuntime` so fibers outlive any single Effect the caller runs.
 *
 * Public API is Effect-returning. Tests bridge via `Effect.runPromise`
 * or `@effect/vitest`'s `it.effect`.
 */
export class MoltZapTestClient {
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;
  private readonly pendingRef: Ref.Ref<
    HashMap.HashMap<string, Deferred.Deferred<ResponseFrame, Error>>
  >;
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly eventsRef: Ref.Ref<ReadonlyArray<EventFrame>>;
  private readonly eventWaitersRef: Ref.Ref<ReadonlyArray<EventWaiter>>;

  constructor(
    private readonly baseUrl: string,
    private readonly wsUrl: string,
  ) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.pendingRef = this.runtime.runSync(
      Ref.make<
        HashMap.HashMap<string, Deferred.Deferred<ResponseFrame, Error>>
      >(HashMap.empty()),
    );
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.eventsRef = this.runtime.runSync(
      Ref.make<ReadonlyArray<EventFrame>>([]),
    );
    this.eventWaitersRef = this.runtime.runSync(
      Ref.make<ReadonlyArray<EventWaiter>>([]),
    );
  }

  // ── Public API (Effect-returning) ──────────────────────────────────

  /** Register a new agent via HTTP. */
  register(
    name: string,
    opts?: { description?: string; inviteCode?: string },
  ): Effect.Effect<RegisterResponse, Error> {
    return Effect.tryPromise({
      try: () => {
        const body: Record<string, string> = { name };
        if (opts?.description) body.description = opts.description;
        if (opts?.inviteCode) body.inviteCode = opts.inviteCode;
        return fetch(`${this.baseUrl}/api/v1/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      },
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }).pipe(
      Effect.flatMap((res) =>
        res.ok
          ? Effect.tryPromise({
              try: () => res.json() as Promise<RegisterResponse>,
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            })
          : Effect.tryPromise({
              try: () => res.text(),
              catch: (err) =>
                err instanceof Error ? err : new Error(String(err)),
            }).pipe(
              Effect.flatMap((text) =>
                Effect.fail(
                  new Error(`Register failed: ${res.status} ${text}`),
                ),
              ),
            ),
      ),
    );
  }

  /** Open the WebSocket and send auth/connect with an API key. */
  connect(apiKey: string): Effect.Effect<unknown, Error> {
    return this.connectWithParams({
      agentKey: apiKey,
      minProtocol: "0.1.0",
      maxProtocol: "0.1.0",
    });
  }

  /** Open the WebSocket and send auth/connect with a JWT. */
  connectJwt(jwt: string): Effect.Effect<unknown, Error> {
    return this.connectWithParams({
      jwt,
      minProtocol: "0.1.0",
      maxProtocol: "0.1.0",
    });
  }

  /** Send a JSON-RPC request and wait for the response. */
  rpc(method: string, params?: unknown): Effect.Effect<unknown, Error> {
    return this.rpcEffect(method, params);
  }

  /** Wait for the next event whose `event` matches `eventName`. */
  waitForEvent(
    eventName: string,
    timeoutMs = 5000,
  ): Effect.Effect<EventFrame, Error> {
    return this.waitForEventEffect(eventName, timeoutMs);
  }

  /** Return all buffered events and clear the buffer. Synchronous. */
  drainEvents(): EventFrame[] {
    const snapshot = this.runtime.runSync(Ref.get(this.eventsRef));
    this.runtime.runSync(Ref.set(this.eventsRef, []));
    return [...snapshot];
  }

  /** Close the socket and fail all pending RPCs. Never fails. */
  close(): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      yield* Ref.set(this.stateRef, Option.none());
      yield* this.failAllPending("WebSocket closed");
      if (Option.isSome(state)) {
        yield* Scope.close(state.value.scope, Exit.void);
      }
    });
  }

  // ── Internals ──────────────────────────────────────────────────────

  private connectWithParams(
    params: Record<string, string>,
  ): Effect.Effect<unknown, Error> {
    return Effect.gen(this, function* () {
      const scope = yield* Scope.make();
      const handshakeSettled = yield* Deferred.make<unknown, Error>();

      // Gotcha §4.11: the NodeSocketServer test harness binds :: by default
      // and returns an undialable URL; production servers don't hit this
      // since they use NodeHttpServer. For the client, makeWebSocket just
      // dials whatever URL we pass it.
      const socket = yield* Scope.extend(
        Socket.makeWebSocket(this.wsUrl, {
          openTimeout: Duration.seconds(30),
        }),
        scope,
      ).pipe(
        Effect.mapError((cause) => {
          const msg =
            typeof cause === "object" && cause !== null && "message" in cause
              ? String((cause as { message: unknown }).message)
              : String(cause);
          return new Error(`Failed to open socket: ${msg}`);
        }),
      );

      const write = yield* Scope.extend(socket.writer, scope);

      // Gotcha §4.10: use onExit (not tapErrorCause) so a clean close
      // (code 1000) also triggers pending-drain — otherwise pendings
      // hang forever after a clean disconnect.
      const readerEffect = socket
        .runRaw((data) =>
          this.handleIncoming(
            typeof data === "string"
              ? data
              : new TextDecoder("utf-8").decode(data),
          ),
        )
        .pipe(
          Effect.onExit(() =>
            Effect.gen(this, function* () {
              yield* this.failAllPending("WebSocket closed");
              yield* Deferred.fail(
                handshakeSettled,
                new Error("WebSocket closed before handshake"),
              ).pipe(Effect.ignore);
              yield* Ref.set(this.stateRef, Option.none());
            }),
          ),
        );

      // Fork on the client's ManagedRuntime so the reader fiber outlives
      // the outer connect() Effect — otherwise when the caller's fiber
      // finalizes, the reader is interrupted too.
      const readerFiber = this.runtime.runFork(readerEffect);

      yield* Ref.set(
        this.stateRef,
        Option.some({ write, readerFiber, scope, handshakeSettled }),
      );

      // Race auth/connect response against the handshakeSettled Deferred
      // (fired if the reader fiber exits pre-response, §5.1).
      return yield* Effect.race(
        this.rpcEffect("auth/connect", params),
        Deferred.await(handshakeSettled),
      );
    }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
  }

  private rpcEffect(
    method: string,
    params?: unknown,
  ): Effect.Effect<unknown, Error> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) {
        return yield* Effect.fail(new Error("WebSocket not connected"));
      }

      const id = `req-${++requestCounter}`;
      const frame: RequestFrame = {
        jsonrpc: "2.0",
        type: "request",
        id,
        method,
        params,
      };

      // Gotcha §4.9: register the Deferred BEFORE writing. `write` yields
      // to the scheduler, so the reader could see a pre-response close
      // and run failAllPending before we register, leaving us to await
      // a never-resolved Deferred.
      const deferred = yield* Deferred.make<ResponseFrame, Error>();
      yield* Ref.update(this.pendingRef, (m) => HashMap.set(m, id, deferred));

      yield* state.value.write(JSON.stringify(frame)).pipe(
        Effect.catchAll((err) =>
          Effect.gen(this, function* () {
            yield* Ref.update(this.pendingRef, (m) => HashMap.remove(m, id));
            return yield* Effect.fail(
              new Error(`Failed to send frame: ${String(err)}`),
            );
          }),
        ),
      );

      const resp = yield* Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(10_000),
          onTimeout: () => new Error(`RPC timeout for ${method}`),
        }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Ref.update(this.pendingRef, (m) => HashMap.remove(m, id))
            : Effect.void,
        ),
      );

      if (resp.error) {
        const err = new Error(resp.error.message) as Error & {
          code: number;
          data?: unknown;
        };
        err.code = resp.error.code;
        if (resp.error.data !== undefined) err.data = resp.error.data;
        return yield* Effect.fail(err);
      }
      return resp.result;
    });
  }

  private waitForEventEffect(
    eventName: string,
    timeoutMs: number,
  ): Effect.Effect<EventFrame, Error> {
    return Effect.gen(this, function* () {
      // Consume an already-buffered event if one matches.
      const buffered = yield* Ref.modify(this.eventsRef, (events) => {
        const idx = events.findIndex((e) => e.event === eventName);
        if (idx === -1) return [null as EventFrame | null, events];
        const chosen = events[idx]!;
        const next = [...events.slice(0, idx), ...events.slice(idx + 1)];
        return [chosen, next];
      });
      if (buffered !== null) return buffered;

      const deferred = yield* Deferred.make<EventFrame, Error>();
      const waiter: EventWaiter = { eventName, deferred };
      yield* Ref.update(this.eventWaitersRef, (ws) => [...ws, waiter]);

      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new Error(`Timeout waiting for event: ${eventName}`),
        }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Ref.update(this.eventWaitersRef, (xs) =>
                xs.filter((w) => w !== waiter),
              )
            : Effect.void,
        ),
      );
    });
  }

  private handleIncoming(raw: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      }).pipe(Effect.option);
      if (Option.isNone(parsed)) return;
      if (typeof parsed.value !== "object" || parsed.value === null) return;
      const msg = parsed.value as {
        type?: unknown;
        id?: unknown;
        event?: unknown;
      };

      if (msg.type === "response" && typeof msg.id === "string") {
        const id = msg.id;
        const pending = yield* Ref.modify(this.pendingRef, (m) => {
          const entry = HashMap.get(m, id);
          return entry._tag === "Some"
            ? [entry.value, HashMap.remove(m, id)]
            : [null, m];
        });
        if (pending !== null) {
          yield* Deferred.succeed(
            pending,
            msg as unknown as ResponseFrame,
          ).pipe(Effect.ignore);
        }
        return;
      }

      if (msg.type === "event" && typeof msg.event === "string") {
        const event = msg as unknown as EventFrame;
        // Deliver to the latest matching waiter (LIFO), else buffer.
        const delivered = yield* Ref.modify(this.eventWaitersRef, (ws) => {
          for (let i = ws.length - 1; i >= 0; i--) {
            if (ws[i]!.eventName === event.event) {
              const chosen = ws[i]!;
              const next = [...ws.slice(0, i), ...ws.slice(i + 1)];
              return [chosen, next];
            }
          }
          return [null as EventWaiter | null, ws];
        });
        if (delivered !== null) {
          yield* Deferred.succeed(delivered.deferred, event).pipe(
            Effect.ignore,
          );
        } else {
          yield* Ref.update(this.eventsRef, (events) => [...events, event]);
        }
      }
    });
  }

  private failAllPending(message: string): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const pending = yield* Ref.getAndSet(
        this.pendingRef,
        HashMap.empty<string, Deferred.Deferred<ResponseFrame, Error>>(),
      );
      for (const [, d] of HashMap.entries(pending)) {
        yield* Deferred.fail(d, new Error(message)).pipe(Effect.ignore);
      }
    });
  }
}
