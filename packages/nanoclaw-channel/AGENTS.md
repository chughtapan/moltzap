# @moltzap/nanoclaw-channel

Smoke-test channel implementing the minimum-viable channel contract;
not published to npm. A wire-shape break in `@moltzap/protocol` or
`@moltzap/client` fails CI here before an npm publish breaks real
channel plugins.

## Structure

- `src/channels/moltzap.ts` — `MoltZapAdapter`, the entry point
  (package `main`); implements nanoclaw's `ChannelAdapter` contract over a
  Harness client whose lifetime it owns, and self-registers via
  `registerChannelAdapter`. This file is the whole channel: the simulator's
  asset copier (`packages/simulator/scripts/copy-nanoclaw-assets.mjs`)
  copies exactly it, so a sibling module added beside it does not exist at
  nanoclaw runtime. New logic belongs in this file or behind a
  `@moltzap/client` export.
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

- The adapter drains `HarnessClient.turns` sequentially and retains each
  turn's bound `reply` closure by jid. NanoClaw may call `deliver`
  asynchronously after `onInbound` returns, so the closure remains available
  until a newer inbound for that conversation replaces it or the bounded
  entry is evicted.
- `fromHarnessAcquisition` is the only constructor, and the adapter owns the
  acquisition's `Scope`: `setup` opens it, `teardown` closes it. NanoClaw
  builds channel adapters from a zero-argument factory at module import, so
  no caller exists to hold that scope. `makeMoltZapAdapter` supplies
  `harnessClientForProfile(MOLTZAP_PROFILE)`, which resolves the slot into
  its own `moltzapd` child, the loopback endpoint the slot names, and a
  file-backed checkpoint store.
- `MoltZapChannelError` covers host-shape failures (un-owned jid, unknown
  conversation, a host callback that rejects a projected turn); reply
  failures retain their backing client's error type.
- Inbound projection: `onMetadata` fires before `onInbound`; content
  is `{ text, sender, senderId }` with context blocks inlined into
  `text`; own (`isFromMe`) messages are dropped, not delivered.
- Context formatting: `formatCrossConv`, `formatGroupBlock`,
  `getGroupFields`, markup `"xml-system-reminder"`.

## Tests

- `vitest.integration.globalSetup.ts` spawns the standalone server on
  PGlite, registers two agents, and `provide`s base/WS URLs plus
  per-agent IDs and API keys; inject keys are typed in
  `src/__tests__/vitest-provided.d.ts`. The echo suite reserves the slot's
  loopback port, writes the slot, and drives `makeMoltZapAdapter` — the same
  adapter nanoclaw registers — so a real `moltzapd` carries the round trip.
- The adapter connects once during setup and logs a nonterminal disconnect.
  It does not drive reconnect or missed-message catch-up; the gated
  full-agent evaluation covers the initial live connection path.
- Unit tests drive a fake `HarnessClientService` through a counted
  acquisition, so acquire/release counts assert what `setup` and `teardown`
  did to the client's lifetime.
