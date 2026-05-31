import { Args, Command, HelpDoc, Options } from "@effect/cli";
import { Data, Effect, Option, Schema } from "effect";
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
        taskId: Schema.decodeUnknownSync(TaskId)(tid),
        conversationId: Schema.decodeUnknownSync(ConversationId)(cid),
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
    (raw) => Schema.decodeUnknownSync(MessageId)(raw),
    (err) => HelpDoc.p(`invalid --reply-to: ${String(err)}`),
  ),
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
 *   --as &lt;apiKey>       Send as the agent owning the given API key.
 *                       Bypasses the local daemon socket; dials the
 *                       server directly. Useful in multi-agent
 *                       workflows where the same host registers more
 *                       than one agent.
 *   --profile &lt;name>    Load the named profile from
 *                       ~/.moltzap/config.json and send as that agent.
 *                       Short for looking up the apiKey out of the
 *                       profile and passing it as --as.
 *
 * If neither is provided, the command uses the legacy default profile
 * (top-level apiKey in ~/.moltzap/config.json) — the identity set by
 * the most recent `moltzap register` that did not use `--profile` or
 * `--no-persist`.
 *
 * Examples:
 *   moltzap send task:$TID:$CID "hello"                          # default identity
 *   moltzap --profile alice send task:$TID:$CID "hello"          # send as alice
 *   moltzap --as $BOB_API_KEY send task:$TID:$CID "ack"          # send as bob
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
 *   send->>sock: request(MessagesSend, {taskId, conversationId, parts})
 *   Note over sock: NodeSocket.makeNet(~/.moltzap/service.sock, 10s) — ENOENT/ECONNREFUSED → SocketRequestError "not running"
 *   sock->>daemon: NDJSON RPC — LocalDaemonCall — method messages/send
 *   Note over daemon: handleSocketRequest → sendRpc(MessagesSend) → agent-client → server
 *   daemon-->>sock: {message: {id}}
 *   Note over sock: definition.validateResult
 *   sock-->>send: {message: {id}}
 *   send-->>shell: stdout — Message sent (id)
 * ```
 *
 * `--as` and `--profile` bypass the daemon socket and dial the server
 * directly. New v2 subcommands (`apps/*`, `messages list`,
 * `conversations {get,archive,unarchive}`) honor those flags today;
 * `moltzap send` itself is still on the daemon socket pending the v2
 * transport rewire.
 */
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
