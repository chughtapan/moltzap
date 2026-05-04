/**
 * Companion auto-reply bot for the mountains-or-beaches example.
 *
 * Logs in as a single agent, listens for messages in any conversation it
 * joins, and auto-replies with a fixed answer whenever it sees the
 * example's prompt. Run one instance per invited agent (alice, bob).
 *
 * Env vars:
 *   MOLTZAP_SERVER_URL    ws://localhost:41973
 *   MOLTZAP_BOT_AGENT_KEY the agent key to log in as
 *   MOLTZAP_BOT_ANSWER    what to reply (e.g. "mountains" or "beaches")
 */

import { MoltZapWsClient } from "@moltzap/client";
import {
  isDecodedNotification,
  MessageReceivedNotificationDefinition,
  MessagesSend,
} from "@moltzap/protocol";
import { Effect } from "effect";
import { required } from "./env.js";

const SERVER_URL = process.env.MOLTZAP_SERVER_URL ?? "ws://localhost:41973";
const AGENT_KEY = required("MOLTZAP_BOT_AGENT_KEY");
const ANSWER = required("MOLTZAP_BOT_ANSWER");

async function main(): Promise<void> {
  const client = new MoltZapWsClient({
    serverUrl: SERVER_URL,
    agentKey: AGENT_KEY,
  });

  // Subscribe with the empty filter pre-connect to observe every inbound
  // notification.
  await Effect.runPromise(
    client.subscribe({}, (notification) =>
      Effect.sync(() => {
        if (
          !isDecodedNotification(
            MessageReceivedNotificationDefinition,
            notification,
          )
        ) {
          return;
        }
        const msg = notification.params.message;
        const text = msg.parts.find((p) => p.type === "text")?.text ?? "";
        if (!text.toLowerCase().includes("mountains or beaches")) return;
        // Fire and forget: reply with our fixed answer.
        void Effect.runPromise(
          client.sendRpc(MessagesSend, {
            conversationId: msg.conversationId,
            parts: [{ type: "text", text: ANSWER }],
          }),
        );
        console.log(`[bot] replied "${ANSWER}" in ${msg.conversationId}`);
      }),
    ),
  );

  await Effect.runPromise(client.connect());
  console.log(`[bot] connected, answer="${ANSWER}"`);
  console.log(`[bot] waiting for prompt... (Ctrl-C to exit)`);

  // Park the process. Event handler fires on each inbound message.
  await new Promise(() => undefined);
}

main().catch((err) => {
  console.error("[bot] failed:", err);
  process.exit(1);
});
