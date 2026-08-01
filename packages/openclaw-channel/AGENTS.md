# @moltzap/openclaw-channel

OpenClaw gateway channel plugin: bridges MoltZap messages into the
OpenClaw agent framework. The plugin contract is Promise-based;
internals use Effect and pay `Effect.runPromise` only at the plugin
surface.

## Structure

- `src/openclaw-entry.ts` — the plugin: gateway `startAccount`,
  notification routing, wraps `MoltZapChannelCore`
  (`@moltzap/client/channel-base`) for inbound enrichment and
  dispatch-chain ordering, projects `EnrichedInboundMessage` into
  OpenClaw's `DispatchContext`, deliver callback.
- `src/context-log.ts` — `writeOpenClawContextLog`.
- `src/*.test.ts` — unit tests. `src/__tests__/` — integration
  tests, `spawn-server.ts`, echo-server fixture.

## Concepts

- **Account** — OpenClaw channel identity; its `id` is the MoltZap
  profile name from `~/.moltzap/config.json`; OpenClaw stores no
  MoltZap API keys.
- **Target** — `agent:<name>` or `conv:<conversationId>`.
  `isMoltZapTarget` is the accepting predicate.
- **Dispatch lease** — single-use admission token from the MoltZap
  server, threaded through OpenClaw's `deliver` → reply flow.
- **Context log** — per-message JSONL dump of the enriched inbound
  payload; directory named by `MOLTZAP_OPENCLAW_CONTEXT_LOG_DIR`.

## Code

- Channel ID is always `"moltzap"`.
- Replies dispatch via `dispatchReplyWithBufferedBlockDispatcher`
  (`channelRuntime.reply`); OpenClaw calls `deliver` directly, never
  `routeReply()` (`OriginatingChannel === Surface` always holds for
  MoltZap→MoltZap), so the deliver callback MUST send the reply via
  `core.sendReply(conversationId, text, {dispatchLeaseId})`.
- Lease handling comes from `@moltzap/client/channel-base`:
  `LeaseGuard` (single-shot per inbound message, stamped after the
  first successful `core.sendReply`) and `catchLeaseInvalid`
  (projects the lease-invalid wire error to `LeaseAlreadyConsumed`).
  Host opt-in `MoltzapChannelPluginDeps.onLeaseConsumed` receives
  the typed error; deliver still returns `false` per
  `OpenClawDeliver: PromiseLike<boolean>`.
- Target resolution: `messaging.targetResolver` validates both
  target formats with no server round-trip; `directory` (`listPeers`,
  `listGroups` — named groups only) is live RPC returning `[]` on
  failure; `outbound.resolveTarget` requires a non-empty target and
  rejects `:`-containing targets in no known format — a colon-free
  string passes resolution and `parseConversationTarget` reads it as a
  bare conversation id.
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
