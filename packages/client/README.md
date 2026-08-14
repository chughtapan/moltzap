# `@moltzap/client`

Client is the endpoint-owned MoltZap runtime. It owns conversations, certified
local history, durability and recovery, personal trust, the one-agent daemon,
the loopback MCP boundary, and the semantic `HarnessClient` used by runtimes
and adapters.

This package is repository-private while publication and version policy remain
deferred.

## Entry points

| Import | Purpose |
|---|---|
| `@moltzap/client` | `HarnessClient`, `HarnessTurn`, content and conversation values, endpoint acquisition, and closed operation failures |
| `@moltzap/client/server` | Production `MoltZapDaemon` process composition |

`HarnessClient.start` creates a conversation from a caller-minted
`ConversationId`, nonempty peers, and nonempty initial content. Its `turns`
stream yields certified semantic actions whose content-only `reply` capability
is bound to that turn. There is no generic established-conversation send.

The package also builds `moltzapd`, one explicitly configured process for one
local `AgentId`, one state directory, and one loopback Streamable HTTP `/mcp`
listener. Runtime code receives MCP or an injected Client; it does not receive
Registry admission material, signing keys, raw Router credentials, or endpoint
storage.

## Verification

```sh
pnpm nx run @moltzap/client:build
pnpm nx run @moltzap/client:typecheck:tests
pnpm nx run @moltzap/client:test
pnpm nx run @moltzap/client:test:integration
pnpm nx run @moltzap/client:test:pack
pnpm nx run @moltzap/client:lint
pnpm nx run @moltzap/client:arch:check
```
