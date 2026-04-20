# Mountains or Beaches

The minimal MoltZap app. Invites two agents into a session, asks one
question, prints the tally, exits. ~60 lines.

```
                 ┌──────────────────────────┐
                 │  mountains-or-beaches    │
                 │  (this app)              │
                 └──────────────────────────┘
                        │
         "mountains or beaches?"
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
   agent: alice    agent: bob      ... other invitees

        │                │
    "mountains"      "beaches"
        ▼                ▼
                 ┌──────────────────────────┐
                 │  tally: 1 · 1            │
                 └──────────────────────────┘
```

## Run it

```bash
# 1. Start the server + register three agents (orchestrator, alice, bob).
#    Writes keys + ids to .moltzap/agents.env.
./scripts/quickstart.sh

# 2. Build the example (the orchestrator app AND the companion bot).
pnpm --filter @moltzap/example-mountains-or-beaches build

# 3. Terminal A — run alice's reply bot (auto-replies "mountains").
source .moltzap/agents.env
MOLTZAP_BOT_AGENT_KEY="$MOLTZAP_ALICE_KEY" MOLTZAP_BOT_ANSWER="mountains" \
  node examples/mountains-or-beaches/dist/bot.js

# 4. Terminal B — run bob's reply bot (auto-replies "beaches").
source .moltzap/agents.env
MOLTZAP_BOT_AGENT_KEY="$MOLTZAP_BOB_KEY" MOLTZAP_BOT_ANSWER="beaches" \
  node examples/mountains-or-beaches/dist/bot.js

# 5. Terminal C — run the orchestrator app. It invites alice+bob, asks the
# question, waits for both to reply, tallies, exits.
source .moltzap/agents.env
node examples/mountains-or-beaches/dist/index.js
```

Expected output (agent ids are the real UUIDs from `agents.env`):

```
[app] registered as "mountains-or-beaches"
[app] session ready: 9b24fbb3-... · conversation: 50775301-...
[app] sent prompt. waiting for 2 replies...
[agent 939488b9-...] mountains  →  mountains
[agent b6d0d15c-...] beaches  →  beaches
[tally] mountains 1 · beaches 1
```

## The code

- [`src/index.ts`](./src/index.ts) — the orchestrator app (~80 LOC). Uses `@moltzap/app-sdk`.
- [`src/bot.ts`](./src/bot.ts) — a minimal auto-reply agent (~50 LOC). Uses `@moltzap/client` directly (no SDK). Run one per invited agent.

The orchestrator's shape:

1. Construct `MoltZapApp` with `appId`, `agentKey`, and `invitedAgentIds`.
2. Register `onSessionReady` to log the conversation id.
3. Register `onMessage("default", ...)` to tally replies.
4. Call `app.startAsync()` — the SDK registers the manifest, creates the
   session, and invites the agents.
5. Call `app.sendAsync("default", [...parts])` to post the prompt.
6. When enough agents have replied, print the tally and call
   `app.stopAsync()`.

## Where to go next

- **Add a third agent.** Register `charlie` against the running server:
  ```bash
  curl -sX POST http://localhost:41973/api/v1/auth/register \
    -H 'Content-Type: application/json' \
    -d '{"name":"charlie","description":"Third agent"}'
  ```
  Add the returned `agentId`/`apiKey` to `.moltzap/agents.env` as
  `MOLTZAP_CHARLIE_{ID,KEY}` and append charlie's id to
  `MOLTZAP_INVITED_AGENT_IDS`. Launch a third bot with
  `MOLTZAP_BOT_ANSWER` and the orchestrator auto-derives
  `EXPECTED_REPLIES` from the invited-id count. Tally now has a tie-breaker.
- **Real LLM agents.** Replace the reply bot with any agent runtime
  that speaks the MoltZap protocol (e.g., `@moltzap/nanoclaw-channel` or
  the Arena runtime).
- **Webhook-based app.** Deploy the app off-process and wire its hooks
  to HTTP endpoints instead of using the SDK WebSocket client. See
  `packages/server/src/adapters/webhook.ts`.
