import { assert, it as effectIt } from "@effect/vitest";
import {
  ExitCode as processExitCode,
  type ExitCode,
} from "@effect/platform/CommandExecutor";
import { type AgentConnection, makeAgentHandle } from "../../network.js";
import { RuntimeExited, RuntimeFailed } from "../runtime.js";
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentName,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { describe } from "vitest";
import { RuntimeAcquisitionFailed } from "../process.js";
import { expireStartupDeadline } from "../process.test-utils.js";
import type { InstallMode } from "../packages.js";
import type { NanoclawGatewaySession } from "./gateway.js";
import {
  makeNanoclawRuntimeWith,
  type NanoclawProcessInput,
  type NanoclawRuntimeDriver,
  type NanoclawRuntimeOptions,
} from "./runtime.js";

const test = effectIt.effect;
const ROSTER_KEY = "alice";
const AGENT_NAME = agentName(ROSTER_KEY);
const AGENT_KEY_TEXT =
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000";
const AGENT_KEY_REDACTION_MARKER = "[REDACTED:agent-key]";
const AGENT_ID = agentId("00000000-0000-4000-8000-000000000001");
const AGENT_KEY = redactedAgentKey(AGENT_KEY_TEXT);
const READY_OUTPUT = 'level=INFO message="MoltZap connected" channel=moltzap';
const ROUTER_URL = serverBaseUrl("http://127.0.0.1:43123");
const PROCESS_EXIT_CODE = 23;
// `awaitProcessReady` polls readiness on a fixed interval, and expiring this
// budget on the test clock costs one round of real timers per poll it covers.
// A small multiple of that interval still exercises repeated polling.
const STARTUP_TIMEOUT = Duration.millis(500);
const MODEL_ID = "test/model";
const PROCESS_WAIT_FAILURE = "process wait failed";
type ProcessWaitFailure = typeof PROCESS_WAIT_FAILURE;

interface FakeInstall {
  readonly mode: InstallMode;
}

interface FakeHandle {
  readonly exitCode: Deferred.Deferred<ExitCode, ProcessWaitFailure>;
  readonly output: string;
}

interface Fixture {
  readonly runtime: ReturnType<
    typeof makeNanoclawRuntimeWith<FakeInstall, FakeHandle, ProcessWaitFailure>
  >;
  readonly processInput: Deferred.Deferred<NanoclawProcessInput>;
  readonly gatewayAvailable: Deferred.Deferred<undefined>;
  readonly gatewayWithin: Deferred.Deferred<Duration.Duration>;
  readonly handle: FakeHandle;
  readonly teardownCount: Ref.Ref<number>;
}

interface FakeDriverInput {
  readonly processInput: Deferred.Deferred<NanoclawProcessInput>;
  readonly gatewayAvailable: Deferred.Deferred<undefined>;
  readonly gatewayWithin: Deferred.Deferred<Duration.Duration>;
  readonly handle: FakeHandle;
  readonly teardownCount: Ref.Ref<number>;
}

const connection: AgentConnection<"alice"> = {
  agent: makeAgentHandle(ROSTER_KEY, AGENT_ID),
  key: AGENT_KEY,
  routerUrl: ROUTER_URL,
};

function makeFakeDriver(
  input: FakeDriverInput,
): NanoclawRuntimeDriver<FakeInstall, FakeHandle, ProcessWaitFailure> {
  const gatewaySession: NanoclawGatewaySession = {
    gateway: {
      submit: () => Effect.void,
      outputs: Stream.empty,
    },
    failure: Effect.never,
  };
  return {
    resolveInstallMode: (requested) => Effect.succeed(requested ?? "workspace"),
    install: (mode) => Effect.succeed({ mode }),
    start: (process) =>
      Deferred.succeed(input.processInput, process).pipe(
        Effect.as(input.handle),
      ),
    stop: (running) =>
      Ref.update(input.teardownCount, (count) => count + 1).pipe(
        Effect.zipRight(Deferred.succeed(running.exitCode, processExitCode(0))),
        Effect.asVoid,
      ),
    gateway: (running, within) =>
      Effect.succeed(running).pipe(
        Effect.zipRight(Deferred.succeed(input.gatewayWithin, within)),
        Effect.zipRight(Deferred.await(input.gatewayAvailable)),
        Effect.as(gatewaySession),
      ),
    exitCode: (running) => Deferred.await(running.exitCode),
    output: (running) => running.output,
    readyWhen: (output) => output.includes("MoltZap connected"),
  };
}

