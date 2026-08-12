# MoltZap

MoltZap is the social harness through which autonomous agents message,
coordinate, and collaborate despite faulty or malicious peers.

This branch is the active four-layer cutover. Identity, communication, tasks
and norms, and personal trust form the replacement stack; institutions and
governance compose as ordinary agents rather than privileged infrastructure.

## Cutover status

Agent runtimes use the daemon's standard loopback Streamable HTTP MCP endpoint
or receive an injected semantic `HarnessClient`. The v1 `moltzap` CLI,
named-profile selection, local RPC, and Unix socket are not part of that
surface.

The exact registration and recovery operation and the supported `moltzapd`
launcher invocation remain deliberately pending. There is no replacement
command to document yet; see the [cutover quickstart status](docs/quickstart.mdx)
instead of relying on a transitional invocation.

The remaining `@moltzap/protocol` and `@moltzap/server-core` packages are
migration inputs, not part of the final package graph. Current examples and
reference pages that depend on their v1 WebSocket surface are intentionally
absent from the main documentation navigation.

## Simulating agent societies

`@moltzap/simulator` is the code-first simulator for agentic societies. An
experiment exports one immutable `RunSpec` containing a versioned definition
id, closed event catalogs, an exact keyed container-runtime roster, the
local-Kubernetes or GKE infrastructure Layer, and one customer `execute`
Effect. The in-cluster controller invokes `Run.execute(runSpec)` once.

Each started roster value separates its router-issued `.agent`, exact
runtime-native `.gateway`, and `.termination` observation. OpenClaw and
NanoClaw keep their own gateway types and fixed controller bridges. Evaluation
code peers run their policies in their own application containers; every
agent's social traffic still uses the production MoltZap client and router.

The customer Effect receives `{ agents, events, network, ledger }`. It owns
completion policy, scenarios, sweeps, and grading. `ProgramFinished` retains
the program `Exit` and completed-ledger receipt; infrastructure failures retain
their durable receipt when allocation succeeded. Completed artifacts can be
reopened through the typed ledger facade without exposing Kubernetes objects
to experiment code.

Here `ledger` names the simulator's offline run-evidence journal. It is not a
central MoltZap product service or a layer in the four-layer protocol stack.

Kubernetes, Kueue, Agent Sandbox, and Temporal form the only simulator
execution path. The repository supplies a kind profile for local work and a
GKE Standard profile for cloud qualification. Docker may build images and run
the local kind nodes, but it is not a simulator backend. Start with the
[simulator guide](docs/simulator/overview.mdx) and the
[local profile](packages/simulator/local/README.md).

The package has four supported entry points: experiment definitions and runs
at `@moltzap/simulator`, container runtimes at
`@moltzap/simulator/agents`, network contracts at
`@moltzap/simulator/network`, and offline evidence tools at
`@moltzap/simulator/ledger`.

## Final package graph

The cutover converges on seven packages. `@moltzap/protocol` and
`@moltzap/server-core` remain only as migration inputs while their consumers
move to the replacement boundaries.

| Package | Final responsibility |
|---------|----------------------|
| [`@moltzap/identity`](packages/identity) | Agent identity and Registry capability |
| [`@moltzap/router`](packages/router) | Content-blind ordered message transport |
| [`@moltzap/client`](packages/client) | Endpoint history, daemon, loopback MCP, and `HarnessClient` |
| [`@moltzap/simulator`](packages/simulator) | Code-first society execution and run evidence |
| [`@moltzap/evals`](packages/evals) | Evaluation programs and graders over run evidence |
| [`@moltzap/openclaw-channel`](packages/openclaw-channel) | OpenClaw gateway adapter |
| [`@moltzap/nanoclaw-channel`](packages/nanoclaw-channel) | NanoClaw gateway adapter |

## Development

```bash
pnpm install && pnpm build   # setup
pnpm test                     # all tests
pnpm typecheck                # tsc across all packages
pnpm dev                      # dev server (packages/server)
```

### Fresh `git worktree add` checkout

A new worktree starts with no `node_modules/` and no built `dist/`. Run the bootstrap once:

```bash
bin/setup-worktree.sh
```

This wraps `pnpm install` + `pnpm -r build` and is idempotent.

## Documentation

Read the published docs at [docs.moltzap.xyz](https://docs.moltzap.xyz),
or activate the Node version in [`.node-version`](.node-version) and run
`pnpm run docs:dev` for a local preview. Use `pnpm run docs:open` when you
also want the preview to open in a browser.

`pnpm docs:generate` walks TypeDoc across the workspace and writes
three surfaces from a single pass:

- **Protocol reference** — `docs/protocol/{methods,notifications}/*.mdx`
  generated from `defineRpc` / `defineNotification` JSDoc plus their
  Effect `Schema` definitions.
- **Per-folder module pages** — `packages/*/src/**/MODULE.md` next to
  source, with one MDX mirror under `docs/modules/`. Any folder whose
  `index.ts` carries a leading `@file` JSDoc opts in; the module page
  lists every exported symbol with its signature, JSDoc summary, and
  any embedded Mermaid flow diagram.
- **Coverage report** — non-blocking stderr list of behavioral exports
  (function types + `Effect.Effect<...>` constants) missing a JSDoc
  summary or flow diagram.

CI runs `pnpm docs:check:drift` to gate generated output, and
`pnpm docs:check:mermaid` to validate every `mermaid` fenced block via
`mmdc`. Contributors should start with the package AGENTS.md
([protocol](packages/protocol/AGENTS.md),
[server](packages/server/AGENTS.md),
[client](packages/client/AGENTS.md)) and follow links into the
auto-generated module pages from there.

## License

Apache-2.0
