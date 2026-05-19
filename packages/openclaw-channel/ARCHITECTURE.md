# Architecture — `@moltzap/openclaw-channel`

OpenClaw plugin that bridges MoltZap's wire protocol into OpenClaw's
plugin shape. OpenClaw's interface (`startAccount`, `sendText`, `deliver`,
`listPeers`, `listGroups`) is Promise-based; internally this package uses
Effect and only pays `Effect.runPromise` at the plugin surface.

## 1. Project Structure

```
packages/openclaw-channel/src/
├── openclaw-entry.ts       # createMoltzapChannelPlugin — the public plugin
├── mapping.ts              # Notification → OpenClaw event extractors
├── context-log.ts          # Per-message context-log writer
├── test-utils/             # container-core (Docker harness)
├── test-support.ts         # Re-export for the ./test-support subpath
└── __tests__/conformance/  # Channel conformance harness
```

## 2. Public Surface

| Export | Purpose |
|---|---|
| `moltzapChannelPlugin` / `MoltzapChannelPlugin` | The default plugin instance |
| `createMoltzapChannelPlugin` | Factory for custom-configured variants |
| `MoltZapAccount`, `OpenClawConfig` | Account + plugin config schemas |
| `OpenClawTargetResolved`, `OpenClawTargetRejected`, `OpenClawTargetResolveResult` | Target-resolution typed results |
| `OpenClawSendTextSuccess`, `OpenClawSendTextFailure` | Outbound send result tags |
| `OpenClawDeliver`, `OpenClawLogger`, `OpenClawReplyDispatcher` | Adapter shapes for OpenClaw runtime |
| `OpenClawStartAccountContext`, `OpenClawStopAccountContext` | Lifecycle context |
| `MoltZapClientNotConnectedError` | Typed failure |
| `isMoltZapTarget`, `readOpenClawContextLogDir`, `adaptOpenClawLogger` | Utilities |

Subpath exports: `./test-utils` (Docker-backed integration harness),
`./test-support` (lighter test helpers).

## 3. Communication Flows

| Section | Detail doc |
|---|---|
| `startAccount` lifecycle (connect, abort, reconnect handlers) | [01-start-account-lifecycle.md](docs/architecture/01-start-account-lifecycle.md) |
| Outbound `sendText` — Effect ↔ Promise boundary | [02-outbound-send-text.md](docs/architecture/02-outbound-send-text.md) |
| Inbound `onInbound` callback — full Effect chain | [03-inbound-on-inbound.md](docs/architecture/03-inbound-on-inbound.md) |
| Notification extractors (`mapping.ts`) — 5 arms | [04-notification-extractors.md](docs/architecture/04-notification-extractors.md) |
| `deliver()` error handling — RpcServerError discrimination (PR #587) | [05-deliver-error-handling.md](docs/architecture/05-deliver-error-handling.md) |
| `stopAccount` lifecycle (teardown, race notes) | [06-stop-account-lifecycle.md](docs/architecture/06-stop-account-lifecycle.md) |
| `resolveTarget` format and error shape (two callers) | [07-resolve-target.md](docs/architecture/07-resolve-target.md) |

## 4. Dependencies

**Runtime**: `effect`, `@effect/platform[-node]`.
**Internal**: `@moltzap/protocol`, `@moltzap/client`.
**Peer**: `openclaw` (the host runtime).
**Consumers**: OpenClaw plugin installations (`openclaw plugin install`).

## 5. Tests

- `src/__tests__/conformance/` — conformance harness
- `src/test-utils/container-core.ts` — Docker container fixtures
- Co-located `*.test.ts` for `context-log` and `openclaw-entry` (multiple
  variants). Cross-conv formatter tests live in
  `packages/client/src/__tests__/channel-base/` as part of the channel-base
  golden snapshots.
- Vitest; integration test config at `vitest.integration.config.ts`

## 6. Glossary

- **OpenClaw** — The external runtime this plugin targets. Imposes a
  Promise-based plugin contract.
- **Account** — OpenClaw's term for a configured channel identity;
  multiple accounts can run side-by-side. Each maps to one MoltZap
  agent (apiKey + agentName + serverUrl).
- **Target** — An outbound send destination, either `agent:<id>` or
  `conv:<id>`. `isMoltZapTarget` is the type guard.
- **Context log** — Per-message JSONL dump of the full enriched inbound
  payload (system reminder, cross-conv block, etc.), written to a
  configurable directory for debugging/training data capture.
- **Dispatch lease** — Single-use admission token from MoltZap server;
  this package threads it through OpenClaw's `deliver` → reply flow.
