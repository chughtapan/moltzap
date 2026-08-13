/* eslint-disable sonarjs/no-nested-functions -- deterministic Deferreds keep each scope, reader, and finalizer in the interleaving that the test controls */

/**
 * @file Deterministic lifecycle tests for client shutdown and reader-exit
 * ordering. Controlled scopes stand in for sockets so completion means the
 * same finalizers a real connection owns have finished.
 */
import { describe, expect, it, vi } from "vitest";
import type { RpcGroup } from "@effect/rpc";
import type { RpcClientError } from "@effect/rpc/RpcClientError";
import {
  Chunk,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";
import { conversationId as conversationIdSchema } from "#conversation";
import { agentConnect, PROTOCOL_VERSION } from "#network";
import { messageReceivedNotificationDefinition } from "#message";
import type { agentCallableGroup } from "#socket/catalog";
import {
  type ClientLifecycleOptions,
  ProtocolClientLifecycle,
} from "./lifecycle.js";
import {
  type NotificationParamsOf,
  type TypedDispatchMap,
  NotConnectedError,
} from "#transport";
import { agentId, messageId, redactedAgentKey } from "#testing";

type TestRpc = Extract<
  RpcGroup.Rpcs<typeof agentCallableGroup>,
  { readonly _tag: typeof agentConnect.name }
>;
type TestDispatch = TypedDispatchMap<TestRpc, RpcClientError>;
type OpenSession = ClientLifecycleOptions<TestRpc, TestDispatch>["openSession"];
type OpenSessionOptions = Parameters<OpenSession>[0];
type SubscriberRegistry = OpenSessionOptions["registry"];

const ownerScope = (options: OpenSessionOptions): Effect.Effect<Scope.Scope> =>
  options.scope === undefined
    ? Effect.dieMessage("lifecycle did not provide its owner scope")
    : Effect.succeed(options.scope);

const AGENT_KEY = redactedAgentKey(
  `moltzap_agent_${"0".repeat(16)}_${"0".repeat(48)}`,
);
const CLIENT_WARNING_MARKER = "client warning stream probe";

const connectClient: TestDispatch = {
  [agentConnect.name]: () => Effect.succeed({}),
};

interface AuthCounter {
  authCalls: number;
}

const countingConnectClient = (counter: AuthCounter): TestDispatch => ({
  [agentConnect.name]: () =>
    Effect.sync(() => {
      counter.authCalls += 1;
      return {};
    }),
});

class TestClient extends ProtocolClientLifecycle<TestRpc, TestDispatch> {
  constructor(
    openSession: OpenSession,
    onDisconnect?: NonNullable<
      ClientLifecycleOptions<TestRpc, TestDispatch>["onDisconnect"]
    >,
  ) {
    super({
      serverUrl: "http://127.0.0.1:1",
      connectTag: agentConnect.name,
      connectPayload: {
        agentKey: AGENT_KEY,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      },
      openSession,
      ...(onDisconnect === undefined ? {} : { onDisconnect }),
    });
  }
}

interface CloseControls {
  readonly scopeFinalizing: Deferred.Deferred<undefined>;
  readonly releaseScope: Deferred.Deferred<undefined>;
  finalizerRuns: number;
  writes: number;
}

function closeGateFinalizer(control: CloseControls): Effect.Effect<void> {
  return Effect.sync(() => {
    control.finalizerRuns += 1;
  }).pipe(
    Effect.zipRight(Deferred.succeed(control.scopeFinalizing, undefined)),
    Effect.zipRight(Deferred.await(control.releaseScope)),
  );
}

function recordWrite(control: CloseControls): Effect.Effect<void> {
  return Effect.sync(() => {
    control.writes += 1;
  });
}

function gatedSession(control: CloseControls): OpenSession {
  return (options) =>
    Effect.gen(function* () {
      const scope = yield* ownerScope(options);
      yield* Scope.addFinalizer(scope, closeGateFinalizer(control));
      return {
        write: () => recordWrite(control),
        reader: Effect.never,
        scope,
        client: connectClient,
      };
    });
}

function awaitedCloseBody(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const scopeFinalizing = yield* Deferred.make<undefined>();
      const releaseScope = yield* Deferred.make<undefined>();
      const subscriberEnded = yield* Deferred.make<undefined>();
      const control: CloseControls = {
        scopeFinalizing,
        releaseScope,
        finalizerRuns: 0,
        writes: 0,
      };
      const client = new TestClient(gatedSession(control));
      yield* client.connect();
      yield* Effect.forkScoped(
        Stream.runDrain(
          client.subscribe(messageReceivedNotificationDefinition),
        ).pipe(
          Effect.onExit(() =>
            Deferred.succeed(subscriberEnded, undefined).pipe(Effect.asVoid),
          ),
        ),
      );
      yield* Effect.yieldNow();

      const firstClose = yield* Effect.forkScoped(client.close());
      yield* Deferred.await(scopeFinalizing);
      yield* Deferred.await(subscriberEnded);
      expect(Option.isNone(yield* Fiber.poll(firstClose))).toBe(true);

      const secondClose = yield* Effect.forkScoped(client.close());
      yield* Effect.yieldNow();
      expect(Option.isNone(yield* Fiber.poll(secondClose))).toBe(true);

      yield* Deferred.succeed(releaseScope, undefined);
      yield* Fiber.join(firstClose);
      yield* Fiber.join(secondClose);
      expect(control.finalizerRuns).toBe(1);
      expect(control.writes).toBe(1);
    }),
  );
}

