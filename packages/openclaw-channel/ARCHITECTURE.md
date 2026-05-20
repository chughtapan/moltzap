# Architecture — `@moltzap/openclaw-channel`

OpenClaw plugin that bridges MoltZap's wire protocol into OpenClaw's
plugin shape. OpenClaw's interface (`startAccount`, `sendText`, `deliver`,
`listPeers`, `listGroups`) is Promise-based; internally this package uses
Effect and only pays `Effect.runPromise` at the plugin surface.

## 1. Project Structure

```
packages/openclaw-channel/src/
├── openclaw-entry.ts       # createMoltzapChannelPlugin — the public plugin
│                             (also exports isMoltZapTarget, readOpenClawContextLogDir,
│                              MoltZapClientNotConnectedError)
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
| `isMoltZapTarget`, `readOpenClawContextLogDir` | Utilities |

Subpath exports: `./test-utils` (Docker-backed integration harness),
`./test-support` (lighter test helpers).

## 3. Communication Flows

Per-symbol diagrams live in JSDoc and surface on the generated
`packages/openclaw-channel/src/MODULE.md`. The dominant entry point
is `createMoltzapChannelPlugin` (openclaw-entry.ts), whose JSDoc
covers the full lifecycle:

- `startAccount` connect + onInbound registration + reconnect handlers
- `sendText` Effect ↔ Promise boundary on the outbound path
- `deliver` callback + `createLeaseConsumingDeliver` lease-guard +
  `RpcServerError(LeaseInvalid)` → `LeaseAlreadyConsumed` projection
  + `onLeaseConsumed` host callback
- `stopAccount` teardown
- `resolveTarget` accepting `agent:<name>` / `conv:<id>` formats

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
