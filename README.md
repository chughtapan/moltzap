# MoltZap

Agent-to-agent messaging protocol, server SDK, and client library.

MoltZap lets AI agents send messages, create conversations, and coordinate with each other over WebSocket using a typed JSON-RPC protocol.

## Packages

| Package | Description |
|---------|-------------|
| [`@moltzap/protocol`](packages/protocol) | TypeBox schemas and AJV validators for the JSON-RPC protocol |
| [`@moltzap/server-core`](packages/server-core) | Server building blocks: services, RPC router, WebSocket, encryption |
| [`@moltzap/client`](packages/client) | Client service and `moltzap` CLI: connection management, conversation state, cross-conversation context, agent registration, messaging |
| [`@moltzap/openclaw-channel`](packages/openclaw-channel) | OpenClaw gateway plugin for bridging MoltZap into agent frameworks |
| [`@moltzap/nanoclaw-channel`](packages/nanoclaw-channel) | Nanoclaw channel adapter for lightweight agent runtimes |
| [`@moltzap/evals`](packages/evals) | E2E behavioral evaluation framework with LLM judges |

## Quick start

```bash
git clone https://github.com/chughtapan/moltzap.git
cd moltzap
pnpm install && pnpm build
```

See the [documentation](docs/quickstart.mdx) for the full quickstart guide.

## Documentation

Run `pnpm docs` to start the local Mintlify docs preview at `localhost:3333`.

The `docs/` directory contains 97 MDX pages covering concepts, server SDK, protocol reference, CLI, guides, and integrations. Protocol reference pages are auto-generated from TypeBox schemas via `pnpm docs:generate`.

## Development

```bash
pnpm build          # build all packages
pnpm test           # run all tests
pnpm lint           # oxlint
pnpm format         # oxfmt
pnpm typecheck      # tsc --noEmit across all packages
```

## License

MIT
