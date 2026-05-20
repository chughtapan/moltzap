import { Args, Command, HelpDoc, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { request } from "../socket-client.js";

import { MessagesSend } from "@moltzap/protocol";
import {
  BrandedIdDecodeError,
  brandConversationId,
  brandMessageId,
  brandTaskId,
  type ConversationId,
  type MessageId,
  type TaskId,
} from "@moltzap/protocol/task";

const TASK_CONVERSATION_TARGET_PREFIX = "task:";

const brandDecodeError = (label: string) => (err: unknown) =>
  err instanceof BrandedIdDecodeError
    ? HelpDoc.p(`invalid ${label}: ${err.input}`)
    : HelpDoc.p(`invalid ${label}: ${String(err)}`);

const targetArg = Args.text({ name: "target" }).pipe(
  Args.withDescription("Target task+conversation as task:<taskId>:<convId>"),
  Args.mapTryCatch(
    (raw): { taskId: TaskId; conversationId: ConversationId } => {
      if (!raw.startsWith(TASK_CONVERSATION_TARGET_PREFIX)) {
        throw new BrandedIdDecodeError({
          kind: "TaskId",
          input: raw,
          cause: `missing '${TASK_CONVERSATION_TARGET_PREFIX}' prefix`,
        });
      }
      const rest = raw.slice(TASK_CONVERSATION_TARGET_PREFIX.length);
      const [tid, cid] = rest.split(":");
      if (!tid || !cid) {
        throw new BrandedIdDecodeError({
          kind: "TaskId",
          input: raw,
          cause: "expected task:<taskId>:<conversationId>",
        });
      }
      return {
        taskId: brandTaskId(tid),
        conversationId: brandConversationId(cid),
      };
    },
    brandDecodeError("target"),
  ),
);

const messageArg = Args.text({ name: "message" }).pipe(
  Args.withDescription("Message text"),
);

const replyToOption = Options.text("reply-to").pipe(
  Options.withDescription("Reply to a specific message"),
  Options.mapTryCatch(brandMessageId, brandDecodeError("--reply-to")),
  Options.optional,
);

export const sendCommand = Command.make(
  "send",
  { target: targetArg, message: messageArg, replyTo: replyToOption },
  ({ target, message, replyTo }) => {
    const reply: { replyToId?: MessageId } = Option.isSome(replyTo)
      ? { replyToId: replyTo.value }
      : {};
    return request(MessagesSend, {
      taskId: target.taskId,
      conversationId: target.conversationId,
      parts: [{ type: "text", text: message }],
      ...reply,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          const r = result as { message: { id: string } };
          console.log(`Message sent (id: ${r.message.id})`);
        }),
      ),
      Effect.asVoid,
      Effect.catchAll((err) =>
        Effect.sync(() => {
          console.error(`Failed: ${err.message}`);
          process.exit(1);
        }),
      ),
    );
  },
).pipe(
  Command.withDescription(
    "Send a message to task:<taskId>:<conversationId>. " +
      "Identity follows the global --as / --profile flags.",
  ),
);
