/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, sonarjs/no-nested-functions, sonarjs/assertions-in-tests, agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals -- Lifecycle regressions keep each ownership timeline and its assertions together. */

import { it as effectIt } from "@effect/vitest";
import { ConversationId } from "@moltzap/client";
import { AgentName } from "@moltzap/identity";
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentKeyString,
  messageId,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import {
  Duration,
  Data,
  Effect,
  Exit,
  Layer,
  Logger,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import { assert, describe } from "vitest";
import { messageDatabasePathForVolume } from "./messages.js";
import {
  RouterProvider,
  routerSequence,
  type EndpointTransport,
  type MessageParts,
} from "../router.js";
import { routerProviderLayer } from "../driver.js";
import {
  serverProcessRouterOperationsLayer,
  renderServerProcessConfiguration,
  SERVER_CONTAINER_PORT,
  type ServerProcessRouterOperations,
} from "./process.js";

const it = effectIt.scoped;
const STARTUP_TIMEOUT = Duration.seconds(2);
const ADVERTISED_SERVER_URL = serverBaseUrl(
  "ws://moltzap-router.run.svc.cluster.local:3000/ws",
);
const LOOPBACK_SERVER_URL = serverBaseUrl("ws://127.0.0.1:3000/ws");
const RUN_DIRECTORY = "/controller/run/router";
const DATABASE_PATH = messageDatabasePathForVolume(RUN_DIRECTORY);
const CONFIGURATION_PATH = `${RUN_DIRECTORY}/moltzap.yaml`;
const BINARY = "/installed/server-core/bin/moltzap-server";
const PROCESS_HANDLE = "owned-server-process";
const ALICE = Schema.decodeUnknownSync(AgentName)("alice");
const PROBE = Schema.decodeUnknownSync(AgentName)("probe");
const ALICE_ID = agentId("00000000-0000-4000-8000-000000000001");
const PROBE_ID = agentId("00000000-0000-4000-8000-000000000002");
const ALICE_KEY = redactedAgentKey(agentKeyString(41));
const PROBE_KEY = redactedAgentKey(agentKeyString(42));
const CONVERSATION_ID = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000003",
);
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000004");

const MESSAGE_PARTS: MessageParts = [{ type: "text", text: "committed" }];

const committedMessages = [
  {
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    senderId: ALICE_ID,
    routerSequence: routerSequence(7),
    parts: MESSAGE_PARTS,
    createdAtMillis: 1_700_000_000_000,
  },
];

const transport: EndpointTransport = {
  received: Stream.empty,
  openConversation: () => Effect.never,
  send: () => Effect.never,
};

interface FakeState {
  readonly calls: string[];
  readonly failures: Map<string, number>;
  readonly registrationSecrets: Redacted.Redacted[];
  processSecret?: Redacted.Redacted;
}

interface FakeHarness {
  readonly state: FakeState;
  readonly operations: ServerProcessRouterOperations<string>;
}

class FakeOperationFailed extends Data.TaggedError("FakeOperationFailed")<{
  readonly detail: string;
}> {
  override get message(): string {
    return this.detail;
  }
}

function fakeStep<A>(
  state: FakeState,
  operation: string,
  value: A,
): Effect.Effect<A, FakeOperationFailed> {
  return Effect.suspend(() => {
    state.calls.push(operation);
    const remaining = state.failures.get(operation) ?? 0;
    if (remaining === 0) {
      return Effect.succeed(value);
    }
    state.failures.set(operation, remaining - 1);
    const sensitiveDetail =
      state.processSecret === undefined
        ? "no-secret-created"
        : Redacted.value(state.processSecret);
    return Effect.fail(
      new FakeOperationFailed({
        detail: `fake ${operation} failure contains ${sensitiveDetail}`,
      }),
    );
  });
}

