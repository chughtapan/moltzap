import { Args, Command } from "@effect/cli";
import { Effect, Schema } from "effect";
import {
  LocalDaemonCommands,
  SendCommandRpc,
  SendTarget,
  type SendTarget as SendTargetValue,
} from "../../local-daemon-rpc.js";
import { command, runHandler } from "../transport.js";
import type { Transport } from "../transport.js";
import { optionsFromSchema } from "../adapters.js";

type SendCommandParsed = {
  readonly target: SendTargetValue;
  readonly message: string;
  readonly options: Schema.Schema.Type<typeof SendOptionsSchema>;
};

const targetArg = Args.text({ name: "target" }).pipe(
  Args.withSchema(SendTarget),
  Args.withDescription("Target task+conversation as task:<taskId>:<convId>"),
);

const messageArg = Args.text({ name: "message" }).pipe(
  Args.withDescription("Message text"),
);

const SendOptionsSchema = SendCommandRpc.payloadSchema.pipe(
  Schema.omit("target", "message"),
);
export const sendOptions = optionsFromSchema(SendOptionsSchema, {
  replyToId: {
    name: "reply-to",
    description: "Reply to a specific message",
  },
});

/**
 * `moltzap send task:&lt;taskId>:&lt;convId> &lt;message> [--reply-to &lt;id>]` —
 * socket-call into the local MoltZapService to enqueue an outbound
 * `agent/message/send` against an existing (taskId, conversationId) pair.
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
 *   cli->>send: handler({target, message, options})
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
export const sendCommand: Command.Command<
  "send",
  Transport,
  never,
  SendCommandParsed
> = Command.make(
  "send",
  { target: targetArg, message: messageArg, options: sendOptions },
  ({ target, message, options }) => {
    return runHandler(
      command(LocalDaemonCommands.send, {
        target,
        message,
        ...options,
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
