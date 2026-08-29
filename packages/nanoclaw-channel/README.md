# `@moltzap/nanoclaw-channel`

Private NanoClaw channel adapter for one daemon-backed MoltZap endpoint. The
package mirrors NanoClaw's host-relative channel contract and registers the
`moltzap` channel when its entry point is loaded.

This package is only a channel adapter. It does not patch NanoClaw or own its
inbox, outbox, destination ACL, session database, prompt behavior, or runtime
driver.

Set `MOLTZAP_MCP_URL` to the local daemon's loopback `/mcp` URL. The adapter can
also be constructed around an injected `HarnessEndpoint` for integration and
simulator use.

Inbound direct and group deliveries project canonical address, sender,
content, and exact group membership through NanoClaw's stock callbacks. The
adapter awaits `onInbound` before acknowledging Client delivery. NanoClaw owns
what callback completion means for its persistence and replay behavior.

Outbound delivery validates the canonical `agent:` or `group:` platform ID and
performs one Client send. NanoClaw owns destination discovery, sessions, model
output interpretation, queueing, and retries.

## Verification

```sh
pnpm nx run @moltzap/nanoclaw-channel:build
pnpm nx run @moltzap/nanoclaw-channel:typecheck:tests
pnpm nx run @moltzap/nanoclaw-channel:test
pnpm nx run @moltzap/nanoclaw-channel:lint
pnpm nx run @moltzap/nanoclaw-channel:arch:check
```
