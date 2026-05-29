import { Effect } from "effect";
import type { ParamsOf } from "@moltzap/protocol";
import {
  DispatchAuthorize,
  MessagesAuthorize,
  TaskCreate,
} from "@moltzap/protocol";
import { ConnectionId } from "@moltzap/protocol/network";
import { DEFAULT_APP_ID } from "@moltzap/protocol/task";
import { Value } from "@sinclair/typebox/value";
import type { AppHost, ConversationServiceForAppHost } from "./app-host.js";
import { makeLoopbackConnection } from "./loopback-connection.js";

/**
 * Loopback connection id for the boot-installed default app —
 * server-minted so no client `crypto.randomUUID()` can ever collide
 * with the default app's registered endpoint connId.
 */
const DEFAULT_APP_CONNECTION_ID = Value.Decode(
  ConnectionId,
  "00000000-0000-4000-8000-000000000001",
);

/**
 * Boot-time installation of the default app. Wires a loopback
 * `AppEndpoint` whose `originator.call` dispatches in-process
 * — from AppHost's perspective this is identical to a wire-registered
 * app. The two task-callback handlers:
 *
 *   - `dispatch/authorize` → always `grant`. Unmoderated semantic.
 *   - `messages/authorize` → `Forward { recipients: participants \ sender }`,
 *     reading participants via `ConversationService.getParticipantAgentIds`
 *     (same helper every other server-side participant query uses).
 *
 * TM-admin RPCs (rebound to the app principal) remain unreachable on
 * DEFAULT_APP_ID tasks because no client `AppConnection` can ever own
 * the default app — its endpoint is a server-minted loopback, not a
 * wire-registered `apps/register`.
 */
export function installDefaultApp(
  appHost: AppHost,
  conversation: ConversationServiceForAppHost,
): void {
  const endpoint = makeLoopbackConnection({
    id: DEFAULT_APP_CONNECTION_ID,
    handlers: {
      [DispatchAuthorize.name]: () =>
        Effect.succeed({ admission: { decision: "grant" as const } }),
      [MessagesAuthorize.name]: (params: ParamsOf<typeof MessagesAuthorize>) =>
        Effect.gen(function* () {
          const all = yield* conversation.getParticipantAgentIds(
            params.conversationId,
          );
          const recipients = all.filter(
            (a) => a !== params.message.senderAgentId,
          );
          return {
            verdict: { decision: "Forward" as const, recipients },
          };
        }).pipe(Effect.withSpan("defaultApp.messagesAuthorize")),
      // DEFAULT_APP_ID is unmoderated. Every task/request bound to it
      // is auto-accepted; the requester always sees the task land
      // in `active` synchronously. Wire-registered apps that take
      // over a task's TM slot replace this handler with their own
      // verdict logic.
      [TaskCreate.name]: () =>
        Effect.succeed({ verdict: { decision: "accept" as const } }),
    },
  });
  appHost.registerApp({ appId: DEFAULT_APP_ID, name: "Default" }, endpoint);
}
