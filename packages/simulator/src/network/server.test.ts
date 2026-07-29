/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, sonarjs/assertions-in-tests, agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals -- regression-only lifecycle suite: each case fixes one ownership transition or cleanup ordering guarantee. Assertions run inside Effect generators, and the timelines remain together so interruption and release order stay auditable. */
import { it as effectIt } from "@effect/vitest";
import { AgentName } from "@moltzap/protocol/identity";
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentKeyString,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import {
  Cause,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Logger,
  Schema,
  Scope,
  Redacted,
  TestClock,
} from "effect";
import { assert, describe } from "vitest";
import {
  type MoltZapPresenceObserver,
  type MoltZapServerOperations,
  MoltZapServerFailed,
  makeMoltZapServerAcquirer,
} from "./server.js";
import { imageDigest, moltZapServerRunArgs } from "./server-image.js";

const it = effectIt.scoped;
const IMAGE_TEXT = `sha256:${"a".repeat(64)}`;
const IMAGE = imageDigest(IMAGE_TEXT);
const SERVER_URL = serverBaseUrl("ws://127.0.0.1:49152/ws");
const VOLUME_PATH = "/owned/moltzap-server-test";
const CONTAINER_ID = "container-id";
const AGENT_ID = agentId("00000000-0000-4000-8000-000000000001");
const AGENT_KEY = redactedAgentKey(agentKeyString(31));
const READY_TIMEOUT = Duration.seconds(1);
const ALICE = Schema.decodeSync(AgentName)("alice");

class FakeOperationFailed extends Data.TaggedError("FakeOperationFailed")<{
  readonly operation: string;
}> {}

interface FakeState {
  readonly calls: Array<string>;
  readonly failures: Map<string, number>;
  readonly registrationSecrets: Array<Redacted.Redacted<string>>;
  readonly startedNames: Array<string>;
  readonly stoppedNames: Array<string>;
  containerSecret: Redacted.Redacted<string> | undefined;
}

interface FakeHarness {
  readonly state: FakeState;
  readonly operations: MoltZapServerOperations;
}

function fakeStep<A>(
  state: FakeState,
  operation: string,
  value: A,
): Effect.Effect<A, FakeOperationFailed> {
  return Effect.suspend(() => {
    state.calls.push(operation);
    const remaining = state.failures.get(operation) ?? 0;
    if (remaining > 0) {
      state.failures.set(operation, remaining - 1);
      return Effect.fail(new FakeOperationFailed({ operation }));
    }
    return Effect.succeed(value);
  });
}

function makeFakeHarness(
  failures: ReadonlyArray<readonly [string, number]> = [],
): FakeHarness {
  const state: FakeState = {
    calls: [],
    failures: new Map(failures),
    registrationSecrets: [],
    startedNames: [],
    stoppedNames: [],
    containerSecret: undefined,
  };
  const observer: MoltZapPresenceObserver = {
    awaitAgentReady: () => Effect.void,
    connect: fakeStep(state, "observer.connect", undefined),
    close: fakeStep(state, "observer.close", undefined),
  };
  const operations: MoltZapServerOperations = {
    cleanupTimeout: READY_TIMEOUT,
    resolveImage: () => fakeStep(state, "image.resolve", IMAGE),
    createVolume: fakeStep(state, "volume.create", VOLUME_PATH),
    removeVolume: () => fakeStep(state, "volume.remove", undefined),
    startContainer: (_image, _volumePath, containerName, registrationSecret) =>
      Effect.sync(() => {
        state.startedNames.push(containerName);
        state.containerSecret = registrationSecret;
      }).pipe(
        Effect.zipRight(fakeStep(state, "container.start", CONTAINER_ID)),
      ),
    resolveServerUrl: () => fakeStep(state, "port.resolve", SERVER_URL),
    awaitHealthy: () => fakeStep(state, "health.await", undefined),
    verifyMount: () => fakeStep(state, "mount.verify", undefined),
    register: (_serverUrl, name, registrationSecret) =>
      Effect.sync(() => {
        state.registrationSecrets.push(registrationSecret);
      }).pipe(
        Effect.zipRight(
          fakeStep(state, `identity.register:${name}`, {
            agentId: AGENT_ID,
            key: AGENT_KEY,
          }),
        ),
      ),
    createObserver: () => fakeStep(state, "observer.create", observer),
    stopContainer: (containerName) =>
      Effect.sync(() => {
        state.stoppedNames.push(containerName);
      }).pipe(Effect.zipRight(fakeStep(state, "container.stop", undefined))),
  };
  return { state, operations };
}

