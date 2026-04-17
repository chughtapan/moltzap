/**
 * mountains-or-beaches — the minimal MoltZap app.
 *
 * Logs in as an orchestrator agent, invites two other agents into a
 * session, asks one question, waits for both to reply, prints the tally,
 * exits.
 *
 * Env vars (see `scripts/quickstart.sh` for how these get populated):
 *   MOLTZAP_SERVER_URL         ws://localhost:41973
 *   MOLTZAP_APP_AGENT_KEY      key of the agent the app logs in as
 *   MOLTZAP_APP_AGENT_ID       that agent's id (filters our own echoes)
 *   MOLTZAP_INVITED_AGENT_IDS  comma-separated agent ids to invite
 */

import { MoltZapApp, type Message } from "@moltzap/app-sdk";
import { required } from "./env.js";

const SERVER_URL = process.env.MOLTZAP_SERVER_URL ?? "ws://localhost:41973";
const APP_AGENT_KEY = required("MOLTZAP_APP_AGENT_KEY");
const APP_AGENT_ID = required("MOLTZAP_APP_AGENT_ID");
const INVITED_AGENT_IDS = required("MOLTZAP_INVITED_AGENT_IDS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const APP_ID = "mountains-or-beaches";
const PROMPT = "mountains or beaches? reply in one word.";
const EXPECTED_REPLIES = INVITED_AGENT_IDS.length;
const REPLY_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const app = new MoltZapApp({
    serverUrl: SERVER_URL,
    agentKey: APP_AGENT_KEY,
    appId: APP_ID,
    invitedAgentIds: INVITED_AGENT_IDS,
  });

  const tally = { mountains: 0, beaches: 0, other: 0 };
  const replied = new Set<string>();

  app.onSessionReady((handle) => {
    console.log(
      `[app] session ready: ${handle.id} ` +
        `· conversation: ${handle.conversations["default"]}`,
    );
  });

  app.onMessage("default", (message: Message) => {
    if (message.senderId === APP_AGENT_ID) return; // ignore our own prompt
    if (replied.has(message.senderId)) return; // one reply per agent
    replied.add(message.senderId);

    const text = message.parts.find((p) => p.type === "text")?.text ?? "";
    const word = text.trim().toLowerCase();
    const bucket: keyof typeof tally = word.includes("mountain")
      ? "mountains"
      : word.includes("beach")
        ? "beaches"
        : "other";
    tally[bucket] += 1;
    console.log(`[agent ${message.senderId}] ${text}  →  ${bucket}`);

    if (replied.size >= EXPECTED_REPLIES) finish(0);
  });

  let watchdog: NodeJS.Timeout | undefined;

  function finish(code: number): void {
    if (watchdog) clearTimeout(watchdog);
    const parts = [`mountains ${tally.mountains}`, `beaches ${tally.beaches}`];
    if (tally.other > 0) parts.push(`other ${tally.other}`);
    console.log(`[tally] ${parts.join(" · ")}`);
    void app.stopAsync().then(() => process.exit(code));
  }

  await app.startAsync();
  console.log(`[app] registered as "${APP_ID}"`);

  await app.sendAsync("default", [{ type: "text", text: PROMPT }]);
  const noun = EXPECTED_REPLIES === 1 ? "reply" : "replies";
  console.log(`[app] sent prompt. waiting for ${EXPECTED_REPLIES} ${noun}...`);

  // Bail out rather than hang forever if someone forgets to start the bots.
  watchdog = setTimeout(() => {
    console.error(
      `[app] timed out after ${REPLY_TIMEOUT_MS / 1000}s: ` +
        `got ${replied.size}/${EXPECTED_REPLIES} replies`,
    );
    finish(1);
  }, REPLY_TIMEOUT_MS);
}

main().catch((err) => {
  console.error("[app] failed:", err);
  process.exit(1);
});
