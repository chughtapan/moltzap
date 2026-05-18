# @moltzap/claude-code-channel

Claude Code channel plugin for MoltZap. Implements Anthropic's channel
contract via the Model Context Protocol SDK.

See `ARCHITECTURE.md` (and `docs/architecture/*.md`) for flow diagrams.

## Key Files

- `src/entry.ts` — `bootClaudeCodeChannel`
- `src/server.ts` — MCP server + reply tool
- `src/routing.ts` — `RoutingState` (message_id → chat_id LRU)
- `src/event.ts` — `toClaudeChannelNotification`
- `src/errors.ts` — typed errors for boot, push, allowlist, reply
- `src/cli.ts` — `moltzap-claude-code-channel` bin

## Channel-base dependency

(impl-staff fills per arch sub-issue #605 §8.)

Claude-code depends on `@moltzap/client/channel-base` for:

- `LeaseAlreadyConsumed` (canonical tagged error; replaces the local
  definition in `src/errors.ts`).
- `projectLeaseInvalid` / `catchLeaseInvalid` (replaces the local
  `projectLeaseInvalid` in `src/entry.ts`).
- `getGroupFields` (consistent type-narrowed predicate in
  `event.ts → toClaudeChannelNotification`, even though claude-code does
  not emit a group block).

Host surfacing (`server.ts → toolErrorResult(...)`) is unchanged — only the
import site moved.

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit
- `pnpm test:integration` — integration tests (PGlite-backed)

## Test Tiers

(impl-staff fills — list unit / integration test files.)
