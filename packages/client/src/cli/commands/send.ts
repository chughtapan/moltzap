import { Args, Command, HelpDoc, Options } from "@effect/cli";
import { Data, Effect, Option } from "effect";
import { Value } from "@sinclair/typebox/value";
import { request } from "../socket-client.js";

import { MessagesSend } from "@moltzap/protocol";
import { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";

const TASK_CONVERSATION_TARGET_PREFIX = "task:";

class SendTargetMalformedError extends Data.TaggedError(
  "SendTargetMalformedError",
)<{ readonly target: string; readonly reason: string }> {
  override get message(): string {
    return `invalid target ${this.target}: ${this.reason}`;
  }
}

const targetArg = Args.text({ name: "target" }).pipe(
  Args.withDescription("Target task+conversation as task:<taskId>:<convId>"),
  Args.mapTryCatch(
    (raw): { taskId: TaskId; conversationId: ConversationId } => {
      if (!raw.startsWith(TASK_CONVERSATION_TARGET_PREFIX)) {
        throw new SendTargetMalformedError({
          target: raw,
          reason: `missing '${TASK_CONVERSATION_TARGET_PREFIX}' prefix`,
        });
      }
      const rest = raw.slice(TASK_CONVERSATION_TARGET_PREFIX.length);
      const [tid, cid] = rest.split(":");
      if (!tid || !cid) {
        throw new SendTargetMalformedError({
          target: raw,
          reason: "expected task:<taskId>:<conversationId>",
        });
      }
      return {
        taskId: Value.Decode(TaskId, tid),
        conversationId: Value.Decode(ConversationId, cid),
      };
    },
    (err) => HelpDoc.p(`invalid target: ${String(err)}`),
  ),
);

const messageArg = Args.text({ name: "message" }).pipe(
  Args.withDescription("Message text"),
);

const replyToOption = Options.text("reply-to").pipe(
  Options.withDescription("Reply to a specific message"),
  Options.mapTryCatch(
    (raw) => Value.Decode(MessageId, raw),
    (err) => HelpDoc.p(`invalid --reply-to: ${String(err)}`),
  ),
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
