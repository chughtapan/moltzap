import { Effect, Logger, Schema } from "effect";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, vi } from "vitest";
import {
  localDaemonCommands,
  startParticipant,
  StartPartialFailure,
  StartUsageError,
} from "../../local-daemon-rpc.js";
import { messageId, conversationId } from "@moltzap/protocol/testing";
import { transportSchema } from "../transport.js";
import {
  makeFakeTransport,
  type TestTransportResponder,
} from "./test-transport.js";
import { runStartHandler } from "./start.js";

const it = effectIt.effect;
const silentLogger = Logger.replace(Logger.defaultLogger, Logger.none);

const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000002");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000003");
const BOB_PARTICIPANT = Schema.decodeUnknownSync(startParticipant)("agent:bob");

// eslint-disable-next-line @typescript-eslint/unbound-method -- The test snapshots process.exit solely to restore the original method.
const originalExit = process.exit;

afterEach(() => {
  process.exit = originalExit;
});

const runWith = (
  respond: TestTransportResponder<typeof localDaemonCommands.start>,
  args: Parameters<typeof runStartHandler>[0],
) => {
  const fixture = makeFakeTransport({
    [localDaemonCommands.start]: respond,
  });
  return {
    calls: fixture.calls,
    effect: runStartHandler(args).pipe(
      Effect.provideService(transportSchema, fixture.transport),
      Effect.provide(silentLogger),
    ),
  };
};

function sendsStartDaemonCommand() {
  return Effect.gen(function* () {
    const run = runWith(
      () => ({
        conversationId: CONVERSATION_ID,
        sentMessageId: MESSAGE_ID,
      }),
      {
        name: "demo",
        participants: [BOB_PARTICIPANT],
        message: "hello",
      },
    );

    yield* run.effect;

    expect(run.calls).toEqual([
      {
        method: localDaemonCommands.start,
        params: {
          name: "demo",
          participants: [BOB_PARTICIPANT],
          message: "hello",
        },
      },
    ]);
  });
}

function mapsUsageErrorsToExit64() {
  return Effect.gen(function* () {
    const exitSpy = vi.fn();
    process.exit =
      /* Safe because the test fixture establishes this asserted shape. */ exitSpy as never;
    const run = runWith(
      () => new StartUsageError({ message: "Cannot resolve agent:bob" }),
      {
        name: "demo",
        participants: [BOB_PARTICIPANT],
        message: undefined,
      },
    );

    yield* run.effect;

    expect(exitSpy).toHaveBeenCalledWith(64);
  });
}

function mapsFirstMessageFailureToExit2() {
  return Effect.gen(function* () {
    const exitSpy = vi.fn();
    process.exit =
      /* Safe because the test fixture establishes this asserted shape. */ exitSpy as never;
    const run = runWith(
      () =>
        new StartPartialFailure({
          conversationId: CONVERSATION_ID,
          message: "send failed",
        }),
      {
        name: "demo",
        participants: [],
        message: "hello",
      },
    );

    yield* run.effect;

    expect(exitSpy).toHaveBeenCalledWith(2);
  });
}

describe("start command handler", () => {
  it("sends one start daemon command", sendsStartDaemonCommand);
  it("maps start usage errors to exit 64", mapsUsageErrorsToExit64);
  it(
    "maps first-message failure to exit 2 after conversation creation",
    mapsFirstMessageFailureToExit2,
  );
});
