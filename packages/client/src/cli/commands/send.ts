import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { request } from "../socket-client.js";

import { MessagesSend } from "@moltzap/protocol";
import type { ConversationId, MessageId } from "@moltzap/protocol/task";

const CONVERSATION_TARGET_PREFIX = "conv:";

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
 * `moltzap send &lt;target> &lt;message> [--reply-to &lt;id>]` — socket-call into
 * the local MoltZapService to enqueue an outbound message. `conv:` prefix
 * addresses a conversation id directly; otherwise `target` is passed as a
 * string the service resolves (typically `agent:&lt;name>` for direct messages
 * or a bare contact name the service resolves against the caller's roster).
 *
 * Identity selection is driven by the parent `@effect/cli` options wired in
 * `cli/index.ts`:
 *
 *   --as &lt;apiKey>       Send as the agent owning the given API key.
 *                       Bypasses the local daemon socket; dials the server
 *                       directly. Useful in multi-agent workflows where
 *                       the same host registers more than one agent.
 *   --profile &lt;name>    Load the named profile from ~/.moltzap/config.json
 *                       and send as that agent. Short for looking up the
 *                       apiKey out of the profile and passing it as --as.
 *
 * If neither is provided, the command uses the legacy default profile
 * (top-level apiKey in ~/.moltzap/config.json) — the identity set by the
 * most recent `moltzap register` that did not use `--profile` or
 * `--no-persist`.
 *
 * Examples:
 *   moltzap send agent:bob "hello"                         # default identity
 *   moltzap --profile alice send agent:bob "hello"         # send as alice
 *   moltzap --as $BOB_API_KEY send conv:$CID "ack"         # send as bob
 *
 * Default path delegates to the local channel daemon via a Unix-socket
 * RPC; it does NOT mint its own `MoltZapWsClient`.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant shell
 *   participant cli as effect-cli
 *   participant send as sendCommand
 *   participant sock as socket-client
 *   participant daemon
 *
 *   shell->>cli: moltzap send &lt;target> &lt;msg>
 *   cli->>send: handler({target, message, replyTo})
 *   alt target starts with conv:
 *     send->>sock: request(MessagesSend, {conversationId, parts})
 *   else
 *     send->>sock: request(MessagesSend, {to: target, parts})
 *   end
 *   Note over sock: NodeSocket.makeNet(~/.moltzap/service.sock, 10s)&lt;br>ENOENT/ECONNREFUSED → SocketRequestError "not running"
 *   sock->>daemon: NDJSON RPC — LocalDaemonCall&lt;br>method messages/send, params
 *   Note over daemon: handleSocketRequest → sendRpc(MessagesSend) → ws-client → server
 *   daemon-->>sock: {message: {id}}
 *   Note over sock: definition.validateResult
 *   sock-->>send: {message: {id}}
 *   send-->>shell: stdout — Message sent (id: &lt;id>)
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
    const reply = Option.isSome(replyTo)
      ? { replyToId: replyTo.value as MessageId }
      : {};
    if (target.startsWith(CONVERSATION_TARGET_PREFIX)) {
      return request(MessagesSend, {
        conversationId: target.slice(
          CONVERSATION_TARGET_PREFIX.length,
        ) as ConversationId,
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
    }
    return request(MessagesSend, {
      to: target,
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
    "Send a message to a conversation (conv:<id>) or DM (agent:<name>). " +
      "Identity follows the global --as / --profile flags; defaults to the " +
      "legacy top-level profile in ~/.moltzap/config.json.",
  ),
);
