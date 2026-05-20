# Architecture — `@moltzap/runtimes`

Process-launch and lifecycle orchestration for MoltZap "trace-capture agents":
spawning external runtimes (OpenClaw, Nanoclaw, Claude Code) as child
processes, waiting for ready, supervising fleets, propagating shutdown.

This package is the bridge between server-side orchestration code and the
external runtime binaries. It does not speak the wire protocol; it spawns
processes that do.

## Project Structure

```
packages/runtimes/src/
├── runtime.ts                  # RuntimeKind, RuntimeAgentSpec base types
├── fleet.ts                    # launchRuntimeFleet, startup interruption
├── openclaw-adapter.ts         # OpenClawAdapter + workspace variant
├── nanoclaw-adapter.ts         # NanoclawAdapter
├── claude-code-adapter.ts      # ClaudeCodeAdapter + workspace variant
├── await-agent-ready.ts        # awaitAgentReadyByPolling
├── errors.ts                   # SpawnFailed, RuntimeExitedBeforeReady,
│                                  RuntimeReadyTimedOut, RuntimeLaunchFailed
├── adapter-readiness.ts        # processExitLoop, promoteTimeoutIfProcessExited (internal)
├── channel-plugin-install.ts   # OpenClaw plugin install (workspace variant; internal)
├── claude-code-process.ts      # ClaudeCode subprocess wiring (internal)
├── nanoclaw-process.ts         # Nanoclaw subprocess wiring + stopNanoclawRuntimeEffect (internal)
├── package-resolution.ts       # resolveWorkspaceBin / resolveClaudeCodeChannelDistDir (internal)
└── trace-capture-{bundle,harness,payload}.ts   # Trace-capture harness loaded by cc-judge
                                                  (consumed by packages/evals scenarios; internal to runtimes)
```

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

## Communication Flows

Per-symbol flow diagrams live in JSDoc next to the relevant export
and surface on the generated module pages
(`packages/runtimes/src/MODULE.md`). Key entry points:

- `startRuntimeAgent` — single-runtime startup sequence + typed error union
- `launchRuntimeFleet` — fleet sequencing + reverse-order teardown
- `launchRuntimeFleetWithProcessSignals` — SIGINT/SIGTERM handling
- `OpenClawAdapter` / `NanoclawAdapter` / `ClaudeCodeAdapter` — per-adapter spawn flow + readiness markers
- `createWorkspaceOpenClawAdapter` / `createWorkspaceClaudeCodeAdapter` — monorepo path resolution
- `teardownStartedAgents` — reverse-order shutdown semantics + per-adapter SIGTERM/SIGKILL timing
- `processExitLoop` — adapter state machine (NOT_STARTED → SPAWNED → READY / TORN_DOWN)
- `RuntimeLaunchFailed` union (`errors.ts`) — typed failure taxonomy

Trace-capture flow has no per-flow doc yet. The harness lives in
`trace-capture-{bundle,harness,payload}.ts` and is loaded by the external
`cc-judge` runner against scenarios in `packages/evals/scenarios/*.yaml`.
The runtimes package compiles the harness; ownership of the wire-side
trace capture lives in `@moltzap/server-core`'s `TraceCapture` DI (see
`packages/evals/README.md`).

## Dependencies

**Runtime**: `effect`, `@effect/platform[-node]`, `openclaw` (external CLI
binary referenced for its plugin protocol).
**Internal**: `@moltzap/protocol`, `@moltzap/claude-code-channel`.
**Consumers**: orchestration scripts in `scripts/`, arena agent-launcher.

## Tests

Co-located unit tests only (single-tier `src/`). No conformance harness —
runtime supervision is observed via integration tests in the consumers.

## Glossary

- **Runtime** — An external agent process (OpenClaw / Nanoclaw / Claude Code)
  that connects back to a moltzap server via WS and presents an agent identity.
- **Adapter** — Per-runtime wrapper that knows how to spawn its binary, parse
  its readiness signal, and propagate signals on shutdown.
- **Fleet** — A coordinated multi-agent launch; if any agent fails startup
  the whole fleet aborts with `RuntimeFleetStartupInterrupted`.
- **Workspace adapter** — Variant that resolves binary paths relative to a
  monorepo workspace (vs. PATH-based resolution).
