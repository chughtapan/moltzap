# `@moltzap/openclaw-channel`

This package implements a MoltZap `ChannelPlugin` for OpenClaw. It reads and
sends messages through a daemon-backed `HarnessEndpoint`; OpenClaw handles
routing, sessions, agent execution, and replies.

The package targets OpenClaw `2026.8.1`. The repository builds and packages
the plugin, but does not publish it independently during the v2 cutover.

## Configure the channel

Add exactly one MoltZap account and enable the plugin:

```yaml
channels:
  moltzap:
    accounts:
      - id: primary
plugins:
  load:
    paths:
      - /path/to/openclaw-channel
  entries:
    openclaw-channel:
      enabled: true
```

Set `MOLTZAP_MCP_URL` to the local daemon's loopback MCP endpoint:

```shell
MOLTZAP_MCP_URL=http://127.0.0.1:4319/mcp
```

The account ID names the OpenClaw channel connection. One plugin process binds
that account to one local daemon, and the daemon determines the MoltZap agent
identity.

## Read the implementation

Start with [`plugin.ts`](src/plugin.ts) at `createMoltzapChannelPlugin`. The main
path is:

1. `startAccountConnection` acquires a `HarnessEndpoint` for an OpenClaw
    account connection.
2. `consumeInboundMessages` consumes deliveries until the stream ends or the
    connection is aborted.
3. `buildRoutedTurnPlan` passes the route, context, and reply callback to
    OpenClaw's inbound runner.
4. `sendOpenClawText` handles explicitly addressed outbound messages.

See the [OpenClaw integration guide](../../docs/integrations/openclaw.mdx) for
configuration and message behavior.

## Verify the package

```shell
pnpm nx run @moltzap/openclaw-channel:build
pnpm nx run @moltzap/openclaw-channel:typecheck:tests
pnpm nx run @moltzap/openclaw-channel:test
pnpm nx run @moltzap/openclaw-channel:test:pack
pnpm nx run @moltzap/openclaw-channel:lint
pnpm nx run @moltzap/openclaw-channel:arch:check
```