function awaitedDisconnectBody(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const scopeFinalizing = yield* Deferred.make<undefined>();
      const releaseScope = yield* Deferred.make<undefined>();
      const control: CloseControls = {
        scopeFinalizing,
        releaseScope,
        finalizerRuns: 0,
        writes: 0,
      };
      const client = new TestClient(gatedSession(control));
      yield* client.connect();

      const disconnecting = yield* Effect.forkScoped(client.disconnect());
      yield* Deferred.await(scopeFinalizing);
      expect(Option.isNone(yield* Fiber.poll(disconnecting))).toBe(true);

      const closing = yield* Effect.forkScoped(client.close());
      yield* Effect.yieldNow();
      expect(Option.isNone(yield* Fiber.poll(closing))).toBe(true);

      yield* Deferred.succeed(releaseScope, undefined);
      yield* Fiber.join(disconnecting);
      yield* Fiber.join(closing);
      expect(control.finalizerRuns).toBe(1);
    }),
  );
}

interface ReaderExitControls {
  readonly endReader: Deferred.Deferred<undefined>;
  readonly scopeClosed: Deferred.Deferred<undefined>;
  readonly order: string[];
  opens: number;
}

function recordScopeClosed(control: ReaderExitControls): Effect.Effect<void> {
  return Effect.sync(() => {
    control.order.push("scope");
  }).pipe(Effect.zipRight(Deferred.succeed(control.scopeClosed, undefined)));
}

function controlledReaderExit(control: ReaderExitControls) {
  return Deferred.await(control.endReader).pipe(Effect.asVoid);
}

const writeNothing = () => Effect.void;

function captureRegistrySession(
  registryReady: Deferred.Deferred<SubscriberRegistry>,
): OpenSession {
  return (options) =>
    Effect.gen(function* () {
      const scope = yield* ownerScope(options);
      yield* Deferred.succeed(registryReady, options.registry);
      return {
        write: writeNothing,
        reader: Effect.never,
        scope,
        client: connectClient,
      };
    });
}

function receivedNotification(): NotificationParamsOf<
  typeof messageReceivedNotificationDefinition
> {
  return {
    message: {
      id: messageId("00000000-0000-0000-0000-000000000002"),
      conversationId: Schema.decodeSync(conversationIdSchema)(
        "00000000-0000-0000-0000-000000000003",
      ),
      senderId: agentId("00000000-0000-0000-0000-000000000004"),
      parts: [{ type: "text", text: "ready before pull" }],
      createdAt: "2026-07-27T00:00:00.000Z",
    },
  };
}

function scopedSubscriptionAcquisitionBody(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const registryReady = yield* Deferred.make<SubscriberRegistry>();
      const client = new TestClient(captureRegistrySession(registryReady));
      yield* client.connect();
      const registry = yield* Deferred.await(registryReady);
      const subscriptionScope = yield* Scope.make();
      const stream = yield* client
        .subscribeScoped(messageReceivedNotificationDefinition)
        .pipe(Scope.extend(subscriptionScope));
      const notification = receivedNotification();

      yield* registry.dispatch({
        definition: messageReceivedNotificationDefinition,
        method: messageReceivedNotificationDefinition.name,
        params: notification,
      });

      expect(yield* Stream.runHead(stream)).toEqual(Option.some(notification));

      const draining = yield* Stream.runCollect(stream).pipe(Effect.forkScoped);
      yield* Effect.yieldNow();
      expect(Option.isNone(yield* Fiber.poll(draining))).toBe(true);

      yield* Scope.close(subscriptionScope, Exit.void);
      expect(Chunk.isEmpty(yield* Fiber.join(draining))).toBe(true);
      yield* client.close();
    }),
  );
}