function makeFakeHarness(
  failures: ReadonlyArray<readonly [string, number]> = [],
): FakeHarness {
  const state: FakeState = {
    calls: [],
    failures: new Map(failures),
    registrationSecrets: [],
    processSecret: undefined,
  };
  const identities = new Map([
    [ALICE, { agentId: ALICE_ID, key: ALICE_KEY }],
    [PROBE, { agentId: PROBE_ID, key: PROBE_KEY }],
  ]);
  const operations: ServerProcessRouterOperations<string> = {
    cleanupTimeout: STARTUP_TIMEOUT,
    resolveBinary: fakeStep(state, "binary.resolve", BINARY),
    createRunDirectory: fakeStep(state, "run-directory.create", RUN_DIRECTORY),
    writeConfiguration: (runDirectory, input) =>
      Effect.sync(() => {
        assert.strictEqual(runDirectory, RUN_DIRECTORY);
        assert.strictEqual(input.databasePath, DATABASE_PATH);
        assert.strictEqual(input.port, SERVER_CONTAINER_PORT);
      }).pipe(
        Effect.zipRight(
          fakeStep(state, "configuration.write", CONFIGURATION_PATH),
        ),
      ),
    startProcess: (input) =>
      Effect.sync(() => {
        assert.strictEqual(input.binary, BINARY);
        assert.strictEqual(input.configurationPath, CONFIGURATION_PATH);
        assert.strictEqual(input.runDirectory, RUN_DIRECTORY);
        state.processSecret = input.registrationSecret;
      }).pipe(
        Effect.zipRight(fakeStep(state, "process.start", PROCESS_HANDLE)),
      ),
    awaitHealthy: (address, startupTimeout) =>
      Effect.sync(() => {
        assert.strictEqual(address, LOOPBACK_SERVER_URL);
        assert.strictEqual(
          Duration.toMillis(startupTimeout),
          Duration.toMillis(STARTUP_TIMEOUT),
        );
      }).pipe(Effect.zipRight(fakeStep(state, "health.await", undefined))),
    register: (address, name, registrationSecret) =>
      Effect.sync(() => {
        assert.strictEqual(address, LOOPBACK_SERVER_URL);
        state.registrationSecrets.push(registrationSecret);
      }).pipe(
        Effect.zipRight(
          fakeStep(
            state,
            `identity.register:${name}`,
            identities.get(name) ?? { agentId: ALICE_ID, key: ALICE_KEY },
          ),
        ),
      ),
    attachEndpoint: (address, key) =>
      Effect.gen(function* () {
        assert.strictEqual(address, LOOPBACK_SERVER_URL);
        assert.strictEqual(key, PROBE_KEY);
        state.calls.push("endpoint.attach");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            state.calls.push("endpoint.release");
          }),
        );
        return transport;
      }),
    stopProcess: (handle) =>
      Effect.sync(() => {
        assert.strictEqual(handle, PROCESS_HANDLE);
      }).pipe(Effect.zipRight(fakeStep(state, "process.stop", undefined))),
    readCommittedMessages: (databasePath) =>
      Effect.sync(() => {
        assert.strictEqual(databasePath, DATABASE_PATH);
      }).pipe(
        Effect.zipRight(fakeStep(state, "messages.read", committedMessages)),
      ),
    removeRunDirectory: (runDirectory) =>
      Effect.sync(() => {
        assert.strictEqual(runDirectory, RUN_DIRECTORY);
      }).pipe(
        Effect.zipRight(fakeStep(state, "run-directory.remove", undefined)),
      ),
  };
  return { state, operations };
}

function provider(harness: FakeHarness) {
  return RouterProvider.pipe(
    Effect.provide(
      routerProviderLayer({ startupTimeout: STARTUP_TIMEOUT }).pipe(
        Layer.provide(
          serverProcessRouterOperationsLayer(
            ADVERTISED_SERVER_URL,
            harness.operations,
          ),
        ),
      ),
    ),
  );
}

function count(calls: readonly string[], operation: string): number {
  return calls.filter((entry) => entry === operation).length;
}

function rawProcessSecret(state: FakeState): string {
  return state.processSecret === undefined
    ? ""
    : Redacted.value(state.processSecret);
}

