import { Effect, Logger } from "effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { sendCommand, sendOptions } from "./send.js";

import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { LocalDaemonCommands } from "../../local-daemon-rpc.js";
import { Transport } from "../transport.js";
import { makeFakeTransport } from "./test-transport.js";
import { parseCliOptions } from "../../test-utils/cli-options.js";
import {
  conversationId as makeConversationId,
  messageId as makeMessageId,
  taskId as makeTaskId,
} from "@moltzap/protocol/testing";

const it = effectIt.effect;
const TASK_UUID = "00000000-0000-4000-8000-00000000abc2";
const CONV_UUID = "00000000-0000-4000-8000-00000000abc1";
const REPLY_MSG = "00000000-0000-4000-8000-0000000000a1";
const HELLO_WORLD = "Hello world";
const REPLY_TEXT = "Reply text";
const SilentLogger = Logger.replace(Logger.defaultLogger, Logger.none);

function runSendCommand(input: {
  readonly target: { taskId: TaskId; conversationId: ConversationId };
  readonly message: string;
  readonly options: { readonly replyToId?: MessageId };
}) {
  const fixture = makeFakeTransport(() => ({ messageId: "msg-123" }));
  return {
    calls: fixture.calls,
    effect: sendCommand
      .handler(input)
      .pipe(
        Effect.provideService(Transport, fixture.transport),
        Effect.provide(SilentLogger),
      ),
  };
}

describe("send command schema options", () => {
  it("parses omitted and explicit --reply-to values", () =>
    Effect.gen(function* () {
      const omitted = yield* parseCliOptions(sendOptions, []);
      expect(omitted).toEqual({ rest: [], value: {} });

      const explicit = yield* parseCliOptions(sendOptions, [
        "--reply-to",
        REPLY_MSG,
      ]);
      expect(explicit).toEqual({
        rest: [],
        value: { replyToId: REPLY_MSG },
      });
    }));
});

describe("send command handler", () => {
  const taskId = makeTaskId(TASK_UUID);
  const conversationId = makeConversationId(CONV_UUID);
  const replyToId = makeMessageId(REPLY_MSG);

  it("sends to task+conversation target", () =>
    Effect.gen(function* () {
      const run = runSendCommand({
        target: { taskId, conversationId },
        message: HELLO_WORLD,
        options: {},
      });
      yield* run.effect;
      expect(run.calls).toEqual([
        {
          method: LocalDaemonCommands.Send,
          params: {
            target: { taskId, conversationId },
            message: HELLO_WORLD,
          },
        },
      ]);
    }));

  it("includes replyToId when --reply-to is provided", () =>
    Effect.gen(function* () {
      const run = runSendCommand({
        target: { taskId, conversationId },
        message: REPLY_TEXT,
        options: { replyToId },
      });
      yield* run.effect;
      expect(run.calls).toEqual([
        {
          method: LocalDaemonCommands.Send,
          params: {
            target: { taskId, conversationId },
            message: REPLY_TEXT,
            replyToId,
          },
        },
      ]);
    }));
});