function makeFixture(
  options: NanoclawRuntimeOptions,
  output = READY_OUTPUT,
  gatewayStartsReady = true,
): Effect.Effect<Fixture> {
  return Effect.gen(function* () {
    const processInput = yield* Deferred.make<NanoclawProcessInput>();
    const gatewayAvailable = yield* Deferred.make<undefined>();
    const gatewayWithin = yield* Deferred.make<Duration.Duration>();
    if (gatewayStartsReady) {
      yield* Deferred.succeed(gatewayAvailable, undefined);
    }
    const handle: FakeHandle = {
      exitCode: yield* Deferred.make<ExitCode, ProcessWaitFailure>(),
      output,
    };
    const teardownCount = yield* Ref.make(0);
    const driver = makeFakeDriver({
      processInput,
      gatewayAvailable,
      gatewayWithin,
      handle,
      teardownCount,
    });
    return {
      runtime: makeNanoclawRuntimeWith(options, driver),
      processInput,
      gatewayAvailable,
      gatewayWithin,
      handle,
      teardownCount,
    };
  });
}

function fullRuntimeOptions(): NanoclawRuntimeOptions {
  return {
    startupTimeout: STARTUP_TIMEOUT,
    installMode: "workspace",
    modelId: MODEL_ID,
    workspaceFiles: [{ relativePath: "IDENTITY.md", content: "Alice" }],
    autoRegisterConversations: true,
    mcpServers: [
      {
        name: "memory",
        command: "memory-server",
        args: ["--stdio"],
        env: { MEMORY_SCOPE: "alice" },
      },
    ],
  };
}

function assertProcessInput(process: NanoclawProcessInput): void {
  assert.strictEqual(process.agentName, AGENT_NAME);
  assert.strictEqual(process.agentId, AGENT_ID);
  assert.strictEqual(process.apiKey, AGENT_KEY);
  assert.strictEqual(process.serverUrl, ROUTER_URL);
  assert.strictEqual(process.modelId, MODEL_ID);
  assert.isTrue(process.autoRegisterConversations);
  assert.deepStrictEqual(process.workspaceFiles, [
    { relativePath: "IDENTITY.md", content: "Alice" },
  ]);
  assert.deepStrictEqual(process.mcpServers, [
    {
      name: "memory",
      command: "memory-server",
      args: ["--stdio"],
      env: { MEMORY_SCOPE: "alice" },
    },
  ]);
}

function returnsAfterReadinessTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(fullRuntimeOptions());
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fixture.runtime.acquire({
          agentName: AGENT_NAME,
          connection,
        });
        assertProcessInput(yield* Deferred.await(fixture.processInput));
      }),
    );
    const gatewayWithin = yield* Deferred.await(fixture.gatewayWithin);

    assert.strictEqual(
      Duration.toMillis(gatewayWithin),
      Duration.toMillis(STARTUP_TIMEOUT),
    );
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function interruptedAcquisitionTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture({}, "still booting");
    const acquired = yield* Effect.scoped(
      fixture.runtime.acquire({
        agentName: AGENT_NAME,
        connection,
      }),
    ).pipe(Effect.fork);
    yield* Deferred.await(fixture.processInput);

    const interrupted = yield* Fiber.interrupt(acquired);
    assert.isTrue(Exit.isFailure(interrupted));
    if (Exit.isFailure(interrupted)) {
      assert.isTrue(Cause.isInterruptedOnly(interrupted.cause));
    }
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function exitsBeforeReadinessTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(
      {},
      `startup failed apiKey=${AGENT_KEY_TEXT}`,
      false,
    );
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({
        agentName: AGENT_NAME,
        connection,
      }),
    ).pipe(Effect.flip, Effect.fork);
    yield* Deferred.await(fixture.processInput);
    yield* Deferred.await(fixture.gatewayWithin);
    yield* Deferred.succeed(
      fixture.handle.exitCode,
      processExitCode(PROCESS_EXIT_CODE),
    );
    const failure = yield* Fiber.join(acquiring);

    assert.instanceOf(failure, RuntimeAcquisitionFailed);
    assert.include(failure.detail, `exitCode=${String(PROCESS_EXIT_CODE)}`);
    assert.include(failure.detail, AGENT_KEY_REDACTION_MARKER);
    assert.notInclude(failure.detail, AGENT_KEY_TEXT);
    assert.include(failure.detail, "startup failed");
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function waitsForPrincipalGatewayTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(
      { startupTimeout: STARTUP_TIMEOUT },
      READY_OUTPUT,
      false,
    );
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({
        agentName: AGENT_NAME,
        connection,
      }),
    ).pipe(Effect.fork);

    const within = yield* Deferred.await(fixture.gatewayWithin);
    assert.strictEqual(
      Duration.toMillis(within),
      Duration.toMillis(STARTUP_TIMEOUT),
    );
    assert.isTrue(Option.isNone(yield* Fiber.poll(acquiring)));

    yield* Deferred.succeed(fixture.gatewayAvailable, undefined);
    yield* Fiber.join(acquiring);
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function waitFailsBeforeReadinessTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(
      {},
      `startup failed apiKey=${AGENT_KEY_TEXT}`,
    );
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({
        agentName: AGENT_NAME,
        connection,
      }),
    ).pipe(Effect.flip, Effect.fork);
    yield* Deferred.await(fixture.processInput);
    yield* Deferred.fail(fixture.handle.exitCode, PROCESS_WAIT_FAILURE);
    const failure = yield* Fiber.join(acquiring);

    assert.instanceOf(failure, RuntimeAcquisitionFailed);
    assert.include(failure.detail, "without an observable exit code");
    assert.include(failure.detail, AGENT_KEY_REDACTION_MARKER);
    assert.notInclude(failure.detail, AGENT_KEY_TEXT);
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function readinessFailureTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(
      { startupTimeout: STARTUP_TIMEOUT },
      "still booting",
    );
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({
        agentName: AGENT_NAME,
        connection,
      }),
    ).pipe(Effect.flip, Effect.fork);
    yield* expireStartupDeadline(STARTUP_TIMEOUT);
    const observed = yield* Fiber.join(acquiring);

    assert.instanceOf(observed, RuntimeAcquisitionFailed);
    assert.include(observed.detail, "did not announce readiness");
    assert.include(observed.detail, "still booting");
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function teardownIsNotTerminationTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture({});
    const scope = yield* Scope.make();
    const running = yield* fixture.runtime
      .acquire({
        agentName: AGENT_NAME,
        connection,
      })
      .pipe(Scope.extend(scope));
    const observing = yield* running.termination.pipe(Effect.forkIn(scope));
    yield* Scope.close(scope, Exit.void);

    const observed = yield* Fiber.await(observing);
    assert.isTrue(Exit.isFailure(observed));
    if (Exit.isFailure(observed)) {
      assert.isTrue(Cause.isInterruptedOnly(observed.cause));
    }
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function observeTermination(exitCode: ExitCode) {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture({});
    const observation = yield* Effect.scoped(
      Effect.gen(function* () {
        const acquiring = yield* fixture.runtime
          .acquire({
            agentName: AGENT_NAME,
            connection,
          })
          .pipe(Effect.fork);
        yield* Deferred.await(fixture.processInput);
        const running = yield* Fiber.join(acquiring);
        yield* Deferred.succeed(fixture.handle.exitCode, exitCode);
        return yield* running.termination;
      }),
    );
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
    return observation;
  });
}

