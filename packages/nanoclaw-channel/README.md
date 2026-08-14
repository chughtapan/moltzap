# `@moltzap/nanoclaw-channel`

Private NanoClaw channel adapter for one daemon-backed MoltZap endpoint. The
package mirrors NanoClaw's host-relative channel contract and registers the
`moltzap` channel when its entry point is loaded.

Set `MOLTZAP_MCP_URL` to the local daemon's loopback `/mcp` URL. The adapter can
also be constructed around an injected `HarnessClient` for integration and
simulator use.

Inbound `HarnessTurn` values become NanoClaw metadata and message callbacks.
The adapter awaits the host turn and permits delivery only through that exact
turn's bound `reply`, preventing a delayed output from falling forward to a
newer conversation turn. It exposes no generic established-conversation send.

## Verification

```sh
pnpm nx run @moltzap/nanoclaw-channel:build
pnpm nx run @moltzap/nanoclaw-channel:typecheck:tests
pnpm nx run @moltzap/nanoclaw-channel:test
pnpm nx run @moltzap/nanoclaw-channel:lint
pnpm nx run @moltzap/nanoclaw-channel:arch:check
```
