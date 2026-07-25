/**
 * @file StubRuntime: a scripted external agent process speaking the real
 * WS wire protocol — the hermetic-CI and demo tier, and the `Runtime`
 * contract's reference implementation. Always bannered as scripted; a
 * StubRuntime society is never presented as agent cognition. Behavior
 * scripts are instrument fixtures (not scenario logic) and live behind
 * demo/test entry points.
 */
import { fileURLToPath } from "node:url";
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import {
  Duration,
  Effect,
  Fiber,
  Option,
  Redacted,
  Schema,
  Scope,
  Exit,
} from "effect";
import type { Process } from "@effect/platform/CommandExecutor";
import type { LogSlice, ReadyOutcome, SpawnInput } from "../runtime.js";
import {
  escalatingKill,
  pollFiberExitCode,
  startSupervisedProcess,
} from "../child-process.js";
import { SpawnFailed, spawnFailed } from "../errors.js";
import { httpBaseFromServerUrl } from "./provisioning.js";
import type { RuntimeExit, SimulatorRuntime } from "./run-config.js";

/** One scripted behavior step; the closed v0 vocabulary. */
export const StubStep = Schema.Union(
  Schema.TaggedStruct("send", {
    to: Schema.String.annotations({ description: "Recipient agent name" }),
    content: Schema.String.annotations({
      description: "Message content to send",
    }),
    afterMs: Schema.optionalWith(
      Schema.Int.annotations({ description: "Wall delay before sending" }),
      { default: () => 0 },
    ),
  }),
  Schema.TaggedStruct("replyOnMatch", {
    pattern: Schema.String.annotations({
      description: "Substring matched against inbound messages",
    }),
    content: Schema.String.annotations({ description: "Reply content" }),
  }),
  Schema.TaggedStruct("signalDone", {
    afterMs: Schema.Int.annotations({
      description: "Wall delay before emitting the done signal",
    }),
  }),
  Schema.TaggedStruct("exit", {
    exitCode: Schema.Int.annotations({
      description: "Process exit code (crash-path fixtures)",
    }),
    afterMs: Schema.Int.annotations({
      description: "Wall delay before exiting",
    }),
  }),
).annotations({ description: "Scripted StubRuntime behavior step" });
export type StubStep = typeof StubStep.Type;

/** A named, registered behavior script referenced from `StubConfig.script`. */
export class StubScript extends Schema.Class<StubScript>("StubScript")({
  name: Schema.NonEmptyString.annotations({
    description: "Registered script name",
  }),
  steps: Schema.Array(StubStep).annotations({
    description: "Steps executed in order; matchers stay armed",
  }),
}) {}

export type StubOptions = {
  readonly script: StubScript;
};

/**
 * Create a StubRuntime adapter. Spawns an external scripted process that
 * authenticates over the real WS protocol; no model keys, no external
 * network.
 */
export function makeStubRuntime(options: StubOptions): SimulatorRuntime {
  const state: StubState = { current: undefined };
  return {
    spawn: (input) => spawnStub(state, options, input),
    waitUntilReady: (timeoutMs) => waitUntilReady(state, timeoutMs),
    teardown: () => teardown(state),
    getLogs: (offset) => getLogs(state, offset),
    getInboundMarker: () => INBOUND_MARKER,
    awaitExit: () => awaitExit(state),
  };
}

const CONNECTED_MARKER = "[stub-runtime] connected";
const INBOUND_MARKER = "[stub-runtime] received";
const READY_POLL_MS = 50;
const STUB_TERM_WAIT_MS = 3_000;
const STUB_KILL_WAIT_MS = 2_000;

const STUB_MAIN_PATH = fileURLToPath(
  new URL("../../simulator-assets/stub-runtime-main.mjs", import.meta.url),
);

type StubState = {
  current:
    | {
        readonly proc: Process;
        readonly exitFiber: Fiber.RuntimeFiber<number, never>;
        readonly scope: Scope.CloseableScope;
        readonly logBuffer: { value: string };
        tornDown: boolean;
      }
    | undefined;
};

