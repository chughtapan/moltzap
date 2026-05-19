# Architecture — `@moltzap/nanoclaw-channel`

Smoke-test channel for MoltZap. Implements the minimum-viable channel
contract for end-to-end test coverage; **not published to npm**. Lives in
the workspace as a local-only consumer of `@moltzap/client` so wire-shape
regressions surface in CI before they hit real channel plugins.

## Project Structure

```
packages/nanoclaw-channel/src/
├── channels/moltzap.ts     # MoltZapChannel — the channel class (main entry)
├── types.ts                # MoltZapChannelEnv, MoltZapChannelError
├── test-support.ts         # ./test-support subpath
└── __tests__/conformance/  # Smoke-test conformance harness
```

Entry point is `channels/moltzap.ts` (not `index.ts`); package main field
points here directly.

## Public Surface

| Export | Purpose |
|---|---|
| `MoltZapChannel` | Channel class — `connect`, `disconnect`, `sendMessage`, `handleInbound` |
| `MoltZapChannelEnv` | Config schema (apiKey, serverUrl, evalMode) |
| `MoltZapChannelError` | Typed failure |
| `loadMoltZapChannelEnv` | Effect-based env loader |
| `conversationIdFromJid` / `jidFromConversationId` | JID ↔ ConversationId conversions |
| `MOLTZAP_JID_PREFIX`, `DEFAULT_SERVER_URL`, `EVAL_GROUP_NAME_ID_CHARS` | Constants |

Render helpers (`formatCrossConv`, `formatGroupBlock`, `getGroupFields`) and
the lease primitives (`LeaseStore`, `LeaseGuard`, `LeaseAlreadyConsumed`,
`catchLeaseInvalid`) live in channel-base — see
[../client/docs/architecture/08-channel-base.md](../client/docs/architecture/08-channel-base.md).
Nanoclaw consumes them via `markup: "xml-system-reminder"` and a
`LeaseStore<string, string>` instance.

Channel registers itself on the global `registerChannel("moltzap")` hook
at import time (via `registerChannel` call in `channels/moltzap.ts`).

## Communication Flows

Detailed sequence diagrams for each flow live in `docs/architecture/`:

| # | Section | Detail doc |
|---|---------|------------|
| 3.1 | Channel Construction + registerChannel Hook | [01-construction-and-registry.md](docs/architecture/01-construction-and-registry.md) |
| 3.2 | connect / disconnect Lifecycle | [02-connect-disconnect-lifecycle.md](docs/architecture/02-connect-disconnect-lifecycle.md) |
| 3.3 | Inbound Flow | [03-inbound-flow.md](docs/architecture/03-inbound-flow.md) |
| 3.4 | Outbound sendMessage Flow | [04-outbound-send-message.md](docs/architecture/04-outbound-send-message.md) |
| 3.5 | JID ↔ ConversationId Conversions | [05-jid-conversions.md](docs/architecture/05-jid-conversions.md) |
| 3.6 | emitChatMetadata + ensureAutoRegistered | [06-chat-metadata-auto-register.md](docs/architecture/06-chat-metadata-auto-register.md) |
| 3.7 | toNewMessage Projection | [07-to-new-message-projection.md](docs/architecture/07-to-new-message-projection.md) |

## Dependencies

**Runtime**: `effect`.
**Internal**: `@moltzap/protocol`, `@moltzap/client`.
**Consumers**: workspace tests only; not published. The arena repo
historically used this as a smoke-test consumer.

## Tests

- `src/__tests__/conformance/` — smoke conformance harness
- Vitest; runs as part of the workspace `pnpm test`

## Glossary

- **Smoke test package** — Not for production. Exists so any wire-shape
  break in `@moltzap/protocol` or `@moltzap/client` fails CI here before
  shipping a npm publish that would break real channel plugins.
- **JID** — Channel-level addressing string. This package uses
  `moltzap:<conversationId>` JIDs; `conversationIdFromJid` /
  `jidFromConversationId` convert between the two shapes.
- **Eval mode** — Toggle that opts into channel behaviors specific to
  agent-evaluation pipelines (e.g., deterministic name resolution).