function count(calls: ReadonlyArray<string>, operation: string): number {
  return calls.filter((entry) => entry === operation).length;
}

describe("MoltZap server", () => {
  it("owns registration, explicit stop, and volume release in that order", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const acquire = makeMoltZapServerAcquirer(harness.operations);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* acquire({
            image: IMAGE,
            readyTimeout: READY_TIMEOUT,
          });
          const identity = yield* server.register(ALICE);
          yield* server.awaitAgentReady(identity.agentId, READY_TIMEOUT);
          assert.strictEqual(identity.agentId, AGENT_ID);
          assert.strictEqual(identity.key, AGENT_KEY);
          assert.strictEqual(server.image, IMAGE);
          assert.strictEqual(server.serverUrl, SERVER_URL);
          assert.strictEqual(
            server.messageDatabasePath,
            `${VOLUME_PATH}/pglite`,
          );
          assert.strictEqual(harness.state.registrationSecrets.length, 2);
          assert.strictEqual(
            harness.state.registrationSecrets.every(
              (secret) => secret === harness.state.containerSecret,
            ),
            true,
          );

          yield* server.stop();
          yield* server.stop();
          assert.strictEqual(count(harness.state.calls, "observer.close"), 1);
          assert.strictEqual(count(harness.state.calls, "container.stop"), 1);
          assert.strictEqual(count(harness.state.calls, "volume.remove"), 0);
        }),
      );

      assert.strictEqual(count(harness.state.calls, "volume.remove"), 1);
      assert.deepStrictEqual(
        harness.state.stoppedNames,
        harness.state.startedNames,
      );
      assert.deepStrictEqual(harness.state.calls.slice(-3), [
        "observer.close",
        "container.stop",
        "volume.remove",
      ]);
    }));

  it("reports the long acquisition stages through the Effect logger", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const acquire = makeMoltZapServerAcquirer(harness.operations);
      const messages: Array<string> = [];
      const logger = Logger.make(({ message }) => {
        messages.push(String(message));
      });

      yield* Effect.scoped(
        acquire({
          image: IMAGE,
          readyTimeout: READY_TIMEOUT,
        }),
      ).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, logger)));

      assert.deepStrictEqual(messages, [
        "Preparing the MoltZap router image; the first build can take several minutes",
        "MoltZap router image ready",
        "Starting an isolated MoltZap router",
        "MoltZap router ready",
      ]);
    }));

  it("normalizes observer readiness failures at the server boundary", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const observer: MoltZapPresenceObserver = {
        awaitAgentReady: () => Effect.fail("presence query failed"),
        connect: Effect.void,
        close: fakeStep(harness.state, "observer.close", undefined),
      };
      const acquire = makeMoltZapServerAcquirer({
        ...harness.operations,
        createObserver: () =>
          fakeStep(harness.state, "observer.create", observer),
      });

      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* acquire({
            image: IMAGE,
            readyTimeout: READY_TIMEOUT,
          });
          return yield* server
            .awaitAgentReady(AGENT_ID, READY_TIMEOUT)
            .pipe(Effect.flip);
        }),
      );

      assert.instanceOf(failure, MoltZapServerFailed);
      assert.strictEqual(failure.operation, "await-agent-ready");
      assert.match(failure.detail, /presence query failed/u);
    }));

  it("recovers a possibly-created container by its pre-known name", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness([["container.start", 1]]);
      const acquire = makeMoltZapServerAcquirer(harness.operations);

      const error = yield* Effect.scoped(
        acquire({
          image: IMAGE,
          readyTimeout: READY_TIMEOUT,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, MoltZapServerFailed);
      assert.strictEqual(error.operation, "start-container");
      assert.strictEqual(harness.state.startedNames.length, 1);
      assert.deepStrictEqual(
        harness.state.stoppedNames,
        harness.state.startedNames,
      );
      assert.deepStrictEqual(harness.state.calls, [
        "image.resolve",
        "volume.create",
        "container.start",
        "container.stop",
        "volume.remove",
      ]);
    }));

  it("reverses observer, container, and volume after observer connect fails", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness([["observer.connect", 1]]);
      const acquire = makeMoltZapServerAcquirer(harness.operations);

      const error = yield* Effect.scoped(
        acquire({
          readyTimeout: READY_TIMEOUT,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, MoltZapServerFailed);
      assert.strictEqual(error.operation, "connect-observer");
      assert.deepStrictEqual(harness.state.calls.slice(-3), [
        "observer.close",
        "container.stop",
        "volume.remove",
      ]);
    }));

  it("reverses claimed resources before preserving acquisition interruption", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const healthEntered = yield* Deferred.make<void>();
      const operations: MoltZapServerOperations = {
        ...harness.operations,
        awaitHealthy: () =>
          Deferred.succeed(healthEntered, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
      };
      const acquire = makeMoltZapServerAcquirer(operations);
      const acquisition = yield* Effect.scoped(
        acquire({
          readyTimeout: READY_TIMEOUT,
        }),
      ).pipe(Effect.fork);

      yield* Deferred.await(healthEntered);
      const exit = yield* Fiber.interrupt(acquisition);

      assert.strictEqual(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        assert.strictEqual(Cause.isInterruptedOnly(exit.cause), true);
      }
      assert.deepStrictEqual(harness.state.calls.slice(-2), [
        "container.stop",
        "volume.remove",
      ]);
    }));

  it("interrupts a timed-out observer connection before cleaning resources", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const connectEntered = yield* Deferred.make<void>();
      const connectInterrupted = yield* Deferred.make<void>();
      const observer: MoltZapPresenceObserver = {
        awaitAgentReady: () => Effect.void,
        connect: Deferred.succeed(connectEntered, undefined).pipe(
          Effect.zipRight(Effect.never),
          Effect.onInterrupt(() =>
            Deferred.succeed(connectInterrupted, undefined).pipe(Effect.asVoid),
          ),
        ),
        close: fakeStep(harness.state, "observer.close", undefined),
      };
      const operations: MoltZapServerOperations = {
        ...harness.operations,
        createObserver: () =>
          fakeStep(harness.state, "observer.create", observer),
      };
      const acquire = makeMoltZapServerAcquirer(operations);
      const acquisition = yield* Effect.scoped(
        acquire({
          image: IMAGE,
          readyTimeout: READY_TIMEOUT,
        }),
      ).pipe(Effect.fork);

      yield* Deferred.await(connectEntered);
      yield* TestClock.adjust(READY_TIMEOUT);
      const error = yield* Fiber.join(acquisition).pipe(Effect.flip);
      yield* Deferred.await(connectInterrupted);

      assert.instanceOf(error, MoltZapServerFailed);
      assert.strictEqual(error.operation, "connect-observer");
      assert.strictEqual(count(harness.state.calls, "observer.close"), 1);
      assert.strictEqual(count(harness.state.calls, "container.stop"), 1);
      assert.strictEqual(count(harness.state.calls, "volume.remove"), 1);
    }));

  it("interrupts timed-out cleanup before retrying the owned resource", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const closeEntered = yield* Deferred.make<void>();
      const closeInterrupted = yield* Deferred.make<void>();
      let closeAttempts = 0;
      const observer: MoltZapPresenceObserver = {
        awaitAgentReady: () => Effect.void,
        connect: Effect.void,
        close: Effect.suspend(() => {
          closeAttempts += 1;
          harness.state.calls.push("observer.close");
          return closeAttempts === 1
            ? Deferred.succeed(closeEntered, undefined).pipe(
                Effect.zipRight(Effect.never),
                Effect.onInterrupt(() =>
                  Deferred.succeed(closeInterrupted, undefined).pipe(
                    Effect.asVoid,
                  ),
                ),
              )
            : Effect.void;
        }),
      };
      const operations: MoltZapServerOperations = {
        ...harness.operations,
        createObserver: () =>
          fakeStep(harness.state, "observer.create", observer),
      };
      const acquire = makeMoltZapServerAcquirer(operations);
      const scope = yield* Scope.make();
      const server = yield* acquire({
        image: IMAGE,
        readyTimeout: READY_TIMEOUT,
      }).pipe(Scope.extend(scope));
      const stopping = yield* server.stop().pipe(Effect.fork);

      yield* Deferred.await(closeEntered);
      yield* TestClock.adjust(READY_TIMEOUT);
      yield* Fiber.join(stopping);
      yield* Deferred.await(closeInterrupted);

      assert.strictEqual(closeAttempts, 1);
      assert.strictEqual(count(harness.state.calls, "container.stop"), 1);
      assert.strictEqual(count(harness.state.calls, "volume.remove"), 0);

      yield* Scope.close(scope, Exit.void);

      assert.strictEqual(closeAttempts, 2);
      assert.strictEqual(count(harness.state.calls, "container.stop"), 1);
      assert.strictEqual(count(harness.state.calls, "volume.remove"), 1);
    }));

  it("keeps traffic-safe stop successful when observer cleanup needs retry", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness([["observer.close", 1]]);
      const acquire = makeMoltZapServerAcquirer(harness.operations);

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* acquire({
            readyTimeout: READY_TIMEOUT,
          });
          yield* server.stop();
          assert.strictEqual(count(harness.state.calls, "volume.remove"), 0);
        }),
      );

      assert.strictEqual(count(harness.state.calls, "observer.close"), 2);
      assert.strictEqual(count(harness.state.calls, "container.stop"), 1);
      assert.strictEqual(count(harness.state.calls, "volume.remove"), 1);
    }));

  it("retains the volume when repeated container stop cannot be confirmed", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness([["container.stop", 2]]);
      const acquire = makeMoltZapServerAcquirer(harness.operations);

      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* acquire({
            readyTimeout: READY_TIMEOUT,
          });
          return yield* server.stop().pipe(Effect.flip);
        }),
      );

      assert.instanceOf(failure, MoltZapServerFailed);
      assert.strictEqual(failure.operation, "cleanup");
      assert.match(failure.detail, /remained running/u);
      assert.strictEqual(count(harness.state.calls, "container.stop"), 2);
      assert.strictEqual(count(harness.state.calls, "volume.remove"), 0);
    }));

  it("constructs a loopback random-port server with no OTLP or MCP inputs", () =>
    Effect.sync(() => {
      const args = moltZapServerRunArgs(
        IMAGE_TEXT,
        VOLUME_PATH,
        "named-container",
      );
      assert.deepStrictEqual(args, [
        "docker",
        "run",
        "--detach",
        "--rm",
        "--label",
        "moltzap-simulator-run=1",
        "--label",
        "moltzap-simulator-run-id=named-container",
        "--name",
        "named-container",
        "--publish",
        "127.0.0.1:0:3000",
        "--volume",
        `${VOLUME_PATH}:/data`,
        "--env",
        "MOLTZAP_REGISTRATION_SECRET",
        IMAGE_TEXT,
      ]);
      assert.strictEqual(
        args.some((part) => part.includes("OTEL")),
        false,
      );
      assert.strictEqual(
        args.some((part) => part.includes("MCP")),
        false,
      );
    }));
});
