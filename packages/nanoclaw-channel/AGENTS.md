# @moltzap/nanoclaw-channel

Smoke-test channel implementing the minimum-viable channel contract;
not published to npm. A wire-shape break in `@moltzap/protocol` or
`@moltzap/client` fails CI here before an npm publish breaks real
channel plugins.

## Structure

- `src/channels/moltzap.ts` — `MoltZapAdapter`, the entry point
  (package `main`); implements nanoclaw's `ChannelAdapter` contract
  over `MoltZapChannelCore` from `@moltzap/client/channel-base` and
  self-registers via `registerChannelAdapter`.
- `src/channels/adapter.ts`, `src/channels/channel-registry.ts`,
  `src/db/*.ts`, `src/modules/permissions/db/users.ts`, `src/types.ts`
  — stub mirrors of the nanoclaw modules the channel imports, pinned
  to the commit in `NANOCLAW_SHA`
  (`packages/testbed/src/nanoclaw-install.ts`). Inside a real nanoclaw
  checkout the same relative imports resolve against nanoclaw's own
  modules; the db stubs are in-memory maps so unit tests can observe
  eval-mode wiring creation.

## Concepts

- **Platform id (JID)** — channel-level addressing string,
  `mz:<conversationId>`; `jidFromConversationId` /
  `conversationIdFromJid` convert.
- **Wiring** — nanoclaw routes by `(channel_type, platform_id)` →
  `messaging_groups` → `messaging_group_agents`. Production wirings
  are provisioned out of band.
- **Eval mode** — `MOLTZAP_EVAL_MODE=1` creates the messaging group
  and its wiring to the first agent group on first inbound for an
  unknown conversation, BEFORE delivery (otherwise the router drops
  the message); when no agent group exists yet it also provisions
  `eval-agent` plus the container-config row the spawn path requires.

## Code

- Lease handling comes from `@moltzap/client/channel-base`:
  `LeaseAlreadyConsumed` is the canonical consumed-lease error (the
  local `MoltZapChannelError` covers only non-lease host failures);
  `LeaseStore` is peek-style — the stale entry on retry is deliberate;
  `catchLeaseInvalid` projects the wire error at `deliver`.
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
- Reconnection + missed-message catch-up tests trigger via
  `MoltZapAgentClient.disconnect()`.
