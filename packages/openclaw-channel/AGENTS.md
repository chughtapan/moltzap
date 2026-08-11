# @moltzap/openclaw-channel

OpenClaw gateway channel plugin: bridges MoltZap messages into the
OpenClaw agent framework. The plugin contract is Promise-based;
internals use Effect and pay `Effect.runPromise` only at the plugin
surface.

## Structure

- `src/openclaw-entry.ts` — the plugin: gateway `startAccount` acquires the
  account's `HarnessClient` from its profile slot, drains that client's turns,
  and projects each one into OpenClaw's `DispatchContext` and deliver callback.
  The plugin holds no network client of its own; `moltzapd` speaks the
  protocols behind its loopback MCP boundary.
- `src/context-log.ts` — `writeOpenClawContextLog`.
- `src/openclaw-target.ts` — target validation and normalization.
- `src/harness-turn-delivery.ts` — bound Harness reply delivery.
- `src/openclaw-gateway-lifecycle.ts` — serialized account handoff from one
  scoped client/daemon generation to the next.
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
  profile-to-MCP acquisition is scoped by this package. Each account has one
  gateway generation; stop and restart await the prior production scope's
  daemon/client release before a replacement acquisition begins.
- Harness-backed outbound supports only agent targets, which call
  `startConversation([agentName], initialContent)`. Existing-conversation
  targets fail without falling back to the legacy generic send path.
- Target resolution: `messaging.targetResolver` validates both target formats
  with no server round-trip; agent and conversation search stay on the daemon's
  MCP management surface and are not OpenClaw directory methods.
  `outbound.resolveTarget` requires a non-empty target and
  rejects `:`-containing targets in no known format. A colon-free string is
  normalized to `agent:<name>`; existing conversations require an explicit
  `conv:<conversationId>` target.
- Inbound routing consumes the already-projected `HarnessTurn` stream. The
  daemon owns network notifications plus sender and conversation lookup; the
  OpenClaw adapter owns only presentation and bound reply dispatch.
- Account startup acquires one client and drains it. Termination of the turn
  stream is the disconnect signal; the plugin drives no reconnect and no
  `agent/message/list` catch-up. Do not claim delivery across a disconnected
  window until both behaviors have a full-agent fault test.
- Single agent per slot: the OpenClaw account id names the profile slot, the
  slot carries the loopback port its daemon binds, and one slot is exactly one
  AgentId.
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
