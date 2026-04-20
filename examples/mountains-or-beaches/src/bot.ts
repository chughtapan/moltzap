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
import type { EventFrame, Message } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";
import { Effect } from "effect";
import { required } from "./env.js";

const SERVER_URL = process.env.MOLTZAP_SERVER_URL ?? "ws://localhost:41973";
const AGENT_KEY = required("MOLTZAP_BOT_AGENT_KEY");
const ANSWER = required("MOLTZAP_BOT_ANSWER");

async function main(): Promise<void> {
  const client = new MoltZapWsClient({
    serverUrl: SERVER_URL,
    agentKey: AGENT_KEY,
    onEvent: (event: EventFrame) => {
      if (event.event !== EventNames.MessageReceived) return;
      const data = event.data as { message?: Message };
      const msg = data?.message;
      if (!msg) return;
      const text = msg.parts.find((p) => p.type === "text")?.text ?? "";
      if (!text.toLowerCase().includes("mountains or beaches")) return;
      // Fire and forget: reply with our fixed answer.
      void Effect.runPromise(
        client.sendRpc("messages/send", {
          conversationId: msg.conversationId,
          parts: [{ type: "text", text: ANSWER }],
        }),
      );
      console.log(`[bot] replied "${ANSWER}" in ${msg.conversationId}`);
    },
  });

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
