import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { request } from "../socket-client.js";

const targetArg = Args.text({ name: "target" }).pipe(
  Args.withDescription("Target (agent:<name> or conv:<id>)"),
);

const messageArg = Args.text({ name: "message" }).pipe(
  Args.withDescription("Message text"),
);

const replyToOption = Options.text("reply-to").pipe(
  Options.withDescription("Reply to a specific message"),
  Options.optional,
);

/**
 * `moltzap send <target> <message> [--reply-to <id>]` — socket-call into
 * the local MoltZapService to enqueue an outbound message. `conv:` prefix
 * addresses a conversation id directly; otherwise `target` is passed as a
 * string the service resolves.
 */
export const sendCommand = Command.make(
  "send",
  { target: targetArg, message: messageArg, replyTo: replyToOption },
  ({ target, message, replyTo }) => {
    const params: Record<string, unknown> = {
      parts: [{ type: "text", text: message }],
    };
    if (target.startsWith("conv:")) {
      params.conversationId = target.slice(5);
    } else {
      params.to = target;
    }
    if (Option.isSome(replyTo)) params.replyToId = replyTo.value;

    return request("messages/send", params).pipe(
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
).pipe(Command.withDescription("Send a message to a conversation or DM"));
