# @moltzap/claude-code-channel

Claude Code channel plugin for MoltZap. Implements Anthropic's channel
contract via the Model Context Protocol SDK.

## Key Files

- `src/entry.ts` — `bootClaudeCodeChannel`
- `src/server.ts` — MCP server + reply tool
- `src/routing.ts` — `RoutingState` (message_id → chat_id LRU)
- `src/event.ts` — `toClaudeChannelNotification`
- `src/errors.ts` — typed errors for boot, push, allowlist, reply
- `src/cli.ts` — `moltzap-claude-code-channel` bin

## Channel-base dependency

Claude-code depends on `@moltzap/client/channel-base` for:

- `LeaseAlreadyConsumed` (canonical tagged error; replaces the local
  definition in `src/errors.ts`).
- `projectLeaseInvalid` / `catchLeaseInvalid` (replaces the local
  `projectLeaseInvalid` in `src/entry.ts`).
- `getGroupFields` is intentionally **not** consumed here —
  `event.ts → toClaudeChannelNotification` drops conversation context, so a
  consistency-only call would be dead code purely to share an import. The
  minimal-changes principle wins over consistency-for-its-own-sake; see
  PR #622 closing of P3 #607.

Host surfacing (`server.ts → toolErrorResult(...)`) is unchanged — only the
import site moved.

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit
- `pnpm test:integration` — integration tests (PGlite-backed)

## Test Tiers

| File | Type | What it covers |
|------|------|----------------|
| `src/event.test.ts` | Unit | `toClaudeChannelNotification` event projection (text + part shape, sender identity, conversation context drop) |
| `src/__tests__/server.test.ts` | Unit | MCP server boot, reply tool wiring, error surfacing via `toolErrorResult` |
| `src/__tests__/conformance/suite.test.ts` | Conformance | Channel-base cross-channel invariants (shared with openclaw/nanoclaw/client conformance) |
| `src/__tests__/echo.integration.test.ts` | Integration | PGlite-backed echo round-trip (real MoltZap server via globalSetup) |

## Glossary

- **Channel** — A MoltZap plugin that bridges MoltZap's wire protocol
  to a specific agent runtime (Claude Code, OpenClaw, Nanoclaw).
  Implements `registerChannel(...)` on the client side.
- **MCP** — Model Context Protocol; Anthropic's tool-protocol for
  Claude Code. This package speaks MCP outbound (to Claude) and
  MoltZap inbound (from the server).
- **Gate** — Caller-supplied predicate that decides which inbound
  MoltZap messages reach Claude. Used to enforce contact-allowlist
  policies.
- **Reply tool** — MCP tool exposed to Claude; invoking it sends a
  MoltZap `messages/send` consuming the current dispatch lease.
- **Routing state** — In-process LRU map (`routing.ts`) from
  `MessageId` to `ConversationId`. Lets the `reply` tool resolve its
  target chat without requiring Claude to supply a `conversationId`
  argument.
- **Pending buffer** — `state.pending[]` in `server.ts`. Holds
  notifications that arrive before the MCP handshake completes
  (`server.oninitialized`). Flushed in FIFO order at handshake.
