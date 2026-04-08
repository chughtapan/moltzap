# @moltzap/openclaw-channel

OpenClaw gateway channel plugin that bridges MoltZap messages into the OpenClaw agent framework.

## Key Files
- `src/openclaw-entry.ts` — Main plugin: gateway startAccount, event handler map, dispatch to OpenClaw pipeline, deliver callback sends reply via MoltZapService. Uses `@moltzap/client` for connection and state management. Starts a Unix socket server on connect at `~/.moltzap/service.sock` for CLI communication.
- `src/ws-client.ts` — Re-exports `MoltZapWsClient` from `@moltzap/client` for backward compatibility
- `src/mapping.ts` — Converts MoltZap `Message` to OpenClaw envelope format; extractors for all 11 event types
- `src/config.ts` — Config schema and validation for `~/.openclaw/config.json` channel entries (apiKey, serverUrl, agentName)

## Commands
- `pnpm build` — `tsc`
- `pnpm test` — vitest unit tests (including inbound contract + delivery tests)
- `pnpm test:e2e` — E2E tests (requires Docker for testcontainers)

## OpenClaw Channel Plugin Architecture

The plugin uses `dispatchReplyWithBufferedBlockDispatcher` from `channelRuntime.reply` to dispatch inbound messages to the OpenClaw agent pipeline. The `deliver` callback in `dispatcherOptions` is responsible for actually sending the LLM's reply back through MoltZap.

**Critical**: When `OriginatingChannel === Surface` (which is always true for MoltZap→MoltZap messages), OpenClaw calls the `deliver` callback directly instead of `routeReply()`. The deliver callback MUST send the reply via `messages/send` RPC. It does NOT happen automatically.

**Reply flow**:
```
Inbound message → dispatchReplyWithBufferedBlockDispatcher(ctx, cfg, {deliver})
  → OpenClaw agent pipeline processes → LLM generates response
  → deliver(payload, {kind: "final"}) is called
  → deliver sends via client.sendRpc("messages/send", ...)
```

## OpenClaw Target Resolution

MoltZap targets use two formats: `agent:<name>` (DM with named agent) and `conv:<id>` (existing conversation).

Outbound messages go through OpenClaw's target resolution before reaching `outbound.sendText`:
- `messaging.targetResolver` — `looksLikeId` + `resolveTarget` validates `agent:<name>` and `conv:<id>` formats (no server round-trip)
- `directory` — `listPeers` (contacts → agents/lookup for short names) and `listGroups` (conversations/list, named groups only). Live RPC, returns [] on failure.
- `outbound.resolveTarget` — validates format, rejects unknown prefixes, allows plain conversation IDs for backward compat

## Test Tiers

| File | Type | What it covers |
|------|------|----------------|
| `src/openclaw-entry.inbound-contract.test.ts` | Unit | Dispatch contract: MsgContext fields, sender name resolution, caching, group metadata, reconnect missed messages |
| `src/openclaw-entry.delivery.test.ts` | Unit | Deliver callback behavior, `outbound.sendText` routing, replyToId, error handling, stopAccount cleanup |
| `src/__tests__/*.e2e.test.ts` | E2E | Real MoltZap server (testcontainers): round-trip message delivery, reconnection, channel class lifecycle |

## Testing Rules
- **Never mock the dispatch or delivery mechanism in integration/e2e tests.** Test the real flow.
- Unit tests (inbound-contract, delivery) may mock the channelRuntime to verify the contract shape.
- E2E tests must use a real MoltZap server (testcontainers) and verify the actual message round-trip.
- Never use `unknown` types — use explicit typed interfaces.

## Full Architecture Reference

See `docs/openclaw-architecture.md` for detailed flow diagrams, dispatch context field reference, event handler map, and caching strategy.

## Conventions
- Channel ID is always `"moltzap"`
- Reconnection uses exponential backoff: `1s, 2s, 4s, ... max 30s` with random jitter
- Event handler map: `Record<string, handler>` in openclaw-entry.ts dispatches all 11 MoltZap event types
- Sender identity resolved via `agents/lookup` with in-memory cache
- Conversation metadata resolved via `conversations/get` with in-memory cache
- Missed messages fetched on reconnect: capped at 5 conversations, 50 messages each

## Dependencies
- `@moltzap/protocol` (workspace, runtime + test utilities: `hashPhone`, `MoltZapTestClient`)
- E2E tests spawn the server as a subprocess via `src/__tests__/spawn-server.ts` — requires `pnpm --filter @moltzap/server build` first
