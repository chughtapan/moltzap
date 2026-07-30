import { Effect, Logger } from "effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { sendCommand } from "./send.js";

import type { ConversationId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { localDaemonCommands } from "../../local-daemon-rpc.js";
import { transportSchema } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";
import {
  conversationId as makeConversationId,
  messageId as makeMessageId,
  taskId as makeTaskId,
} from "@moltzap/protocol/testing";

const it = effectIt.effect;
const TASK_UUID = "00000000-0000-4000-8000-00000000abc2";
const CONV_UUID = "00000000-0000-4000-8000-00000000abc1";
const SENT_MSG = "00000000-0000-4000-8000-0000000000a2";
const HELLO_WORLD = "Hello world";
const silentLogger = Logger.replace(Logger.defaultLogger, Logger.none);

function runSendCommand(input: {
  readonly target: { taskId: TaskId; conversationId: ConversationId };
  readonly message: string;
}) {
  const fixture = makeFakeTransport({
    [localDaemonCommands.send]: () => ({
      messageId: makeMessageId(SENT_MSG),
    }),
  });
  return {
    calls: fixture.calls,
    effect: sendCommand
      .handler(input)
      .pipe(
        Effect.provideService(transportSchema, fixture.transport),
        Effect.provide(silentLogger),
      ),
  };
}

describe("send command handler", () => {
  const taskId = makeTaskId(TASK_UUID);
  const conversationId = makeConversationId(CONV_UUID);

  it("sends to task+conversation target", () =>
    Effect.gen(function* () {
      const run = runSendCommand({
        target: { taskId, conversationId },
        message: HELLO_WORLD,
      });
      yield* run.effect;
      expect(run.calls).toEqual([
        {
          method: localDaemonCommands.send,
          params: {
            target: { taskId, conversationId },
            message: HELLO_WORLD,
          },
        },
      ]);
    }));
});
