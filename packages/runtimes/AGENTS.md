# @moltzap/runtimes

Process-launch and lifecycle orchestration for MoltZap trace-capture
agents: spawning external runtimes (OpenClaw, Nanoclaw, Claude Code)
as child processes, waiting for ready, supervising fleets, propagating
shutdown. The package is the bridge between server-side orchestration
code and the external runtime binaries. The adapters and fleet APIs do not speak the
wire protocol; they spawn processes that do. The trace-capture
harness is the one exception — it drives the server's HTTP/WS API
directly through dynamically loaded client test modules.

## Key Files

- `src/runtime.ts` — `Runtime` interface contract, `SpawnInput`,
  `ReadyOutcome`, branded `AgentName` / `ServerUrl`
- `src/fleet.ts` — `launchRuntimeFleet`, startup interruption
- `src/openclaw-adapter.ts` — `OpenClawAdapter` + workspace variant
- `src/nanoclaw-adapter.ts` — `NanoclawAdapter`
- `src/claude-code-adapter.ts` — `ClaudeCodeAdapter` + workspace variant
- `src/await-agent-ready.ts` — `awaitAgentReadyByPolling`
- `src/adapter-readiness.ts` — `processExitLoop`, shared adapter
  readiness/teardown state machine
- `src/channel-plugin-install.ts` — shared channel-package install +
  workspace-seed helpers
- `src/claude-code-process.ts` / `src/nanoclaw-process.ts` —
  per-runtime process/config helpers
- `src/package-resolution.ts` — workspace binary/package resolution
- `src/errors.ts` — `SpawnFailed`, `RuntimeExitedBeforeReady`,
  `RuntimeReadyTimedOut`, `RuntimeLaunchFailed`
- `src/trace-capture-{bundle,harness,payload}.ts` — Trace-capture
  harness loaded by `cc-judge` (run against `packages/evals/scenarios/`)

Single-tier source layout — no subdirectories. Each adapter is a peer.

## Public Surface

| Export | Shape | Purpose |
|---|---|---|
| `OpenClawAdapter` / `NanoclawAdapter` / `ClaudeCodeAdapter` | Adapter | Spawn + supervise a single agent runtime |
| `createWorkspace{OpenClaw,ClaudeCode}Adapter` | Factory | Workspace-aware variants that resolve binary paths |
| `startRuntimeAgent` | Effect | Start one runtime + wait for ready |
| `launchRuntimeFleet` / `launchRuntimeFleetWithProcessSignals` | Effect | Start many, propagate SIGINT/SIGTERM |
| `awaitAgentReadyByPolling` | Effect | Generic readiness probe |
| `RuntimeKind` / `RuntimeAgentSpec` / `RuntimeFleet` / `RuntimeStartOptions` | Type | Inputs to fleet APIs |
| `SpawnFailed`, `RuntimeExitedBeforeReady`, `RuntimeReadyTimedOut`, `RuntimeFleetStartupInterrupted` | TaggedError | Typed failure channel |

## Commands

- `pnpm build` — `tsc`
- `pnpm test` — vitest unit tests
- `pnpm test:integration` — vitest integration tests
  (`vitest.integration.config.ts`; spawns a real Claude Code runtime)

## Dependencies

**Runtime**: `effect`, `@effect/platform[-node]`, `openclaw` (external
CLI binary referenced for its plugin protocol).
**Internal**: `@moltzap/protocol`, `@moltzap/claude-code-channel`.
**Consumers**: the external `cc-judge` runner, which loads the
compiled trace-capture harness from `dist/`. No in-repo package
imports `@moltzap/runtimes`.

## Trace-capture

The harness lives in `trace-capture-{bundle,harness,payload}.ts` and
is loaded by the external `cc-judge` runner against scenarios in
`packages/evals/scenarios/*.yaml`. This package compiles the harness;
the wire-side signal is
OpenTelemetry spans (`moltzap.message.delivered` / `moltzap.message.blocked`)
emitted by `@moltzap/server-core`, readable in tests via
`CoreTestServer.spanExporter` (see `packages/evals/README.md`).

## Glossary

- **Runtime** — An external agent process (OpenClaw / Nanoclaw /
  Claude Code) that connects back to a moltzap server via WS and
  presents an agent identity.
- **Adapter** — Per-runtime wrapper that knows how to spawn its
  binary, detect readiness (server-confirmed authentication raced
  against subprocess exit), and propagate signals on
  shutdown.
- **Fleet** — A coordinated multi-agent launch; if any agent fails
  startup, already-started agents are torn down in reverse order and
  the launch fails with that agent's `RuntimeLaunchFailed` error.
  `RuntimeFleetStartupInterrupted` arises only when SIGINT/SIGTERM
  interrupts startup in `launchRuntimeFleetWithProcessSignals`.
- **Workspace adapter** — Variant that resolves binary paths relative
  to a monorepo workspace (vs. explicit binary paths passed to the adapter constructor).