function spawnStub(
  state: StubState,
  options: StubOptions,
  input: SpawnInput,
): Effect.Effect<void, SpawnFailed, never> {
  const command = Command.make(process.execPath, STUB_MAIN_PATH).pipe(
    Command.env({
      MOLTZAP_STUB_SERVER_URL: httpBaseFromServerUrl(input.serverUrl),
      MOLTZAP_STUB_AGENT_KEY: Redacted.value(input.apiKey),
      MOLTZAP_STUB_AGENT_NAME: input.agentName,
      MOLTZAP_STUB_SCRIPT: JSON.stringify(
        Schema.encodeSync(StubScript)(options.script),
      ),
    }),
  );
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const logBuffer = { value: "" };
    const started = yield* startSupervisedProcess(command, scope, (chunk) => {
      logBuffer.value += chunk;
    }).pipe(
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
    );
    state.current = {
      proc: started.proc,
      exitFiber: started.exitFiber,
      scope,
      logBuffer,
      tornDown: false,
    };
  }).pipe(
    Effect.mapError((cause) => spawnFailed(input.agentName, cause)),
    Effect.provide(NodeContext.layer),
    Effect.withSpan("StubRuntime.spawn"),
  );
}

/** Readiness = the child's post-`connect` marker line; the WS accept is the server-side auth confirmation. */
function waitUntilReady(
  state: StubState,
  timeoutMs: number,
): Effect.Effect<ReadyOutcome, never, never> {
  const current = state.current;
  if (current === undefined) return Effect.succeed({ _tag: "Ready" });
  return pollReady(current, timeoutMs).pipe(
    Effect.tap((outcome) =>
      outcome._tag === "Ready" ? Effect.void : teardown(state),
    ),
  );
}

function pollReady(
  current: NonNullable<StubState["current"]>,
  remainingMs: number,
): Effect.Effect<ReadyOutcome, never, never> {
  if (current.logBuffer.value.includes(CONNECTED_MARKER)) {
    return Effect.succeed({ _tag: "Ready" });
  }
  return pollFiberExitCode(current.exitFiber).pipe(
    Effect.flatMap((exit) => {
      if (Option.isSome(exit)) {
        return Effect.succeed<ReadyOutcome>({
          _tag: "ProcessExited",
          exitCode: exit.value,
          stderr: current.logBuffer.value,
        });
      }
      if (remainingMs <= 0) {
        return Effect.succeed<ReadyOutcome>({
          _tag: "Timeout",
          timeoutMs: remainingMs,
        });
      }
      return Effect.sleep(Duration.millis(READY_POLL_MS)).pipe(
        Effect.zipRight(
          Effect.suspend(() => pollReady(current, remainingMs - READY_POLL_MS)),
        ),
      );
    }),
  );
}

function teardown(state: StubState): Effect.Effect<void, never, never> {
  const current = state.current;
  if (current === undefined || current.tornDown) return Effect.void;
  current.tornDown = true;
  return Effect.uninterruptible(
    escalatingKill(current.proc, current.exitFiber, {
      termWaitMs: STUB_TERM_WAIT_MS,
      killWaitMs: STUB_KILL_WAIT_MS,
    }).pipe(
      Effect.zipRight(Scope.close(current.scope, Exit.succeed(undefined))),
    ),
  );
}

function getLogs(state: StubState, offset: number): LogSlice {
  const current = state.current;
  if (current === undefined) return { text: "", nextOffset: 0 };
  const full = current.logBuffer.value;
  return { text: full.slice(offset), nextOffset: full.length };
}

function awaitExit(state: StubState): Effect.Effect<RuntimeExit, never, never> {
  const current = state.current;
  if (current === undefined) {
    return Effect.succeed({ exitCode: null, signal: undefined });
  }
  return Fiber.join(current.exitFiber).pipe(
    Effect.map(
      (exitCode): RuntimeExit =>
        exitCode >= 0
          ? { exitCode, signal: undefined }
          : { exitCode: null, signal: undefined },
    ),
  );
}