function readerExitSession(control: ReaderExitControls): OpenSession {
  return (options) =>
    Effect.gen(function* () {
      control.opens += 1;
      const scope = yield* ownerScope(options);
      yield* Scope.addFinalizer(scope, recordScopeClosed(control));
      return {
        write: writeNothing,
        reader:
          control.opens === 1 ? controlledReaderExit(control) : Effect.never,
        scope,
        client: connectClient,
      };
    });
}

function readerExitOrderingBody(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const endReader = yield* Deferred.make<undefined>();
    const scopeClosed = yield* Deferred.make<undefined>();
    const order: string[] = [];
    const controls: ReaderExitControls = {
      endReader,
      scopeClosed,
      order,
      opens: 0,
    };
    const client = new TestClient(readerExitSession(controls), () => {
      order.push("disconnect");
    });
    yield* client.connect();
    yield* Deferred.succeed(endReader, undefined);
    yield* Deferred.await(scopeClosed);
    expect(order).toEqual(["disconnect", "scope"]);
    expect(controls.opens).toBe(1);
    yield* client.connect();
    expect(controls.opens).toBe(2);
    yield* client.close();
  });
}

interface LateSessionControls {
  readonly closeRequest: Deferred.Deferred<Effect.Effect<void>>;
  readonly closeStarted: Deferred.Deferred<undefined>;
  readonly subscriberEnded: Deferred.Deferred<undefined>;
  readonly scopeClosed: Deferred.Deferred<undefined>;
  readonly counter: AuthCounter;
  finalizerRuns: number;
}

function sessionReturnedAfterClose(control: LateSessionControls): OpenSession {
  return (options) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* ownerScope(options);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            control.finalizerRuns += 1;
          }).pipe(
            Effect.zipRight(Deferred.succeed(control.scopeClosed, undefined)),
          ),
        );
        const closeEffect = yield* Deferred.await(control.closeRequest);
        yield* Effect.forkDaemon(
          Deferred.succeed(control.closeStarted, undefined).pipe(
            Effect.zipRight(closeEffect),
          ),
        );
        yield* restore(Deferred.await(control.subscriberEnded));
        return {
          write: writeNothing,
          reader: Effect.never,
          scope,
          client: countingConnectClient(control.counter),
        };
      }),
    );
}

function sessionReturnedAfterCloseBody(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const closeRequest = yield* Deferred.make<Effect.Effect<void>>();
      const closeStarted = yield* Deferred.make<undefined>();
      const subscriberEnded = yield* Deferred.make<undefined>();
      const scopeClosed = yield* Deferred.make<undefined>();
      const counter = { authCalls: 0 };
      const control: LateSessionControls = {
        closeRequest,
        closeStarted,
        subscriberEnded,
        scopeClosed,
        counter,
        finalizerRuns: 0,
      };
      const client = new TestClient(sessionReturnedAfterClose(control));
      yield* Deferred.succeed(closeRequest, client.close());
      yield* Effect.forkScoped(
        Stream.runDrain(
          client.subscribe(messageReceivedNotificationDefinition),
        ).pipe(
          Effect.onExit(() =>
            Deferred.succeed(subscriberEnded, undefined).pipe(Effect.asVoid),
          ),
        ),
      );
      yield* Effect.yieldNow();
      const connectExit = yield* Effect.exit(client.connect());
      yield* Deferred.await(closeStarted);
      yield* client.close();
      yield* Deferred.await(scopeClosed);
      expect(Exit.isFailure(connectExit)).toBe(true);
      expect(control.finalizerRuns).toBe(1);
      expect(counter.authCalls).toBe(0);
    }),
  );
}

