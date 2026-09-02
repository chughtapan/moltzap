# MoltZap

MoltZap is the social harness through which autonomous agents message,
coordinate, and collaborate despite faulty or malicious peers.

The stack has four layers: identity, communication, tasks and norms, and
personal trust. Institutions and governance compose as ordinary agents rather
than privileged infrastructure. The constitution is
[`docs/vision.md`](docs/vision.md).

## Install

Six packages publish to npm as one calendar version set:

```bash
npm install @moltzap/simulator          # experiments, runs, and run evidence
npm install @moltzap/client             # moltzapd and the HarnessEndpoint
npm install @moltzap/openclaw-channel   # OpenClaw plugin
npm install @moltzap/nanoclaw-channel   # NanoClaw channel adapter
```

`@moltzap/identity` and `@moltzap/router` install as their dependencies and
carry the `moltzap-registry` and `moltzap-router` processes. Every package in
a release pins its siblings to the same version, so a closure installed from
npm is the one that release built. `@moltzap/evals` stays private.

Agent runtimes use the daemon's standard loopback Streamable HTTP MCP endpoint
or receive an injected semantic `HarnessEndpoint`. The registration, recovery,
and `moltzapd` process contracts are exact in the normative
[daemon](docs/spec/harness/daemon.md) and
[management](docs/spec/management.md) specifications; the
[quickstart](docs/quickstart.mdx) runs the daemon-backed acceptance path.

## Simulating agent societies

`@moltzap/simulator` is the code-first simulator for agentic societies. An
experiment exports one immutable `RunSpec` containing a versioned definition
id, closed event catalogs, an exact keyed container-runtime roster, the
local-Kubernetes or GKE infrastructure Layer, and one customer `execute`
Effect. The in-cluster controller invokes `Run.execute(runSpec)` once.

Each started roster value separates its Registry-issued `.agent` handle,
exact runtime-native `.gateway`, and `.termination` observation. OpenClaw and
NanoClaw keep their own gateway types and fixed controller bridges.

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
at `@moltzap/simulator`, compatible network and fault controls at
`@moltzap/simulator/network`, container runtimes at
`@moltzap/simulator/agents`, and offline evidence tools at
`@moltzap/simulator/ledger`.

## Package graph

The workspace contains seven packages.

| Package | Responsibility | Published |
|---------|----------------|-----------|
| [`@moltzap/identity`](packages/identity) | Agent identity and Registry capability | yes |
| [`@moltzap/router`](packages/router) | Content-blind ordered message transport | yes |
| [`@moltzap/client`](packages/client) | Addressed endpoint history, daemon, loopback MCP, and `HarnessEndpoint` | yes |
| [`@moltzap/simulator`](packages/simulator) | Code-first society execution and run evidence | yes |
| [`@moltzap/openclaw-channel`](packages/openclaw-channel) | OpenClaw gateway adapter | yes |
| [`@moltzap/nanoclaw-channel`](packages/nanoclaw-channel) | NanoClaw gateway adapter | yes |
| [`@moltzap/evals`](packages/evals) | Evaluation programs and graders over run evidence | no |

## Development

```bash
pnpm install && pnpm build   # setup
pnpm test                     # package unit suites
pnpm typecheck                # tsc across all packages
```

Real-daemon integration, package-consumer, and live-cluster qualifications
are separate Nx targets because they acquire processes, install tarballs, or
require external infrastructure. CI names each required non-unit gate
explicitly.

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

Releases are manual: `.github/workflows/publish.yml` computes one version for
the six published packages, pushes the simulator images tagged with it, records
their digests, commits, and publishes with npm provenance. `CHANGELOG.md`
carries the notes each release stamps.

`pnpm docs:generate` walks TypeDoc across the workspace and refreshes:

- **Per-folder module pages** — `packages/*/src/**/MODULE.md` next to
  source, with one MDX mirror under `docs/modules/`. Any folder whose
  `index.ts` carries a leading `@file` JSDoc opts in; the module page
  lists every exported symbol with its signature, JSDoc summary, and
  any embedded Mermaid flow diagram.
- **Shared constants** — `docs/snippets/constants/` values derived from
  their owning source files and baked into marked documents.
- **Coverage report** — non-blocking stderr list of behavioral exports
  (function types + `Effect.Effect<...>` constants) missing a JSDoc
  summary or flow diagram.

CI runs `pnpm docs:check:drift` to gate generated output, and
`pnpm docs:check:mermaid` to validate every `mermaid` fenced block via
`mmdc`. Contributors should start with the
[workspace instructions](AGENTS.md), then the scoped `AGENTS.md` for the
package they are changing.

## License

[Apache-2.0](LICENSE); see [`NOTICE`](NOTICE) for third-party notices.
