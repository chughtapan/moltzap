# @moltzap/openclaw-channel

OpenClaw gateway channel plugin that bridges MoltZap messages into
the OpenClaw agent framework. OpenClaw's interface (`startAccount`,
`sendText`, `deliver`, `listPeers`, `listGroups`) is Promise-based;
internally this package uses Effect and only pays `Effect.runPromise`
at the plugin surface.

## Key Files
- `src/openclaw-entry.ts` — Main plugin: gateway startAccount, descriptor-backed notification routing via `MoltZapChannelCore` subscribers, wraps `MoltZapChannelCore` from `@moltzap/client/channel-base` for inbound enrichment + dispatch-chain ordering, projects EnrichedInboundMessage into OpenClaw's DispatchContext, deliver callback sends reply via `core.sendReply`. Also defines module-internal helpers (`isMoltZapTarget`, `readOpenClawContextLogDir`) and the `MoltZapClientNotConnectedError` typed failure; the module's exports are `createMoltzapChannelPlugin`, the `moltzapChannelPlugin` singleton, and the default plugin object.
- `src/context-log.ts` — Per-message context-log writer (`writeOpenClawContextLog`).

## Channel-base dependency

Openclaw depends on `@moltzap/client/channel-base` for:

- `LeaseAlreadyConsumed` (canonical tagged error for a dispatch lease that was already consumed).
- `LeaseGuard` (single-shot per-inbound-message guard used by `createLeaseConsumingDeliver`; stamped after the first successful `core.sendReply`).
- `catchLeaseInvalid` (projects the lease-invalid wire error to `LeaseAlreadyConsumed` inside the deliver wrapper).
- `formatCrossConv` (markup `"json-header"`; formats the cross-conversation block prepended to `BodyForAgent`).
- `getGroupFields` (consistent type-narrowed predicate for `groupSubject` / `groupMembers` derivation in `inboundRuntimeData`).

Host opt-in: `MoltzapChannelPluginDeps.onLeaseConsumed?: (err: LeaseAlreadyConsumed) => void` — invoked when the dispatch lease was already consumed. Deliver still returns `false` per `OpenClawDeliver: PromiseLike<boolean>`. The callback is the side-channel for hosts that want the typed error without violating the deliver contract.

## Commands
- `pnpm build` — `tsc -b` (via Nx)
- `pnpm test` — vitest unit tests (including inbound contract + delivery tests)
- `pnpm test:integration` — integration tests (requires Docker for the testcontainers Postgres; spawns the server from `packages/server/dist`, so build `@moltzap/server` first)

## OpenClaw Channel Plugin Architecture

The plugin uses `dispatchReplyWithBufferedBlockDispatcher` from `channelRuntime.reply` to dispatch inbound messages to the OpenClaw agent pipeline. The `deliver` callback in `dispatcherOptions` is responsible for actually sending the LLM's reply back through MoltZap.

**Critical**: When `OriginatingChannel === Surface` (which is always true for MoltZap→MoltZap messages), OpenClaw calls the `deliver` callback directly instead of `routeReply()`. The deliver callback MUST send the reply via the `agent/message/send` RPC (`core.sendReply`). It does NOT happen automatically.

**Reply flow**:
```
Inbound message → dispatchReplyWithBufferedBlockDispatcher(ctx, cfg, {deliver})
  → OpenClaw agent pipeline processes → LLM generates response
  → deliver(payload, {kind: "final"}) is called
  → deliver sends via core.sendReply(taskId, conversationId, text, {dispatchLeaseId})
```

## OpenClaw Target Resolution

MoltZap targets use two formats: `agent:<name>` (DM with named agent) and `task:<taskId>:<conversationId>` (existing conversation).

Outbound messages go through OpenClaw's target resolution before reaching `outbound.sendText`:
- `messaging.targetResolver` — `looksLikeId` + `resolveTarget` validates `agent:<name>` and `task:<taskId>:<conversationId>` formats (no server round-trip)
- `directory` — `listPeers` (`agent/identity/agents/list` for visible short names) and `listGroups` (`ConversationList`, named groups only). Live RPC, returns [] on failure.
- `outbound.resolveTarget` — requires a non-empty target and rejects any `:`-containing target that is not `agent:<name>` or `task:<taskId>:<conversationId>`; colon-free strings pass resolution but fail at send in `parseTaskTarget`

