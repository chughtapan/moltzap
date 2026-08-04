# @moltzap/nanoclaw-channel

Smoke-test channel implementing the minimum-viable channel contract;
not published to npm. A wire-shape break in `@moltzap/protocol` or
`@moltzap/client` fails CI here before an npm publish breaks real
channel plugins.

## Structure

- `src/channels/moltzap.ts` — `MoltZapAdapter`, the entry point
  (package `main`); implements nanoclaw's `ChannelAdapter` contract
  over an injected `HarnessClient` or the transitional
  `MoltZapChannelCore` path and self-registers via
  `registerChannelAdapter`. The production factory remains profile/core-backed
  until profile-to-MCP acquisition is available.
- `src/channels/adapter.ts`, `src/channels/channel-registry.ts`,
  `src/db/messaging-groups.ts`, `src/types.ts` — stub mirrors of the
  nanoclaw modules the channel imports, pinned to the commit in `NANOCLAW_SHA`
  (`packages/simulator/src/runtime/nanoclaw/install.ts`). Inside a real nanoclaw
  checkout the same relative imports resolve against nanoclaw's own
  modules; the messaging-group stub is an in-memory map so unit tests
  can observe eval-mode conversation wiring.

## Concepts

- **Platform id (JID)** — channel-level addressing string,
  `mz:<conversationId>`; `jidFromConversationId` converts one way, and
  replies read the latest bound route back from the per-jid map.
- **Wiring** — nanoclaw routes by `(channel_type, platform_id)` →
  `messaging_groups` → `messaging_group_agents`. Production wirings
  are provisioned out of band.
- **Eval mode** — the simulator provisions `eval-agent` and its
  container-config row before NanoClaw starts. `MOLTZAP_EVAL_MODE=1`
  creates only the per-conversation messaging group and wiring before
  first-inbound delivery, because the router drops an unknown or
  unwired conversation. NanoClaw's sender resolver owns user rows.

## Code

- The injected Harness path drains `HarnessClient.turns` sequentially and
  retains each turn's bound `reply` closure by jid. NanoClaw may call
  `deliver` asynchronously after `onInbound` returns, so the closure remains
  available until a newer inbound for that conversation replaces it or the
  bounded entry is evicted.
- `fromHarnessClient` borrows an already acquired client. Adapter teardown
  interrupts its turn drain but does not close the caller-owned client scope.
- `MoltZapChannelError` covers host-shape failures (un-owned jid,
  unknown conversation, disconnected channel); reply failures retain their
  backing client's error type.
- Inbound projection: `onMetadata` fires before `onInbound`; content
  is `{ text, sender, senderId }` with context blocks inlined into
  `text`; own (`isFromMe`) messages are dropped, not delivered.
- Context formatting: `formatCrossConv`, `formatGroupBlock`,
  `getGroupFields`, markup `"xml-system-reminder"`.

## Tests

- `vitest.integration.globalSetup.ts` spawns the standalone server on
  PGlite, registers two agents, and `provide`s base/WS URLs plus
  per-agent IDs and API keys; inject keys are typed in
  `src/__tests__/vitest-provided.d.ts`.
- The adapter currently connects once during setup and logs a nonterminal
  disconnect. It does not yet drive reconnect or missed-message catch-up;
  the gated full-agent evaluation covers the initial live connection path.
- Harness behavior tests use a fake `HarnessClientService` stream and bound
  reply closures. Import/constructor absence remains an architecture check for
  the later production-factory cutover, not a unit assertion.
