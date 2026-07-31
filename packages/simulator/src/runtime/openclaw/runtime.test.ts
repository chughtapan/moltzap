/* eslint-disable sonarjs/no-nested-functions -- lifecycle tests pin acquisition, scoped teardown, and exact process-status transitions whose causal order is clearest in Effect generators. */

import { assert, it as effectIt } from "@effect/vitest";
import {
  ExitCode as processExitCode,
  type ExitCode,
} from "@effect/platform/CommandExecutor";
import { type AgentConnection, makeAgentHandle } from "../../network.js";
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
  Ref,
  Scope,
  TestClock,
} from "effect";
import { describe } from "vitest";
import { RuntimeAcquisitionFailed } from "../process.js";
import type {
  OpenClawProcessInput,
  OpenClawProcessOptions,
} from "./process.js";
import {
  makeOpenClawRuntimeWith,
  type OpenClawRuntimeDriver,
  type OpenClawRuntimeOptions,
} from "./runtime.js";

const test = effectIt.effect;
const AGENT_NAME = "alice";
const AGENT_KEY_TEXT =
  "moltzap_agent_0000000000000000_000000000000000000000000000000000000000000000000";
const AGENT_ID = agentId("00000000-0000-4000-8000-000000000001");
const AGENT_KEY_REDACTION_MARKER = "[REDACTED:agent-key]";
const AGENT_KEY = redactedAgentKey(AGENT_KEY_TEXT);
const READY_OUTPUT = "MoltZap: connected as alice (agent-1)";
const ROUTER_URL = serverBaseUrl("http://127.0.0.1:43123");
const PROCESS_EXIT_CODE = 23;
const STARTUP_TIMEOUT = Duration.seconds(17);
const MODEL_ID = "test/model";
const OPENCLAW_BIN = "/opt/openclaw/bin/openclaw";
const CHANNEL_DIST_DIR = "/opt/moltzap/openclaw-channel/dist";
const PROCESS_WAIT_FAILURE = "process wait failed";
type ProcessWaitFailure = typeof PROCESS_WAIT_FAILURE;

interface FakeSession {
  readonly exitCode: Deferred.Deferred<ExitCode, ProcessWaitFailure>;
  readonly output: string;
}

interface AcquiredOpenClaw {
  readonly input: OpenClawProcessInput;
  readonly options: OpenClawProcessOptions;
}

interface Fixture {
  readonly runtime: ReturnType<
    typeof makeOpenClawRuntimeWith<FakeSession, ProcessWaitFailure>
  >;
  readonly acquired: Deferred.Deferred<AcquiredOpenClaw>;
  readonly session: FakeSession;
  readonly teardownCount: Ref.Ref<number>;
}

const connection: AgentConnection<"alice"> = {
  agent: makeAgentHandle(AGENT_NAME, AGENT_ID),
  key: AGENT_KEY,
  routerUrl: ROUTER_URL,
};

function fakeProcessOptions(
  input: Parameters<
    OpenClawRuntimeDriver<FakeSession>["resolveProcessOptions"]
  >[0],
): OpenClawProcessOptions {
  return {
    openclawBin: input.openclawBin ?? OPENCLAW_BIN,
    channelDistDir: input.channelDistDir ?? CHANNEL_DIST_DIR,
    installMode: input.installMode,
    ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
  };
}

function makeFixture(
  options: OpenClawRuntimeOptions,
  output = "",
): Effect.Effect<Fixture> {
  return Effect.gen(function* () {
    const acquired = yield* Deferred.make<AcquiredOpenClaw>();
    const session: FakeSession = {
      exitCode: yield* Deferred.make<ExitCode, ProcessWaitFailure>(),
      output,
    };
    const teardownCount = yield* Ref.make(0);
    const driver: OpenClawRuntimeDriver<FakeSession, ProcessWaitFailure> = {
      resolveInstallMode: (requested) =>
        Effect.succeed(requested ?? "workspace"),
      resolveProcessOptions: (input) =>
        Effect.succeed(fakeProcessOptions(input)),
      acquire: (processOptions, processInput) =>
        Effect.acquireRelease(
          Deferred.succeed(acquired, {
            input: processInput,
            options: processOptions,
          }).pipe(Effect.as(session)),
          (running) =>
            Ref.update(teardownCount, (count) => count + 1).pipe(
              Effect.zipRight(
                Deferred.succeed(running.exitCode, processExitCode(0)),
              ),
              Effect.asVoid,
            ),
        ),
      exitCode: (running) => Deferred.await(running.exitCode),
      output: (running) => running.output,
      readyWhen: (text) => text.includes("connected as"),
    };
    return {
      runtime: makeOpenClawRuntimeWith(options, driver),
      acquired,
      session,
      teardownCount,
    };
  });
}

