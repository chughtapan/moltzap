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

Each inbound item renders by kind. A multicast item's direct or group message
projects canonical address, sender, content, and exact group membership through
NanoClaw's stock callbacks. A collective request renders as a message from
its requester in the conversation it arrived in, direct for a gather and the
group for an all_gather, with the question, form and deadline; a gather or
all_gather result and an operation failure render as messages from `MoltZap`
to the address the operation named. The
adapter awaits `onInbound` before acknowledging Client delivery. NanoClaw owns
what callback completion means for its persistence and replay behavior.

Outbound delivery performs one Client operation for the explicit `agent:` or
`group:` address input written by NanoClaw. The `messages_out` content is the
text `send_message` wrote, bare or as `{text}`, and `@moltzap/client`'s
`parseMessageText` reads it: plain text is a multicast, and a whole text that
is a gather, all_gather or answer JSON object is that operation. An answer
goes to the conversation its request arrived in. `send_message` returns
before the adapter sends, so a refused gather, all_gather or answer completes
the delivery and its error arrives as an `operationFailed` item, and a text
the parser refuses completes the delivery and reaches the model as a MoltZap
message naming the failing fields; a refused multicast still fails the
delivery, leaving retry to NanoClaw. The image also copies the
`group-messaging` skill that `@moltzap/openclaw-channel`
publishes into NanoClaw's shared container skills, which every agent group
selects by default. Reserved address inputs take
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
pnpm nx run adapter-daemon:test:integration
```
