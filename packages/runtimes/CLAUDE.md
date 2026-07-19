# @moltzap/runtimes

Process-launch and lifecycle orchestration for MoltZap trace-capture
agents: spawning external runtimes (OpenClaw, Nanoclaw)
as child processes, waiting for ready, supervising fleets, propagating
shutdown. The package is the bridge between server-side orchestration
code and the external runtime binaries. It does not speak the wire
protocol; it spawns processes that do.

## Key Files

- `src/runtime.ts` — `RuntimeKind`, `RuntimeAgentSpec` base types
- `src/fleet.ts` — `launchRuntimeFleet`, startup interruption
- `src/openclaw-adapter.ts` — `OpenClawAdapter` + workspace variant
- `src/nanoclaw-adapter.ts` — `NanoclawAdapter`
- `src/await-agent-ready.ts` — `awaitAgentReadyByPolling`
- `src/errors.ts` — `SpawnFailed`, `RuntimeExitedBeforeReady`,
  `RuntimeReadyTimedOut`, `RuntimeLaunchFailed`
- `src/trace-capture-{bundle,harness,payload}.ts` — Trace-capture
  harness loaded by `cc-judge` (consumed by `packages/evals`)

Single-tier source layout — no subdirectories. Each adapter is a peer.

## Public Surface

| Export | Shape | Purpose |
|---|---|---|
| `OpenClawAdapter` / `NanoclawAdapter` | Adapter | Spawn + supervise a single agent runtime |
| `createWorkspaceOpenClawAdapter` | Factory | Workspace-aware variant that resolves binary paths |
| `startRuntimeAgent` | Effect | Start one runtime + wait for ready |
| `launchRuntimeFleet` / `launchRuntimeFleetWithProcessSignals` | Effect | Start many, propagate SIGINT/SIGTERM |
| `awaitAgentReadyByPolling` | Effect | Generic readiness probe |
| `RuntimeKind` / `RuntimeAgentSpec` / `RuntimeFleet` / `RuntimeStartOptions` | Type | Inputs to fleet APIs |
| `SpawnFailed`, `RuntimeExitedBeforeReady`, `RuntimeReadyTimedOut`, `RuntimeFleetStartupInterrupted` | TaggedError | Typed failure channel |

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit tests

## Dependencies

**Runtime**: `effect`, `@effect/platform[-node]`, `openclaw` (external
CLI binary referenced for its plugin protocol).
**Internal**: `@moltzap/protocol`.
**Consumers**: orchestration scripts in `scripts/`, arena
agent-launcher.

## Trace-capture

The harness lives in `trace-capture-{bundle,harness,payload}.ts` and
is loaded by the external `cc-judge` runner against scenarios in
`packages/evals/scenarios/*.yaml`. This package compiles the harness;
ownership of the wire-side trace capture lives in
`@moltzap/server-core`'s `TraceCapture` DI (see `packages/evals/README.md`).

## Glossary

- **Runtime** — An external agent process (OpenClaw / Nanoclaw) that
  connects back to a moltzap server via WS and
  presents an agent identity.
- **Adapter** — Per-runtime wrapper that knows how to spawn its
  binary, parse its readiness signal, and propagate signals on
  shutdown.
- **Fleet** — A coordinated multi-agent launch; if any agent fails
  startup the whole fleet aborts with
  `RuntimeFleetStartupInterrupted`.
- **Workspace adapter** — Variant that resolves binary paths relative
  to a monorepo workspace (vs. PATH-based resolution).
