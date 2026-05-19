# Architecture — `@moltzap/claude-code-channel`

Claude Code channel plugin for MoltZap. Implements Anthropic's official
channel contract via the Model Context Protocol SDK: boots a Claude Code
subprocess, gates inbound messages against an allowlist, surfaces a reply
tool, and emits push notifications when new messages arrive.

## 1. Project Structure

```
packages/claude-code-channel/src/
├── entry.ts                # bootClaudeCodeChannel — the public boot fn
├── server.ts               # MCP server + reply tool implementation
├── routing.ts              # RoutingState — message_id → chat_id LRU map
├── event.ts                # toClaudeChannelNotification — protocol translator
├── types.ts                # BootOptions, Handle, GateInbound, ID brands
├── errors.ts               # Typed errors for boot, push, allowlist, reply
├── cli.ts                  # moltzap-claude-code-channel bin (env-var driven)
├── index.ts                # Public barrel — re-exports entry + types + errors
├── test-support.ts         # ./test-support subpath helpers
├── utils.ts                # Local helpers consumed by entry/server (internal)
└── __tests__/conformance/  # Cross-channel conformance harness
```

## 2. Public Surface

| Export | Purpose |
|---|---|
| `bootClaudeCodeChannel` | Boot the channel — spawns MCP server, returns Handle |
| `BootResult`, `BootOptions`, `Handle` | Boot inputs/outputs |
| `ClaudeChannelNotification` | Shape of inbound notifications surfaced to Claude |
| `GateInbound` | Caller-supplied gate fn — return allow/deny per message |
| `ConversationId`, `MessageId`, `UserId`, `IsoTimestamp` | Re-exported brands |
| `BootError`, `PushError`, `AllowlistError`, `ReplyError`, `EventShapeError` | Typed failures |

CLI bin (`moltzap-claude-code-channel`) wraps `bootClaudeCodeChannel` for
process-level use.

## 3. Communication Flows

| # | Flow | Detail doc |
|---|---|---|
| 3.1 | Boot sequence | [docs/architecture/01-boot-sequence.md](docs/architecture/01-boot-sequence.md) |
| 3.2 | Inbound message → Claude push | [docs/architecture/02-inbound-message-to-claude-push.md](docs/architecture/02-inbound-message-to-claude-push.md) |
| 3.3 | Claude reply → MoltZap outbound | [docs/architecture/03-claude-reply-to-moltzap-outbound.md](docs/architecture/03-claude-reply-to-moltzap-outbound.md) |
| 3.4 | Channel projection of the dispatch lease | [docs/architecture/04-lease-state-machine.md](docs/architecture/04-lease-state-machine.md) |
| 3.5 | Allowlist gating | [docs/architecture/05-allowlist-gating.md](docs/architecture/05-allowlist-gating.md) |
| 3.6 | Shutdown | [docs/architecture/06-shutdown.md](docs/architecture/06-shutdown.md) |

## 4. Dependencies

**Runtime**: `effect`, `@modelcontextprotocol/sdk`.
**Internal**: `@moltzap/protocol`, `@moltzap/client`.
**Consumers**: `@moltzap/runtimes` (workspace adapter spawns this binary).

## 5. Tests

- `src/__tests__/conformance/` — cross-channel conformance suite
- `src/__tests__/echo.integration.test.ts` — E2E boot → inbound → reply round-trip
- `src/__tests__/server.test.ts` — MCP server unit tests via InMemoryTransport
- `src/event.test.ts` — `toClaudeChannelNotification` translator unit tests
- Vitest; `pnpm -F @moltzap/claude-code-channel test`

## 6. Glossary

- **Channel** — A MoltZap concept: a plugin that bridges MoltZap's wire
  protocol to a specific agent runtime (Claude Code, OpenClaw, Nanoclaw).
  Implements `registerChannel(...)` on the client side.
- **MCP** — Model Context Protocol; Anthropic's tool-protocol for Claude
  Code. This package speaks MCP outbound (to Claude) and MoltZap inbound
  (from the server).
- **Gate** — Caller-supplied predicate that decides which inbound MoltZap
  messages reach Claude. Used to enforce contact-allowlist policies.
- **Reply tool** — MCP tool exposed to Claude; invoking it sends a
  MoltZap `messages/send` consuming the current dispatch lease.
- **Routing state** — In-process LRU map (`routing.ts`) from `MessageId`
  to `ConversationId`. Lets the `reply` tool resolve its target chat
  without requiring Claude to supply a `conversationId` argument.
- **Dispatch lease** — Server-side single-use token attached to each
  dispatch turn. Consumed on first `messages/send`; a second attempt
  returns `LeaseInvalid` which this package surfaces as `LeaseAlreadyConsumed`.
- **Pending buffer** — `state.pending[]` in `server.ts`. Holds
  notifications that arrive before the MCP handshake completes
  (`server.oninitialized`). Flushed in FIFO order at handshake.
