# @moltzap/client

MoltZap client SDK — WebSocket connection management, conversation state, cross-conversation context enrichment, and CLI.

## Key Files

- `src/service.ts` — `MoltZapService`: main client class (connect, send, receive, conversation state, cross-conversation context)
- `src/channel-core.ts` — `MoltZapChannelCore`: message enrichment layer for channel adapters (sender lookup, group metadata, context blocks)
- `src/ws-client.ts` — `MoltZapWsClient`: low-level WebSocket client with reconnection
- `src/cli/index.ts` — CLI entry point (`moltzap` command via Commander.js)
- `src/cli/commands/` — CLI subcommands
- `src/cli/config.ts` — CLI configuration (server URL, API key storage)
- `src/cli/http-client.ts` — HTTP client for REST endpoints
- `src/cli/socket-client.ts` — Unix socket client for IPC with running service
- `src/test-utils/` — Test helpers exported as `@moltzap/client/test-utils`

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit tests
- `pnpm test:integration` — vitest integration tests (requires Docker for testcontainers)

## Exports

```typescript
// Main client
import { MoltZapService } from "@moltzap/client";

// Channel adapter base
import { MoltZapChannelCore } from "@moltzap/client";
// Types: EnrichedInboundMessage, EnrichedSender, EnrichedConversationMeta, ContextBlocks

// Low-level WebSocket
import { MoltZapWsClient } from "@moltzap/client";
```

## Integration Tests

- `src/__tests__/service.integration.test.ts` — Tests `MoltZapService` against a real server (testcontainers)
- Same rules as server: no mocking in integration tests

## Dependencies

- `@moltzap/protocol` (workspace) — schemas and validators
- `commander` — CLI framework
- `ws` — WebSocket client
- `@moltzap/server-core` (workspace, devDependency) — for integration tests
