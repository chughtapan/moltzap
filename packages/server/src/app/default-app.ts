import { Effect } from "effect";
import type { ParamsOf } from "@moltzap/protocol";
import { DispatchAuthorize, MessagesAuthorize } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConnectionId } from "@moltzap/protocol/network";
import { DEFAULT_APP_ID } from "@moltzap/protocol/task";
import { Value } from "@sinclair/typebox/value";
import type { Db } from "../db/client.js";
import { catchSqlErrorAsDefect } from "../db/effect-kysely-toolkit.js";
import type { AppHost } from "./app-host.js";
import { makeLoopbackConnection } from "./loopback-connection.js";

/**
 * Stable loopback connection id for the boot-installed default app.
 * UUID v4 in the all-zeros + 4xxx + 8xxx namespace so it slots
 * cleanly under `brandedId("ConnectionId")` (UUID format) without
 * colliding with any client-minted id (which use `crypto.randomUUID`
 * → random 128-bit values).
 */
const DEFAULT_APP_CONNECTION_ID = Value.Decode(
  ConnectionId,
  "00000000-0000-4000-8000-000000000001",
);

/**
 * Boot-time installation of the default app. Wires a loopback
 * `MoltZapConnection` whose `originator.call` dispatches in-process
 * — from AppHost's perspective, this is identical to a wire-registered
 * app. The two task-callback handlers:
 *
 *   - `dispatch/authorize` → always `grant`. Unmoderated semantic.
 *   - `messages/authorize` → query `conversation_participants`,
 *     return `Forward { recipients: participants \ sender }`. The
 *     default forward policy that used to live as a server fall-through
 *     is now an explicit hook, owned by the default app.
 *
 * TM-only RPCs remain unreachable on DEFAULT_APP_ID tasks because
 * `isAppConnection` compares caller connectionId against the
 * loopback's id — no client connection can ever match.
 */
export function installDefaultApp(appHost: AppHost, db: Db): void {
  const connection = makeLoopbackConnection({
    id: DEFAULT_APP_CONNECTION_ID,
    handlers: {
      [DispatchAuthorize.name]: () =>
        Effect.succeed({ admission: { decision: "grant" as const } }),
      [MessagesAuthorize.name]: (params: ParamsOf<typeof MessagesAuthorize>) =>
        catchSqlErrorAsDefect(
          Effect.gen(function* () {
            const rows = yield* db
              .selectFrom("conversation_participants")
              .select("agent_id")
              .where("conversation_id", "=", params.conversationId);
            const recipients = rows
              .map((r) => r.agent_id as AgentId)
              .filter((a) => a !== params.message.senderAgentId);
            return {
              verdict: { decision: "Forward" as const, recipients },
            };
          }).pipe(Effect.withSpan("defaultApp.messagesAuthorize")),
        ),
    },
  });
  appHost.registerApp({ appId: DEFAULT_APP_ID, name: "Default" }, connection);
}
