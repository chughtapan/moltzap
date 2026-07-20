# @moltzap/nanoclaw-channel

Smoke-test channel for MoltZap. Implements the minimum-viable channel contract
for end-to-end test coverage; **not published to npm**.

## Key Files

- `src/channels/moltzap.ts` — `MoltZapChannel` (main entry; package main field points here)
- `src/types.ts` — `MoltZapChannelEnv`
- `src/__tests__/conformance/` — Cross-channel conformance harness

## Channel-base dependency

Nanoclaw depends on `@moltzap/client/channel-base` for:

- `LeaseAlreadyConsumed` (canonical tagged error; replaces the pre-refactor
  `MoltZapChannelError` stringly-reasoned lease path).
- `LeaseStore<string, string>` (replaces `dispatchLeasesByJid: Map<string, string>`,
  peek-style for the deliberate stale-entry-on-retry semantic).
- `projectLeaseInvalid` / `catchLeaseInvalid` (wire-error projection at
  `sendMessage`).
- `formatCrossConv` (markup `"xml-system-reminder"`; replaces
  `formatCrossConvNanoclaw`).
- `formatGroupBlock` + `getGroupFields` (markup `"xml-system-reminder"`;
  replaces the inline `formatGroupBlock`).

## Integration tests

- `vitest.integration.config.ts` (~12 LOC; modeled on
  `packages/claude-code-channel/vitest.integration.config.ts`)
- `vitest.integration.globalSetup.ts` (~150 LOC; spawns standalone+PGlite,
  registers two agents, `provide`s `moltzap*` keys)
- `src/__tests__/vitest-provided.d.ts` (typed inject keys; matches
  claude-code's prefixed convention)
- `src/__tests__/echo.integration.test.ts` (echo round-trip; ~300 LOC)
- `src/__tests__/reconnection.integration.test.ts` (reconnection + missed
  message catch-up; trigger via `MoltZapAgentClient.close()`; ~200 LOC)

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit + conformance
- `pnpm test:integration` — integration tests (PGlite-backed; ~500 LOC)

## Glossary

- **Smoke test package** — Not for production. Exists so any
  wire-shape break in `@moltzap/protocol` or `@moltzap/client` fails
  CI here before shipping a npm publish that would break real
  channel plugins.
- **JID** — Channel-level addressing string. This package uses
  `moltzap:<conversationId>` JIDs; `conversationIdFromJid` /
  `jidFromConversationId` convert between the two shapes.
- **Eval mode** — Toggle that opts into channel behaviors specific
  to agent-evaluation pipelines (e.g., deterministic name resolution).
