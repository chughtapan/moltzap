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
  `src/db/messaging-groups.ts`, `src/types.ts` — stub mirrors of the
  NanoClaw modules the channel imports. Keep them aligned with the
  digest-pinned NanoClaw application image used by simulator runs. Inside a
  real NanoClaw checkout the same relative imports resolve against NanoClaw's
  own modules; the messaging-group stub is an in-memory map so unit tests can
  observe eval-mode conversation wiring.

## Concepts

- **Platform id (JID)** — channel-level addressing string,
  `mz:<conversationId>`; `jidFromConversationId` converts one way, and
  replies read the branded conversation id back from the per-jid map.
- **Wiring** — nanoclaw routes by `(channel_type, platform_id)` →
  `messaging_groups` → `messaging_group_agents`. Production wirings
  are provisioned out of band.
- **Eval mode** — the simulator provisions `eval-agent` and its
  container-config row before NanoClaw starts. `MOLTZAP_EVAL_MODE=1`
  creates only the per-conversation messaging group and wiring before
  first-inbound delivery, because the router drops an unknown or
  unwired conversation. NanoClaw's sender resolver owns user rows.

## Code

- `handleInbound` awaits the host turn rather than forking it. That
  binds a reply to the turn that produced it: the per-jid
  conversation entry holds the newest inbound, so a reply outliving
  its own turn would address the wrong conversation.
- `MoltZapChannelError` covers host-shape failures (un-owned jid,
  unknown conversation, disconnected channel); send failures keep
  their `ServiceRpcError` type.
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