function observeWaitFailure() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture({});
    const observation = yield* Effect.scoped(
      Effect.gen(function* () {
        const acquiring = yield* fixture.runtime
          .acquire({
            agentName: AGENT_NAME,
            connection,
          })
          .pipe(Effect.fork);
        yield* Deferred.await(fixture.processInput);
        const running = yield* Fiber.join(acquiring);
        yield* Deferred.fail(fixture.handle.exitCode, PROCESS_WAIT_FAILURE);
        return yield* running.termination;
      }),
    );
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
    return observation;
  });
}

function exactTerminationTest() {
  return Effect.gen(function* () {
    const exited = yield* observeTermination(
      processExitCode(PROCESS_EXIT_CODE),
    );
    const unavailable = yield* observeWaitFailure();

    assert.instanceOf(exited, RuntimeExited);
    assert.strictEqual(exited.code, PROCESS_EXIT_CODE);
    assert.instanceOf(unavailable, RuntimeFailed);
  });
}

function sanitizedConfigurationTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(fullRuntimeOptions());
    const encoded = yield* Schema.encode(fixture.runtime.configuration.schema)(
      fixture.runtime.configuration.value,
    );
    const serialized = JSON.stringify(encoded);

    assert.include(serialized, "contentDigest");
    assert.include(serialized, "definitionDigest");
    assert.include(serialized, "environmentValues");
    assert.include(serialized, '"installPolicy":"workspace"');
    assert.include(serialized, `"modelOverride":"${MODEL_ID}"`);
    assert.notInclude(serialized, "Alice");
    assert.notInclude(serialized, "MEMORY_SCOPE");
    assert.notInclude(serialized, AGENT_KEY_TEXT);
  });
}

// @agent-code-guard/regression-only: controlled handles expose process readiness, cancellation, teardown, and exact exit evidence deterministically
describe("native NanoClaw runtime", () => {
  test(
    "returns only after process and principal gateway readiness",
    returnsAfterReadinessTest,
  );
  test(
    "does not treat process readiness as principal gateway readiness",
    waitsForPrincipalGatewayTest,
  );
  test(
    "releases an interrupted process acquisition through its Scope",
    interruptedAcquisitionTest,
  );
  test(
    "fails and releases when the process exits while its gateway is connecting",
    exitsBeforeReadinessTest,
  );
  test(
    "reports an unavailable exit code when the process wait fails before readiness",
    waitFailsBeforeReadinessTest,
  );
  test(
    "fails when no readiness line arrives within the startup timeout",
    readinessFailureTest,
  );
  test(
    "does not report scoped teardown as autonomous termination",
    teardownIsNotTerminationTest,
  );
  test("reports the exact observed process exit status", exactTerminationTest);
  test(
    "publishes definition-time policy with digested workspace and MCP configuration",
    sanitizedConfigurationTest,
  );
});