function fullRuntimeOptions(): OpenClawRuntimeOptions {
  return {
    startupTimeout: STARTUP_TIMEOUT,
    installMode: "workspace",
    openclawBin: OPENCLAW_BIN,
    channelDistDir: CHANNEL_DIST_DIR,
    modelId: MODEL_ID,
    workspaceFiles: [{ relativePath: "IDENTITY.md", content: "Alice" }],
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

function assertProcessAcquisition(acquired: AcquiredOpenClaw): void {
  assert.strictEqual(acquired.input.agentName, AGENT_NAME);
  assert.strictEqual(acquired.input.agentId, AGENT_ID);
  assert.strictEqual(acquired.input.apiKey, AGENT_KEY);
  assert.strictEqual(acquired.input.serverUrl, ROUTER_URL);
  assert.strictEqual(acquired.input.modelId, MODEL_ID);
  assert.deepStrictEqual(acquired.input.workspaceFiles, [
    { relativePath: "IDENTITY.md", content: "Alice" },
  ]);
  assert.deepStrictEqual(
    Object.keys(acquired.input).sort((left, right) =>
      left.localeCompare(right),
    ),
    [
      "agentId",
      "agentName",
      "apiKey",
      "modelId",
      "serverUrl",
      "workspaceFiles",
    ],
  );
  assert.strictEqual(acquired.options.openclawBin, OPENCLAW_BIN);
  assert.strictEqual(acquired.options.channelDistDir, CHANNEL_DIST_DIR);
  assert.deepStrictEqual(acquired.options.mcpServers, [
    {
      name: "memory",
      command: "memory-server",
      args: ["--stdio"],
      env: { MEMORY_SCOPE: "alice" },
    },
  ]);
}

function returnsAfterReadyLineTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(fullRuntimeOptions(), READY_OUTPUT);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fixture.runtime.acquire({ connection });
        assertProcessAcquisition(yield* Deferred.await(fixture.acquired));
      }),
    );
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function exitsBeforeReadyLineTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(
      {},
      `startup failed apiKey=${AGENT_KEY_TEXT}`,
    );
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({ connection }),
    ).pipe(Effect.flip, Effect.fork);
    yield* Deferred.await(fixture.acquired);
    yield* Deferred.succeed(
      fixture.session.exitCode,
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

function waitFailsBeforeReadyLineTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(
      {},
      `startup failed apiKey=${AGENT_KEY_TEXT}`,
    );
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({ connection }),
    ).pipe(Effect.flip, Effect.fork);
    yield* Deferred.await(fixture.acquired);
    yield* Deferred.fail(fixture.session.exitCode, PROCESS_WAIT_FAILURE);
    const failure = yield* Fiber.join(acquiring);

    assert.instanceOf(failure, RuntimeAcquisitionFailed);
    assert.include(failure.detail, "without an observable exit code");
    assert.include(failure.detail, AGENT_KEY_REDACTION_MARKER);
    assert.notInclude(failure.detail, AGENT_KEY_TEXT);
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function readyLineTimeoutTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture(fullRuntimeOptions(), "still booting");
    const acquiring = yield* Effect.scoped(
      fixture.runtime.acquire({ connection }),
    ).pipe(Effect.flip, Effect.fork);
    yield* Deferred.await(fixture.acquired);
    yield* TestClock.adjust(STARTUP_TIMEOUT);
    const failure = yield* Fiber.join(acquiring);

    assert.instanceOf(failure, RuntimeAcquisitionFailed);
    assert.include(failure.detail, "did not announce readiness");
    assert.include(failure.detail, "still booting");
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
  });
}

function teardownIsNotTerminationTest() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture({}, READY_OUTPUT);
    const scope = yield* Scope.make();
    const running = yield* fixture.runtime
      .acquire({
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
    const fixture = yield* makeFixture({}, READY_OUTPUT);
    const observation = yield* Effect.scoped(
      Effect.gen(function* () {
        const acquiring = yield* fixture.runtime
          .acquire({
            connection,
          })
          .pipe(Effect.fork);
        yield* Deferred.await(fixture.acquired);
        const running = yield* Fiber.join(acquiring);
        yield* Deferred.succeed(fixture.session.exitCode, exitCode);
        return yield* running.termination;
      }),
    );
    assert.strictEqual(yield* Ref.get(fixture.teardownCount), 1);
    return observation;
  });
}

function observeWaitFailure() {
  return Effect.gen(function* () {
    const fixture = yield* makeFixture({}, READY_OUTPUT);
    const observation = yield* Effect.scoped(
      Effect.gen(function* () {
        const acquiring = yield* fixture.runtime
          .acquire({
            connection,
          })
          .pipe(Effect.fork);
        yield* Deferred.await(fixture.acquired);
        const running = yield* Fiber.join(acquiring);
        yield* Deferred.fail(fixture.session.exitCode, PROCESS_WAIT_FAILURE);
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

// @agent-code-guard/regression-only: controlled sessions pin acquisition, scoped teardown, private host configuration, and exact process evidence
describe("native OpenClaw runtime", () => {
  test(
    "returns after the gateway logs its readiness line",
    returnsAfterReadyLineTest,
  );
  test(
    "fails and releases when the process exits before the readiness line",
    exitsBeforeReadyLineTest,
  );
  test(
    "reports an unavailable exit code when the process wait fails before the readiness line",
    waitFailsBeforeReadyLineTest,
  );
  test(
    "fails when no readiness line arrives within the startup timeout",
    readyLineTimeoutTest,
  );
  test(
    "does not report scoped teardown as autonomous termination",
    teardownIsNotTerminationTest,
  );
  test("reports the exact observed process exit status", exactTerminationTest);
});

/* eslint-enable sonarjs/no-nested-functions -- Restore strict defaults after the scoped file-level exception. */
