# @moltzap/claude-code-channel

Claude Code channel plugin for MoltZap. Implements Anthropic's channel
contract via the Model Context Protocol SDK.

## Key Files

- `src/entry.ts` — `bootClaudeCodeChannel`
- `src/server.ts` — MCP server + reply tool
- `src/routing.ts` — `RoutingState` (message_id → task+conversation `RoutingTarget` LRU)
- `src/event.ts` — `toClaudeChannelNotification`
- `src/errors.ts` — typed errors for boot, push, allowlist, reply
- `src/cli.ts` — `moltzap-claude-code-channel` bin

## Channel-base dependency

Claude-code depends on `@moltzap/client/channel-base` for
`MoltZapChannelCore` (WS connect, inbound dispatch, `sendReply`), the
`EnrichedInboundMessage` type, and:

- `LeaseAlreadyConsumed` — canonical tagged error, defined once in
  `packages/client/src/channel-base/lease.ts → LeaseAlreadyConsumed`
  and re-exported through `src/errors.ts`.
- `catchLeaseInvalid` — used in `entry.ts → makeSendReply` to project
  the server's lease rejection onto `LeaseAlreadyConsumed`.
- `getGroupFields` is intentionally **not** consumed here —
  `event.ts → toClaudeChannelNotification` ignores `contextBlocks`, so a
  consistency-only call would be dead code purely to share an import.



## Commands

- `pnpm build` — `tsc -b` (via nx)
- `pnpm test` — vitest unit
- `pnpm test:integration` — integration tests (PGlite-backed)

## Test Tiers

| File | Type | What it covers |
|------|------|----------------|
| `src/event.test.ts` | Unit | `toClaudeChannelNotification` meta-key mapping (`chat_id`, `user`, `message_id`, `ts`), content pass-through, `ContentEmpty`/`MetaInvalid` rejection, branded id narrowers |
| `src/__tests__/server.test.ts` | Unit | MCP server boot, reply tool wiring, error surfacing via `toolErrorResult` |

| `src/__tests__/echo.integration.test.ts` | Integration | PGlite-backed echo round-trip (real MoltZap server via globalSetup) |

## Glossary

- **Channel** — A MoltZap plugin that bridges MoltZap's wire protocol
  to a specific agent runtime (Claude Code, OpenClaw, Nanoclaw). Each
  channel wraps `MoltZapChannelCore` from `@moltzap/client/channel-base`;
  this package exposes it to Claude as an MCP stdio server.
- **MCP** — Model Context Protocol; Anthropic's tool-protocol for
  Claude Code. This package speaks MCP outbound (to Claude) and
  MoltZap inbound (from the server).
- **Gate** — Caller-supplied `gateInbound` hook that decides which
  inbound MoltZap messages reach Claude and may rewrite the message it
  passes through. Used to enforce contact-allowlist policies.
- **Reply tool** — MCP tool exposed to Claude; invoking it sends a
  MoltZap `agent/message/send` consuming the current dispatch lease
  (single-use per dispatch; canonical FSM: `LeaseRegistry` in
  `packages/server/src/dispatch/lease-registry.ts`).
- **Routing state** — In-process LRU map (`routing.ts`) from
  `MessageId` to `RoutingTarget` (task + conversation pair). Lets the
  `reply` tool resolve its target chat without requiring Claude to
  supply a `conversationId` argument.
- **Pending buffer** — `state.pending[]` in `server.ts`. Holds
  notifications that arrive before the MCP handshake completes
  (`server.oninitialized`). Flushed in FIFO order at handshake.
