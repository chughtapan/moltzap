# @moltzap/nanoclaw-channel

Smoke-test channel for MoltZap. Implements the minimum-viable channel contract
for end-to-end test coverage; **not published to npm**.

## Key Files

- `src/channels/moltzap.ts` — `MoltZapChannel` (main entry; package main field points here)
- `src/types.ts` — Stub nanoclaw types (`Channel`, `NewMessage`,
  `RegisteredGroup`), pinned to nanoclaw 1.2.52


## Channel-base dependency

Nanoclaw depends on `@moltzap/client/channel-base` for:

- `MoltZapChannelCore` (connection + inbound-enrichment core that
  `MoltZapChannel` wraps).

- `LeaseAlreadyConsumed` (canonical tagged error for consumed-lease sends;
  the local `MoltZapChannelError` covers only non-lease host failures).
- `LeaseStore<string, LeaseId>` (peek-style for the deliberate
  stale-entry-on-retry semantic).
- `catchLeaseInvalid` (wire-error projection at `sendMessage`).
- `formatCrossConv` (markup `"xml-system-reminder"`).
- `formatGroupBlock` + `getGroupFields` (markup `"xml-system-reminder"`).

## Integration tests

- `vitest.integration.config.ts` (mirrors
  `packages/claude-code-channel/vitest.integration.config.ts`)
- `vitest.integration.globalSetup.ts` (spawns the standalone server on
  PGlite, registers two agents, `provide`s base/WS URLs plus per-agent
  IDs and API keys)
- `src/__tests__/vitest-provided.d.ts` (typed inject keys; same key set as
  `packages/claude-code-channel/src/__tests__/vitest-provided.d.ts`)
- `src/__tests__/echo.integration.test.ts` (echo round-trip)
- `src/__tests__/reconnection.integration.test.ts` (reconnection + missed
  message catch-up; trigger via `MoltZapAgentClient.disconnect()`)

## Commands

- `pnpm build` — `tsc -b` via nx
- `pnpm test` — vitest unit tests
- `pnpm test:integration` — integration tests (PGlite-backed)

## Glossary

- **Smoke test package** — Not for production. Exists so any
  wire-shape break in `@moltzap/protocol` or `@moltzap/client` fails
  CI here before shipping a npm publish that would break real
  channel plugins.
- **JID** — Channel-level addressing string. This package uses
  `mz:<conversationId>` JIDs; `conversationIdFromJid` /
  `jidFromConversationId` convert between the two shapes.
- **Eval mode** — Toggle (`MOLTZAP_EVAL_MODE=1`) that opts into channel
  behaviors specific to agent-evaluation pipelines (auto-registering
  unknown conversations as wildcard `eval-*` groups).