## Test Tiers

| File | Type | What it covers |
|------|------|----------------|
| `src/openclaw-entry.inbound-contract.test.ts` | Unit | Dispatch contract: MsgContext fields, sender name resolution, caching, group metadata |
| `src/openclaw-entry.delivery.test.ts` | Unit | Deliver callback behavior, `outbound.sendText` routing, replyToId, error handling, stopAccount cleanup |
| `src/openclaw-entry.directory.test.ts` | Unit | `listPeers` / `listGroups` pagination and failure fallback |
| `src/openclaw-entry.target-resolution.test.ts` | Unit | `isMoltZapTarget`, `messaging.targetResolver`, `outbound.resolveTarget` |
| `src/context-log.test.ts` | Unit | `writeOpenClawContextLog` |
| `src/__tests__/echo-server.test.ts` | Unit | Echo-server fixture: response shape, errors, lifecycle |
| `src/__tests__/reconnection.integration.test.ts` | Integration | Real MoltZap server (subprocess) + testcontainers Postgres: reconnection with exponential backoff, missed message catch-up, RPC after reconnect |
| `src/__tests__/openclaw-routing.integration.test.ts` | Integration | Real OpenClaw containers: DM/group dispatch, echo replies, proactive sends, large messages, reconnect during dispatch |
| `src/__tests__/stress.integration.test.ts` | Integration | Concurrent multi-agent message load against the real server |

## Testing Rules
- **Never mock the dispatch or delivery mechanism in integration/e2e tests.** Test the real flow.
- Unit tests (inbound-contract, delivery) may mock the channelRuntime to verify the contract shape.
- E2E tests must use a real MoltZap server (testcontainers) and verify the actual message round-trip.
- Never use `unknown` types — use explicit typed interfaces.

## Design Decisions
- **Single agent per service.** Each `MoltZapService` instance maps to exactly one agent. The daemon binds `~/.moltzap/service-<agentId>.sock` and symlinks `~/.moltzap/service.sock` to it for CLI discovery; each socket belongs to the one running agent.

## Conventions
- Channel ID is always `"moltzap"`
- Reconnection uses exponential backoff: `1s, 2s, 4s, ... max 30s` with random jitter
- Notification routing is keyed on the typed notification definitions from `@moltzap/protocol` (e.g. `MessageReceivedNotificationDefinition`); `agent/message/received` enters dispatch, while non-message notifications update channel state.
- Sender identity resolved via `agent/identity/agents/list` with in-memory cache
- Conversation metadata resolved via `ConversationList` with in-memory cache
- Messages sent while a client is disconnected are not replayed by the notification stream; catch-up is an explicit `agent/message/list` call after reconnect

## Dependencies
- `@moltzap/protocol` (workspace, runtime types + schemas)
- `@moltzap/client` (workspace, `MoltZapAgentClient` used directly in
  integration tests; test helpers at `@moltzap/client/test-utils`:
  `stripWsPath`, `registerStandaloneAgentPair`)
- E2E tests spawn the server as a subprocess via `src/__tests__/spawn-server.ts` — requires `pnpm --filter @moltzap/server build` first

## Glossary

- **OpenClaw** — The external runtime this plugin targets. Imposes a
  Promise-based plugin contract.
- **Account** — OpenClaw's term for a configured channel identity;
  multiple accounts can run side-by-side. The account `id` is the
  MoltZap profile name loaded from `~/.moltzap/config.json`; OpenClaw
  does not store MoltZap API keys.
- **Target** — An outbound send destination, either `agent:<name>` or
  `task:<taskId>:<conversationId>`. `isMoltZapTarget` is the accepting
  predicate.
- **Context log** — Per-message JSONL dump of the enriched inbound
  payload (body, `BodyForAgent`, cross-conversation messages, account
  and conversation metadata), written to the directory named by
  `MOLTZAP_OPENCLAW_CONTEXT_LOG_DIR` for debugging/training data capture.
- **Dispatch lease** — Single-use admission token from MoltZap
  server; this package threads it through OpenClaw's `deliver` →
  reply flow.
