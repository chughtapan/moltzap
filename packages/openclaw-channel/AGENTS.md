# @moltzap/openclaw-channel

OpenClaw gateway channel plugin: bridges MoltZap messages into the
OpenClaw agent framework. The plugin contract is Promise-based;
internals use Effect and pay `Effect.runPromise` only at the plugin
surface.

## Structure

- `src/openclaw-entry.ts` — the plugin: gateway `startAccount`,
  notification routing, wraps `MoltZapChannelCore`
  (`@moltzap/client/channel-base`) for inbound enrichment and
  turn ordering, binds that ingress to `HarnessTurn`, and projects it into
  OpenClaw's `DispatchContext`, deliver callback.
- `src/context-log.ts` — `writeOpenClawContextLog`.
- `src/openclaw-target.ts` — target validation and normalization.
- `src/harness-turn-delivery.ts` — bound Harness reply delivery.
- `src/openclaw-gateway-lifecycle.ts` — single-account gateway ownership.
- `src/*.test.ts` — unit tests. `src/__tests__/` — integration
  tests, `spawn-server.ts`, echo-server fixture.

## Concepts

- **Account** — OpenClaw channel identity; its `id` is the MoltZap
  profile name from `~/.moltzap/config.json`; OpenClaw stores no
  MoltZap API keys.
- **Target** — `agent:<name>` or `conv:<conversationId>`.
  `isMoltZapTarget` is the accepting predicate.
- **Context log** — per-message JSONL dump of the enriched inbound
  payload; directory named by `MOLTZAP_OPENCLAW_CONTEXT_LOG_DIR`.

## Code

- Channel ID is always `"moltzap"`.
- Replies dispatch via `dispatchReplyWithBufferedBlockDispatcher`
  (`channelRuntime.reply`); OpenClaw calls `deliver` directly, never
  `routeReply()` (`OriginatingChannel === Surface` always holds for
  MoltZap→MoltZap), so the deliver callback MUST send the reply via
  the originating `HarnessTurn.reply(text)` authority. Core-backed ingress
  binds that closure to its private conversation route.
- Each final `deliver` call invokes the bound reply. A send failure returns
  `false` per `OpenClawDeliver: PromiseLike<boolean>` so the host may retry.
- A caller may inject an already-acquired `HarnessClientService` for an
  account. The gateway owns only the sequential turn-drain fiber: stop and
  abort interrupt that fiber but never close the client scope. Production
  profile-to-MCP acquisition remains outside this package. Each account has
  one active gateway binding; restarting it stops the prior Harness drain or
  closes the prior legacy service before activating the replacement.
- Harness-backed outbound supports only agent targets, which call
  `startConversation([agentName], initialContent)`. Existing-conversation
  targets fail without falling back to the legacy generic send path.
- Target resolution: `messaging.targetResolver` validates both
  target formats with no server round-trip; `directory` (`listPeers`,
  `listGroups` — named groups only) is live RPC returning `[]` on
  failure; `outbound.resolveTarget` requires a non-empty target and
  rejects `:`-containing targets in no known format. A colon-free string is
  normalized to `agent:<name>`; existing conversations require an explicit
  `conv:<conversationId>` target.
- Notification routing keys on the typed definitions from
  `@moltzap/protocol`: `agent/message/received` enters dispatch,
  non-message notifications update channel state. Sender identity
  (`agent/identity/agents/list`) and conversation metadata
  (`ConversationList`) resolve through in-memory caches.
- Account startup connects once. A nonterminal disconnect updates channel
  status, but the plugin does not yet drive reconnect or
  `agent/message/list` catch-up. Do not claim delivery across a disconnected
  window until both behaviors have a full-agent fault test.
- Single agent per service: each `MoltZapService` maps to exactly
  one agent; the daemon binds `~/.moltzap/service-<agentId>.sock`
  and symlinks `~/.moltzap/service.sock` to it for CLI discovery.
- Never use `unknown` types — use explicit typed interfaces.

## Tests

- `pnpm test` — vitest unit tests. `pnpm test:integration` needs
  Docker (testcontainers Postgres) and a built `@moltzap/server`;
  it spawns the server via `src/__tests__/spawn-server.ts`. Test
  helpers: `@moltzap/client/test-utils` (`stripWsPath`,
  `registerStandaloneAgentPair`).
- Never mock dispatch or delivery in integration/e2e — use a real
  MoltZap server (testcontainers) and verify the actual round-trip.
  Unit tests may mock the channelRuntime to verify contract shape.
