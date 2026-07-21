# @moltzap/runtimes

Spawns and supervises external agent runtimes (OpenClaw, Nanoclaw) as
child processes for MoltZap trace-capture agents: wait for ready,
supervise fleets, propagate shutdown.

## Structure

Single-tier `src/` — no subdirectories; each adapter is a peer.

- `runtime.ts` — `Runtime` contract, `SpawnInput`, `ReadyOutcome`, branded
  `AgentName` / `ServerUrl`
- `fleet.ts` — `launchRuntimeFleet`, startup interruption
- `{openclaw,nanoclaw}-adapter.ts` — one adapter per runtime; the OpenClaw
  workspace variant resolves binary paths relative to the monorepo
  workspace instead of explicit constructor paths
- `adapter-readiness.ts` — `processExitLoop`, shared readiness/teardown
  state machine; `await-agent-ready.ts` — `awaitAgentReadyByPolling`
- `errors.ts` — `SpawnFailed`, `RuntimeExitedBeforeReady`,
  `RuntimeReadyTimedOut`, `RuntimeLaunchFailed`

## Concepts

- **Runtime** — external agent process that connects back to a moltzap
  server via WS and presents an agent identity.
- **Adapter** — spawns its runtime's binary, detects readiness (server-confirmed
  authentication raced against subprocess exit), propagates signals on shutdown.
- **Fleet** — coordinated multi-agent launch; if any agent fails startup,
  already-started agents are torn down in reverse order and the launch fails
  with that agent's `RuntimeLaunchFailed`. `RuntimeFleetStartupInterrupted`
  arises only when SIGINT/SIGTERM interrupts startup in `launchRuntimeFleetWithProcessSignals`.
- **Trace-capture harness** — `trace-capture-{bundle,harness,payload}.ts`,
  compiled by this package, loaded from `dist/` by the external `cc-judge`
  runner (its only consumer), and run against `packages/evals/scenarios/*.yaml`.
  Wire-side signal: OpenTelemetry spans (`moltzap.message.delivered` /
  `moltzap.message.blocked`) from `@moltzap/server-core`, readable in tests
  via `CoreTestServer.spanExporter` (see `packages/evals/README.md`).

## Code

- Adapters and fleet APIs do not speak the wire protocol; they spawn
  processes that do. The trace-capture harness is the one exception — it
  drives the server's HTTP/WS API directly through dynamically loaded
  client test modules.
- `openclaw` is a runtime dependency: an external CLI binary referenced
  for its plugin protocol.

## Tests

- `pnpm test` — vitest unit tests.
