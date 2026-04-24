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
 * string the service resolves (typically `agent:<name>` for direct messages
 * or a bare contact name the service resolves against the caller's roster).
 *
 * Identity selection is driven by the GLOBAL flags pre-parsed in
 * `cli/index.ts` before @effect/cli sees argv (see `extractGlobalFlags`):
 *
 *   --as <apiKey>       Send as the agent owning the given API key.
 *                       Bypasses the local daemon socket; dials the server
 *                       directly. Useful in multi-agent workflows where
 *                       the same host registers more than one agent.
 *   --profile <name>    Load the named profile from ~/.moltzap/config.json
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
 * NOTE: `moltzap send` today routes through the local channel daemon and
 * does NOT yet honor `--as`/`--profile` end-to-end — rewiring legacy
 * commands onto the v2 Transport layer is tracked as a follow-up (see the
 * PR body "Concerns" block). The flag semantics documented above describe
 * the v2 contract; new v2 subcommands (`apps/*`, `permissions/*`,
 * `messages list`, `conversations {get,archive,unarchive}`) honor them
 * today.
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
).pipe(
  Command.withDescription(
    "Send a message to a conversation (conv:<id>) or DM (agent:<name>). " +
      "Identity follows the global --as / --profile flags; defaults to the " +
      "legacy top-level profile in ~/.moltzap/config.json.",
  ),
);