describe("controller MoltZap server process", () => {
  it("uses loopback inside the controller while advertising the Service to agents", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness();
      const scope = yield* Scope.make();
      const routerProvider = yield* provider(harness);
      const router = yield* routerProvider.acquire.pipe(Scope.extend(scope));
      const alice = yield* router
        .attachAgent("alice", ALICE)
        .pipe(Scope.extend(scope));
      const probe = yield* router
        .attachEndpoint("probe", PROBE)
        .pipe(Scope.extend(scope));

      assert.strictEqual(router.address, ADVERTISED_SERVER_URL);
      assert.strictEqual(alice.routerUrl, ADVERTISED_SERVER_URL);
      assert.strictEqual(alice.agent.id, ALICE_ID);
      assert.strictEqual(probe.participant.id, PROBE_ID);
      assert.strictEqual(harness.state.registrationSecrets.length, 2);
      assert.strictEqual(
        harness.state.registrationSecrets.every(
          (secret) => secret === harness.state.processSecret,
        ),
        true,
      );

      yield* Scope.close(scope, Exit.void);

      const stopped = yield* router.stopped;
      assert.deepStrictEqual(stopped.committedMessages, committedMessages);
      assert.deepStrictEqual(harness.state.calls, [
        "binary.resolve",
        "run-directory.create",
        "configuration.write",
        "process.start",
        "health.await",
        "identity.register:alice",
        "identity.register:probe",
        "endpoint.attach",
        "endpoint.release",
        "process.stop",
        "messages.read",
        "run-directory.remove",
      ]);
    }));

  it("stops the child and removes its data when readiness fails", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness([["health.await", 1]]);
      const routerProvider = yield* provider(harness);
      const failure = yield* Effect.scoped(routerProvider.acquire).pipe(
        Effect.flip,
      );
      const rawSecret = rawProcessSecret(harness.state);

      assert.strictEqual(failure.operation, "acquire-router");
      assert.notInclude(failure.detail, rawSecret);
      assert.notInclude(failure.message, rawSecret);
      assert.deepStrictEqual(harness.state.calls, [
        "binary.resolve",
        "run-directory.create",
        "configuration.write",
        "process.start",
        "health.await",
        "process.stop",
        "run-directory.remove",
      ]);
    }));

  it("retains the store and skips collection when termination is unconfirmed", () =>
    Effect.gen(function* () {
      const harness = makeFakeHarness([["process.stop", 2]]);
      const scope = yield* Scope.make();
      const routerProvider = yield* provider(harness);
      const router = yield* routerProvider.acquire.pipe(Scope.extend(scope));
      const logs: string[] = [];
      const logger = Logger.make(({ message }) => {
        logs.push(String(message));
      });

      yield* Scope.close(scope, Exit.void).pipe(
        Effect.provide(Logger.replace(Logger.defaultLogger, logger)),
      );
      const stopped = yield* router.stopped.pipe(Effect.flip);
      const rawSecret = rawProcessSecret(harness.state);

      assert.strictEqual(stopped.operation, "stop-router");
      assert.notInclude(stopped.detail, rawSecret);
      assert.strictEqual(count(harness.state.calls, "process.stop"), 2);
      assert.strictEqual(count(harness.state.calls, "messages.read"), 0);
      assert.strictEqual(count(harness.state.calls, "run-directory.remove"), 0);
      assert.strictEqual(
        logs.some((message) => message.includes(rawSecret)),
        false,
      );
    }));

  it("renders a persistent PGlite config with only an env secret reference", () =>
    Effect.sync(() => {
      const secret = "must-not-appear-in-config";
      const configuration = renderServerProcessConfiguration({
        databasePath: DATABASE_PATH,
        port: SERVER_CONTAINER_PORT,
      });

      assert.include(configuration, "port: 3000");
      assert.include(configuration, `data_dir: "${DATABASE_PATH}"`);
      assert.include(configuration, 'secret: "${MOLTZAP_REGISTRATION_SECRET}"');
      assert.notInclude(configuration, secret);
    }));
});

/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, sonarjs/no-nested-functions, sonarjs/assertions-in-tests, agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals -- Restore strict defaults after lifecycle regressions. */
