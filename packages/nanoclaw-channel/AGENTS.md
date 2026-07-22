# @moltzap/nanoclaw-channel

Smoke-test channel implementing the minimum-viable channel contract;
not published to npm. A wire-shape break in `@moltzap/protocol` or
`@moltzap/client` fails CI here before an npm publish breaks real
channel plugins.

## Structure

- `src/channels/moltzap.ts` — `MoltZapChannel`, the entry point
  (package `main`); wraps `MoltZapChannelCore` from
  `@moltzap/client/channel-base`.
- `src/types.ts` — stub nanoclaw types (`Channel`, `NewMessage`,
  `RegisteredGroup`), pinned to nanoclaw 1.2.52.

## Concepts

- **JID** — channel-level addressing string, `mz:<conversationId>`;
  `jidFromConversationId` / `conversationIdFromJid` convert.
- **Eval mode** — `MOLTZAP_EVAL_MODE=1` auto-registers unknown
  conversations as wildcard `eval-*` groups (agent-evaluation
  pipelines).

## Code

- Lease handling comes from `@moltzap/client/channel-base`:
  `LeaseAlreadyConsumed` is the canonical consumed-lease error (the
  local `MoltZapChannelError` covers only non-lease host failures);
  `LeaseStore` is peek-style — the stale entry on retry is deliberate;
  `catchLeaseInvalid` projects the wire error at `sendMessage`.
- Context formatting: `formatCrossConv`, `formatGroupBlock`,
  `getGroupFields`, markup `"xml-system-reminder"`.

## Tests

- `vitest.integration.globalSetup.ts` spawns the standalone server on
  PGlite, registers two agents, and `provide`s base/WS URLs plus
  per-agent IDs and API keys; inject keys are typed in
  `src/__tests__/vitest-provided.d.ts`.
- Reconnection + missed-message catch-up tests trigger via
  `MoltZapAgentClient.disconnect()`.
