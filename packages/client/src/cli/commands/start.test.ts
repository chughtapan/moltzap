import { Effect, Logger, Schema } from "effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vitest";
import {
  AppIdV4,
  LocalDaemonCommands,
  StartParticipant,
  StartTaskPartialFailure,
  StartTaskUsageError,
} from "../../local-daemon-rpc.js";
import { messageId, taskId } from "@moltzap/protocol/testing";
import { conversationId } from "@moltzap/protocol/testing";
import { Transport } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";
import { runStartHandler } from "./start.js";

const it = effectIt.effect;
const SilentLogger = Logger.replace(Logger.defaultLogger, Logger.none);

const TASK_ID = taskId("00000000-0000-4000-8000-000000000001");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000002");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000003");
const APP_ID = "11111111-2222-4333-8444-555555555555" as AppIdV4;
const BOB_PARTICIPANT = Schema.decodeUnknownSync(StartParticipant)("agent:bob");

const originalExit = process.exit;

afterEach(() => {
  process.exit = originalExit;
});

const runWith = (
  respond: Parameters<typeof makeFakeTransport>[0],
  args: Parameters<typeof runStartHandler>[0],
) => {
  const fixture = makeFakeTransport(respond);
  return {
    calls: fixture.calls,
    effect: runStartHandler(args).pipe(
      Effect.provideService(Transport, fixture.transport),
      Effect.provide(SilentLogger),
    ),
  };
};

function sendsStartTaskDaemonCommand() {
  return Effect.gen(function* () {
    const run = runWith(
      () => ({
        taskId: TASK_ID,
        conversationId: CONVERSATION_ID,
        reusedConversation: false,
        sentMessageId: MESSAGE_ID,
      }),
      {
        name: "demo",
        participants: [BOB_PARTICIPANT],
        message: "hello",
        appId: APP_ID,
      },
    );

    yield* run.effect;

    expect(run.calls).toEqual([
      {
        method: LocalDaemonCommands.StartTask,
        params: {
          name: "demo",
          participants: [BOB_PARTICIPANT],
          message: "hello",
          appId: APP_ID,
        },
      },
    ]);
  });
}

function mapsUsageErrorsToExit64() {
  return Effect.gen(function* () {
    const exitSpy = vi.fn();
    process.exit = exitSpy as never;
    const run = runWith(
      () => new StartTaskUsageError({ message: "Cannot resolve agent:bob" }),
      {
        name: "demo",
        participants: [BOB_PARTICIPANT],
        message: undefined,
        appId: undefined,
      },
    );

    yield* run.effect;

    expect(exitSpy).toHaveBeenCalledWith(64);
  });
}

function mapsFirstMessageFailureToExit2() {
  return Effect.gen(function* () {
    const exitSpy = vi.fn();
    process.exit = exitSpy as never;
    const run = runWith(
      () =>
        new StartTaskPartialFailure({
          taskId: TASK_ID,
          conversationId: CONVERSATION_ID,
          reusedConversation: false,
          message: "send failed",
        }),
      {
        name: "demo",
        participants: [],
        message: "hello",
        appId: undefined,
      },
    );

    yield* run.effect;

    expect(exitSpy).toHaveBeenCalledWith(2);
  });
}

describe("start command handler", () => {
  it("sends one start-task daemon command", sendsStartTaskDaemonCommand);
  it("maps start usage errors to exit 64", mapsUsageErrorsToExit64);
  it(
    "maps first-message failure to exit 2 after task creation",
    mapsFirstMessageFailureToExit2,
  );
});
