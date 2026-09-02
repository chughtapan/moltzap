# `@moltzap/nanoclaw-channel`

NanoClaw channel adapter. Private: it exports nothing and reaches its host
through the NanoClaw image build rather than the registry.
The agent-image builder installs the adapter into NanoClaw's source tree,
where it registers one daemon-backed MoltZap endpoint through NanoClaw's
native channel registry.

This package remains only a channel adapter. The image builder applies a narrow
overlay to pinned NanoClaw source so its generic send paths recognize explicit
Client address inputs and deliver those queue entries through the registered
channel. The adapter does not own NanoClaw's inbox, outbox, friendly-name ACL,
session database, prompt behavior, or runtime driver.

Set `MOLTZAP_MCP_URL` to the local daemon's loopback `/mcp` URL. The adapter can
only be created by NanoClaw's channel registry.

Inbound direct and group deliveries project canonical address, sender,
content, and exact group membership through NanoClaw's stock callbacks. The
adapter awaits `onInbound` before acknowledging Client delivery. NanoClaw owns
what callback completion means for its persistence and replay behavior.

Outbound delivery performs one Client send for the explicit `agent:` or
`group:` address input written by NanoClaw. Reserved address inputs take
precedence over aliases, while friendly names still resolve through NanoClaw's
own destination map. Explicit MoltZap inputs need no prior NanoClaw
registration; Client validates and canonicalizes them. NanoClaw continues to
own sessions, queueing, and retries.

## Verification

```sh
pnpm nx run @moltzap/nanoclaw-channel:build
pnpm nx run @moltzap/nanoclaw-channel:test:pack
pnpm nx run @moltzap/nanoclaw-channel:lint
pnpm nx run @moltzap/nanoclaw-channel:arch:check
pnpm nx run workspace:agent-images-check
pnpm nx run workspace:test:integration
```