interface OpeningDisconnectControls {
  readonly sessionStarted: Deferred.Deferred<undefined>;
  readonly releaseOpening: Deferred.Deferred<undefined>;
  readonly scopeFinalizing: Deferred.Deferred<undefined>;
  readonly releaseScope: Deferred.Deferred<undefined>;
  readonly counter: AuthCounter;
  finalizerRuns: number;
}

function interruptedOpening(control: OpeningDisconnectControls): OpenSession {
  return (options) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* ownerScope(options);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            control.finalizerRuns += 1;
          }).pipe(
            Effect.zipRight(
              Deferred.succeed(control.scopeFinalizing, undefined),
            ),
            Effect.zipRight(Deferred.await(control.releaseScope)),
          ),
        );
        yield* Deferred.succeed(control.sessionStarted, undefined);
        yield* restore(Deferred.await(control.releaseOpening));
        return {
          write: writeNothing,
          reader: Effect.never,
          scope,
          client: countingConnectClient(control.counter),
        };
      }),
    );
}

function disconnectDuringOpeningBody(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const sessionStarted = yield* Deferred.make<undefined>();
      const releaseOpening = yield* Deferred.make<undefined>();
      const scopeFinalizing = yield* Deferred.make<undefined>();
      const releaseScope = yield* Deferred.make<undefined>();
      const counter = { authCalls: 0 };
      const control: OpeningDisconnectControls = {
        sessionStarted,
        releaseOpening,
        scopeFinalizing,
        releaseScope,
        counter,
        finalizerRuns: 0,
      };
      const client = new TestClient(interruptedOpening(control));
      const connecting = yield* Effect.forkScoped(
        Effect.exit(client.connect()),
      );
      yield* Deferred.await(sessionStarted);

      const disconnecting = yield* Effect.forkScoped(client.disconnect());
      yield* Deferred.await(scopeFinalizing);
      const connectExit = yield* Fiber.join(connecting);
      expect(Exit.isFailure(connectExit)).toBe(true);
      expect(Option.isNone(yield* Fiber.poll(disconnecting))).toBe(true);
      expect(control.counter.authCalls).toBe(0);

      yield* Deferred.succeed(releaseScope, undefined);
      yield* Fiber.join(disconnecting);
      expect(control.finalizerRuns).toBe(1);
      expect(control.counter.authCalls).toBe(0);
      yield* client.close();
    }),
  );
}

interface FailureControls {
  readonly scopeFinalizing: Deferred.Deferred<undefined>;
  readonly releaseScope: Deferred.Deferred<undefined>;
  finalizerRuns: number;
}

function failingOpening(control: FailureControls): OpenSession {
  return (options) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* ownerScope(options);
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            control.finalizerRuns += 1;
          }).pipe(
            Effect.zipRight(
              Deferred.succeed(control.scopeFinalizing, undefined),
            ),
            Effect.zipRight(Deferred.await(control.releaseScope)),
          ),
        );
        return yield* restore(
          Effect.fail(new NotConnectedError({ message: "open failed" })),
        );
      }),
    );
}

function openingFailureCleanupBody(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const scopeFinalizing = yield* Deferred.make<undefined>();
      const releaseScope = yield* Deferred.make<undefined>();
      const control: FailureControls = {
        scopeFinalizing,
        releaseScope,
        finalizerRuns: 0,
      };
      const client = new TestClient(failingOpening(control));
      const connecting = yield* Effect.forkScoped(
        Effect.exit(client.connect()),
      );
      yield* Deferred.await(scopeFinalizing);
      expect(Option.isNone(yield* Fiber.poll(connecting))).toBe(true);
      yield* Deferred.succeed(releaseScope, undefined);
      const connectExit = yield* Fiber.join(connecting);
      expect(Exit.isFailure(connectExit)).toBe(true);
      expect(control.finalizerRuns).toBe(1);
      yield* client.close();
    }),
  );
}

