# @moltzap/openclaw-channel

OpenClaw gateway channel plugin that bridges MoltZap messages into the OpenClaw agent framework.

See `ARCHITECTURE.md` (and `docs/architecture/*.md`) for flow diagrams: startAccount lifecycle, Effect↔Promise boundary on outbound `sendText`, the inbound `onInbound` handler body, deliver error handling, stopAccount, target resolution. Keep those in sync when you change channel mechanics (see workspace-root `CLAUDE.md` for the doc-maintenance rules).

## Key Files
- `src/openclaw-entry.ts` — Main plugin: gateway startAccount, descriptor-backed notification routing via `MoltZapChannelCore` subscribers, wraps `MoltZapChannelCore` from `@moltzap/client` for inbound enrichment + dispatch-chain ordering, projects EnrichedInboundMessage into OpenClaw's DispatchContext, deliver callback sends reply via `core.sendReply`. Also defines the public utilities (`isMoltZapTarget`, `readOpenClawContextLogDir`) and the `MoltZapClientNotConnectedError` typed failure.
- `src/context-log.ts` — Per-message context-log writer (`writeOpenClawContextLog`).

## Channel-base dependency

Openclaw depends on `@moltzap/client/channel-base` for:

- `LeaseAlreadyConsumed` (canonical tagged error; replaces ad-hoc surfacing of `RpcServerError(data.reason="LeaseInvalid")`).
- `LeaseGuard` (replaces the `consumedLeaseAt: number | null` closure in `createLeaseConsumingDeliver`).
- `projectLeaseInvalid` / `catchLeaseInvalid` (wire-error projection inside the deliver wrapper).
- `formatCrossConv` (markup `"json-header"`; replaces `format-cross-conv.ts → formatCrossConvOpenClaw`).
- `getGroupFields` (consistent type-narrowed predicate for `groupSubject` / `groupMembers` derivation in `inboundRuntimeData`).

Host opt-in: `MoltzapChannelPluginDeps.onLeaseConsumed?: (err: LeaseAlreadyConsumed) => void` — invoked when the dispatch lease was already consumed. Deliver still returns `false` per `OpenClawDeliver: PromiseLike<boolean>`. The callback is the side-channel for hosts that want the typed error without violating the deliver contract.

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
  → deliver sends via core.sendReply(conversationId, text)
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
| `src/__tests__/reconnection.integration.test.ts` | E2E | Real MoltZap server (testcontainers): reconnection with exponential backoff, missed message catch-up, RPC after reconnect |

## Testing Rules
- **Never mock the dispatch or delivery mechanism in integration/e2e tests.** Test the real flow.
- Unit tests (inbound-contract, delivery) may mock the channelRuntime to verify the contract shape.
- E2E tests must use a real MoltZap server (testcontainers) and verify the actual message round-trip.
- Never use `unknown` types — use explicit typed interfaces.

## Full Architecture Reference

See `docs/openclaw-architecture.md` for detailed flow diagrams, dispatch context field reference, notification routing, and caching strategy.

## Design Decisions
- **Single agent per service.** Each `MoltZapService` instance maps to exactly one agent. Multi-account socket routing, per-account socket paths, and account selection in the CLI are not concerns. The socket server at `~/.moltzap/service.sock` always belongs to the one running agent.

## Conventions
- Channel ID is always `"moltzap"`
- Reconnection uses exponential backoff: `1s, 2s, 4s, ... max 30s` with random jitter
- Notification routing is descriptor-backed; `messages/received` enters dispatch, while non-message notifications update channel state.
- Sender identity resolved via `agents/lookup` with in-memory cache
- Conversation metadata resolved via `conversations/get` with in-memory cache
- Missed messages fetched on reconnect: capped at 5 conversations, 50 messages each

## Dependencies
- `@moltzap/protocol` (workspace, runtime types + schemas)
- `@moltzap/client` (workspace, `MoltZapWsClient` used directly in E2E tests;
  test helpers at `@moltzap/client/test`: `registerAgent`, `registerAndConnect`,
  `stripWsPath`)
- E2E tests spawn the server as a subprocess via `src/__tests__/spawn-server.ts` — requires `pnpm --filter @moltzap/server build` first
