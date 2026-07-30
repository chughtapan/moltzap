import { assert, it as effectIt } from "@effect/vitest";
import {
  ExitCode as processExitCode,
  type ExitCode,
} from "@effect/platform/CommandExecutor";
import {
  NetworkFailure,
  type AgentConnection,
  makeAgentHandle,
} from "../../network.js";
import { RuntimeExited, RuntimeFailed } from "../runtime.js";
import { serverBaseUrl } from "@moltzap/protocol/network";
import { agentId, redactedAgentKey } from "@moltzap/protocol/testing";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Scope,
} from "effect";
import { describe } from "vitest";
import { RuntimeAcquisitionFailed } from "../process.js";
import type { InstallMode } from "../packages.js";
import {
  makeNanoclawRuntimeWith,
  type NanoclawProcessInput,
  type NanoclawRuntimeDriver,
  type NanoclawRuntimeOptions,
} from "./runtime.js";

const test = effectIt.effect;
const AGENT_NAME = "alice";
const AGENT_KEY_TEXT =
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000";
const AGENT_KEY_REDACTION_MARKER = "[REDACTED:agent-key]";
const AGENT_ID = agentId("00000000-0000-4000-8000-000000000001");
const AGENT_KEY = redactedAgentKey(AGENT_KEY_TEXT);
const ROUTER_URL = serverBaseUrl("http://127.0.0.1:43123");
const PROCESS_EXIT_CODE = 23;
const STARTUP_TIMEOUT = Duration.seconds(17);
const MODEL_ID = "test/model";
const READY_FAILURE_OPERATION = "attach-agent";
const READY_FAILURE_DETAIL = "alice was not router-visible";
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
  readonly handle: FakeHandle;
  readonly teardownCount: Ref.Ref<number>;
}

function makeConnection(
  awaitReady: AgentConnection<"alice">["awaitReady"],
): AgentConnection<"alice"> {
  return {
    agent: makeAgentHandle(AGENT_NAME, AGENT_ID),
    key: AGENT_KEY,
    routerUrl: ROUTER_URL,
    awaitReady,
  };
}

function makeFixture(
  options: NanoclawRuntimeOptions,
  output = "",
): Effect.Effect<Fixture> {
  return Effect.gen(function* () {
    const processInput = yield* Deferred.make<NanoclawProcessInput>();
    const handle: FakeHandle = {
      exitCode: yield* Deferred.make<ExitCode, ProcessWaitFailure>(),
      output,
    };
    const teardownCount = yield* Ref.make(0);
    const driver: NanoclawRuntimeDriver<
      FakeInstall,
      FakeHandle,
      ProcessWaitFailure
    > = {
      resolveInstallMode: (requested) =>
        Effect.succeed(requested ?? "workspace"),
      install: (mode) => Effect.succeed({ mode }),
      start: (input) =>
        Deferred.succeed(processInput, input).pipe(Effect.as(handle)),
      stop: (running) =>
        Ref.update(teardownCount, (count) => count + 1).pipe(
          Effect.zipRight(
            Deferred.succeed(running.exitCode, processExitCode(0)),
          ),
          Effect.asVoid,
        ),
      exitCode: (running) => Deferred.await(running.exitCode),
      output: (running) => running.output,
    };
    return {
      runtime: makeNanoclawRuntimeWith(options, driver),
      processInput,
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
    const readyEntered = yield* Deferred.make<Duration.Duration>();
    const becomeReady = yield* Deferred.make<undefined>();
    const fixture = yield* makeFixture(fullRuntimeOptions());
    const acquired = yield* Effect.scoped(
      fixture.runtime.acquire({
        connection: makeConnection((within) =>
          Deferred.succeed(readyEntered, within).pipe(
            Effect.zipRight(Deferred.await(becomeReady)),
          ),
        ),
      }),
    ).pipe(Effect.fork);
    const process = yield* Deferred.await(fixture.processInput);
    const readyWithin = yield* Deferred.await(readyEntered);

    assert.isTrue(Option.isNone(yield* Fiber.poll(acquired)));
    assert.strictEqual(
      Duration.toMillis(readyWithin),
      Duration.toMillis(STARTUP_TIMEOUT),
    );
    assertProcessInput(process);
    yield* Deferred.succeed(becomeReady, undefined);
    yield* Fiber.join(acquired);
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function interruptedAcquisitionTest() {
  return Effect.gen(function* () {
    const readyEntered = yield* Deferred.make<undefined>();
    const fixture = yield* makeFixture({});
    const acquired = yield* Effect.scoped(
      fixture.runtime.acquire({
        connection: makeConnection(() =>
          Deferred.succeed(readyEntered, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        ),
      }),
    ).pipe(Effect.fork);
    yield* Deferred.await(readyEntered);

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
    );
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({
        connection: makeConnection(() => Effect.never),
      }),
    ).pipe(Effect.flip, Effect.fork);
    yield* Deferred.await(fixture.processInput);
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

function waitFailsBeforeReadinessTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(
      {},
      `startup failed apiKey=${AGENT_KEY_TEXT}`,
    );
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({
        connection: makeConnection(() => Effect.never),
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
    const readyWithin = yield* Deferred.make<Duration.Duration>();
    const expected = NetworkFailure.make({
      operation: READY_FAILURE_OPERATION,
      detail: READY_FAILURE_DETAIL,
    });
    const fixture = yield* makeFixture({
      startupTimeout: STARTUP_TIMEOUT,
    });
    const observed = yield* Effect.scoped(
      fixture.runtime.acquire({
        connection: makeConnection((within) =>
          Deferred.succeed(readyWithin, within).pipe(
            Effect.zipRight(Effect.fail(expected)),
          ),
        ),
      }),
    ).pipe(Effect.flip);

    assert.instanceOf(observed, RuntimeAcquisitionFailed);
    assert.include(observed.detail, READY_FAILURE_DETAIL);
    assert.strictEqual(
      Duration.toMillis(yield* Deferred.await(readyWithin)),
      Duration.toMillis(STARTUP_TIMEOUT),
    );
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function teardownIsNotTerminationTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture({});
    const scope = yield* Scope.make();
    const running = yield* fixture.runtime
      .acquire({
        connection: makeConnection(() => Effect.void),
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
            connection: makeConnection(() => Effect.void),
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
            connection: makeConnection(() => Effect.void),
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

// @agent-code-guard/regression-only: controlled handles expose process readiness, cancellation, teardown, and exact exit evidence deterministically
describe("native NanoClaw runtime", () => {
  test(
    "returns only after router-visible readiness",
    returnsAfterReadinessTest,
  );
  test(
    "releases an interrupted process acquisition through its Scope",
    interruptedAcquisitionTest,
  );
  test(
    "fails and releases when the process exits before readiness",
    exitsBeforeReadinessTest,
  );
  test(
    "reports an unavailable exit code when the process wait fails before readiness",
    waitFailsBeforeReadinessTest,
  );
  test(
    "propagates router readiness failure and releases the process",
    readinessFailureTest,
  );
  test(
    "does not report scoped teardown as autonomous termination",
    teardownIsNotTerminationTest,
  );
  test("reports the exact observed process exit status", exactTerminationTest);
});
