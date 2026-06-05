import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { LocalDaemonCommands, SendTarget } from "../../local-daemon-rpc.js";
import { command, runHandler } from "../transport.js";

import { MessageId } from "@moltzap/protocol/conversation";

const targetArg = Args.text({ name: "target" }).pipe(
  Args.withSchema(SendTarget),
  Args.withDescription("Target task+conversation as task:<taskId>:<convId>"),
);

const messageArg = Args.text({ name: "message" }).pipe(
  Args.withDescription("Message text"),
);

const replyToOption = Options.text("reply-to").pipe(
  Options.withSchema(MessageId),
  Options.withDescription("Reply to a specific message"),
  Options.optional,
);

/**
 * `moltzap send task:&lt;taskId>:&lt;convId> &lt;message> [--reply-to &lt;id>]` —
 * socket-call into the local MoltZapService to enqueue an outbound
 * `messages/send` against an existing (taskId, conversationId) pair.
 * `taskId` is REQUIRED on the wire, so the CLI target always carries both
 * ids.
 *
 * Identity selection is driven by the parent `@effect/cli` options
 * wired in `cli/index.ts`:
 *
 *   --profile &lt;name>    Load the named profile from
 *                       ~/.moltzap/config.json and send through that
 *                       agent's local daemon socket.
 *
 * If no profile is provided, the command uses the default local daemon socket.
 *
 * Examples:
 *   moltzap send task:$TID:$CID "hello"                          # default identity
 *   moltzap --profile alice send task:$TID:$CID "hello"          # send as alice
 *
 * Default path delegates to the local channel daemon via a
 * Unix-socket RPC; it does NOT mint its own `MoltZapAgentClient`.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant shell
 *   participant cli as effect-cli
 *   participant send as sendCommand
 *   participant sock as socket-client
 *   participant daemon
 *
 *   shell->>cli: moltzap send task:taskId:convId msg
 *   cli->>send: handler({target, message, replyTo})
 *   send->>sock: command(cli/send, {target, message, replyToId?})
 *   Note over sock: NodeSocket.makeNet(~/.moltzap/service.sock, 10s) — ENOENT/ECONNREFUSED → SocketRequestError "not running"
 *   sock->>daemon: NDJSON RPC — cli/send
 *   Note over daemon: LocalDaemonRpcs handler → MessagesSend → agent-client → server
 *   daemon-->>sock: {messageId}
 *   sock-->>send: {messageId}
 *   send-->>shell: stdout — Message sent (id)
 * ```
 *
 * `--profile` selects the per-agent daemon socket; credentials remain owned
 * by the running MoltZapService.
 */
export const sendCommand = Command.make(
  "send",
  { target: targetArg, message: messageArg, replyTo: replyToOption },
  ({ target, message, replyTo }) => {
    const reply: { replyToId?: MessageId } = Option.isSome(replyTo)
      ? { replyToId: replyTo.value }
      : {};
    return runHandler(
      command(LocalDaemonCommands.Send, {
        target,
        message,
        ...reply,
      }).pipe(
        Effect.flatMap((result) =>
          Effect.log(`Message sent (id: ${result.messageId})`),
        ),
        Effect.asVoid,
      ),
    );
  },
).pipe(
  Command.withDescription(
    "Send a message to task:<taskId>:<conversationId>. " +
      "Identity follows the global --profile flag.",
  ),
);
