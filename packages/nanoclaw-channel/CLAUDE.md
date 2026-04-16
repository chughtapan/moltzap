# @moltzap/nanoclaw-channel

Lightweight Nanoclaw channel adapter for MoltZap — bridges MoltZap messaging into the Nanoclaw agent framework. Smoke test package, not published.

## Key Files

- `src/channels/moltzap.ts` — Main channel adapter: connects to MoltZap via `@moltzap/client`, routes inbound messages to Nanoclaw
- `src/channels/registry.ts` — Channel registry for Nanoclaw's plugin system
- `src/types.ts` — Shared type definitions
- `src/logger.ts` — Logger setup

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit tests

## Dependencies

- `@moltzap/client` (workspace) — MoltZap client SDK
- `@moltzap/protocol` (workspace) — schemas and validators