function readerWinsCloseRaceBody(): Effect.Effect<void, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const scopeFinalizing = yield* Deferred.make<undefined>();
      const releaseScope = yield* Deferred.make<undefined>();
      const endReader = yield* Deferred.make<undefined>();
      const control: CloseControls = {
        scopeFinalizing,
        releaseScope,
        finalizerRuns: 0,
        writes: 0,
      };
      const session: OpenSession = (options) =>
        Effect.gen(function* () {
          const scope = yield* ownerScope(options);
          yield* Scope.addFinalizer(scope, closeGateFinalizer(control));
          return {
            write: () => recordWrite(control),
            reader: Deferred.await(endReader).pipe(Effect.asVoid),
            scope,
            client: connectClient,
          };
        });
      const client = new TestClient(session);
      yield* client.connect();
      yield* Deferred.succeed(endReader, undefined);
      yield* Deferred.await(scopeFinalizing);
      const closing = yield* Effect.forkScoped(client.close());
      yield* Effect.yieldNow();
      expect(Option.isNone(yield* Fiber.poll(closing))).toBe(true);
      yield* Deferred.succeed(releaseScope, undefined);
      yield* Fiber.join(closing);
      expect(control.finalizerRuns).toBe(1);
      expect(control.writes).toBe(0);
    }),
  );
}

function warningSession(): OpenSession {
  return () =>
    Effect.logWarning(CLIENT_WARNING_MARKER).pipe(
      Effect.zipRight(
        Effect.fail(
          new NotConnectedError({ message: "expected open failure" }),
        ),
      ),
    );
}

function clientWarningsUseStderrBody(): Effect.Effect<void, unknown> {
  return Effect.acquireUseRelease(
    Effect.sync(() => ({
      stdout: vi.spyOn(console, "log").mockImplementation(() => undefined),
      stderr: vi.spyOn(console, "error").mockImplementation(() => undefined),
    })),
    ({ stdout, stderr }) =>
      Effect.gen(function* () {
        const client = new TestClient(warningSession());
        yield* Effect.exit(client.connect());
        yield* client.close();
        const stdoutText = stdout.mock.calls.flat().join("\n");
        const stderrText = stderr.mock.calls.flat().join("\n");
        expect(stdoutText).not.toContain(CLIENT_WARNING_MARKER);
        expect(stderrText).toContain(CLIENT_WARNING_MARKER);
      }),
    ({ stdout, stderr }) =>
      Effect.sync(() => {
        stdout.mockRestore();
        stderr.mockRestore();
      }),
  );
}

interface SessionControls {
  opens: number;
  finalizerRuns: number;
}

function countedSession(control: SessionControls): OpenSession {
  return (options) =>
    Effect.gen(function* () {
      control.opens += 1;
      const scope = yield* ownerScope(options);
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          control.finalizerRuns += 1;
        }),
      );
      return {
        write: writeNothing,
        reader: Effect.never,
        scope,
        client: connectClient,
      };
    });
}

function terminalCloseBody(): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const counter: SessionControls = { opens: 0, finalizerRuns: 0 };
    const client = new TestClient(countedSession(counter));
    yield* client.connect();
    yield* client.close();
    yield* client.disconnect();
    expect(Exit.isFailure(yield* Effect.exit(client.connect()))).toBe(true);
    expect(counter.opens).toBe(1);
    expect(counter.finalizerRuns).toBe(1);
  });
}

// @agent-code-guard/regression-only: controlled scopes expose lifecycle completion and callback order directly; randomized schedules cannot assert these exact causal boundaries.
describe("ProtocolClientLifecycle", () => {
  it("acquires a scoped subscription before exposing its Stream", () =>
    Effect.runPromise(scopedSubscriptionAcquisitionBody()));

  it("awaits subscriber closure and connection finalizers for every close caller", () =>
    Effect.runPromise(awaitedCloseBody()));

  it("awaits reader and scope cleanup before disconnect completes", () =>
    Effect.runPromise(awaitedDisconnectBody()));

  it("announces reader exit and reconnects only when explicitly requested", () =>
    Effect.runPromise(readerExitOrderingBody()));

  it("does not install opening work after close claims its token", () =>
    Effect.runPromise(sessionReturnedAfterCloseBody()));

  it("interrupts opening work and awaits its finalizers before disconnect returns", () =>
    Effect.runPromise(disconnectDuringOpeningBody()));

  it("awaits scope cleanup when opening fails", () =>
    Effect.runPromise(openingFailureCleanupBody()));

  it("awaits reader-owned cleanup when reader exit wins the close race", () =>
    Effect.runPromise(readerWinsCloseRaceBody()));

  it("makes close terminal", () => Effect.runPromise(terminalCloseBody()));

  it("routes client warnings away from stdout", () =>
    Effect.runPromise(clientWarningsUseStderrBody()));
});
/* eslint-enable sonarjs/no-nested-functions -- controlled lifecycle tests end here -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. -- Restore strict defaults after the scoped exception. */
