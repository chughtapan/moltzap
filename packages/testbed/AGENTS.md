# @moltzap/testbed

Launches and supervises a collection of external agents connected through
MoltZap. OpenClaw and Nanoclaw remain runtime-adapter implementations beneath
the testbed surface.

## Structure

`src/` holds adapter peers plus one subdirectory, `src/simulator/`, the
society-simulator surface (five public contracts + recording schema;
design doc: chughtapan/moltzap#812), exported as
`@moltzap/testbed/simulator`; the package root export is unchanged.

- `runtime.ts` — `Runtime` contract, `SpawnInput`, `ReadyOutcome`, branded
  `AgentName` / `ServerUrl`
- `testbed.ts` — `launchTestbed`, coordinated startup and interruption
- `{openclaw,nanoclaw}-adapter.ts` — one adapter per runtime; installed
  runtime packages are the defaults and explicit binary/plugin paths remain
  available for tests and custom installations
- `nanoclaw-install.ts` — pinned source/assets, deterministic dependency
  lock, immutable cache promotion, and Docker image build
- `nanoclaw-process.ts` — per-agent runtime directory, process lifecycle,
  logs, and teardown; container isolation comes from NanoClaw's own
  cwd-derived install slug
- `adapter-readiness.ts` — `raceReadiness`, the shared server-auth vs
  process-exit readiness contract; `await-agent-ready.ts` —
  `awaitAgentReadyByPolling`
- `child-process.ts` — shared shell-exec/platform-error helpers
  (`makeCommandHelpers`), stdout/stderr capture, supervised spawn
  (`startSupervisedProcess`), exit-fiber polling, and TERM→KILL
  escalation (`escalatingKill`) used by both adapters
- `errors.ts` — `SpawnFailed`, `RuntimeExitedBeforeReady`,
  `RuntimeReadyTimedOut`, `RuntimeLaunchFailed`
- `simulator/` — tree-shaped: `episode.ts` (`executeRun`) is the
  composition root over four peer contracts (`run-config.ts`,
  `environment-mount.ts`, `world-driver.ts`, `event-log.ts` +
  `recording.ts` + `attempts.ts`), with `run-spec.ts` as the single
  schema registry, `ids.ts`/`errors.ts` as shared kernels, and
  `stub-runtime.ts` (`createStubRuntime`) as the scripted
  hermetic-CI/demo runtime; see `simulator/README.md`

## Concepts

- **Runtime** — external agent process that connects back to a moltzap
  server via WS and presents an agent identity.
- **Adapter** — spawns its runtime's binary, detects readiness (server-confirmed
  authentication raced against subprocess exit), propagates signals on shutdown.
- **Testbed** — coordinated multi-agent launch; if any agent fails startup,
  already-started agents are torn down in reverse order and the launch fails
  with that agent's `RuntimeLaunchFailed`. `TestbedStartupInterrupted`
  arises only when SIGINT/SIGTERM interrupts startup in
  `launchTestbedWithProcessSignals`. A testbed currently uses one runtime kind
  for the whole agent collection.
- **Trace-capture harness** — `trace-capture-{bundle,harness,payload}.ts`,
  compiled by this package, loaded from `dist/` by the external `cc-judge`
  runner (its only consumer), and run against `packages/evals/scenarios/*.yaml`.
  Wire-side signal: OpenTelemetry spans (`moltzap.message.delivered` /
  `moltzap.message.blocked`) from `@moltzap/server-core`, readable in tests
  via `CoreTestServer.spanExporter` (see `packages/evals/README.md`).

## Code

- Adapters and testbed APIs do not speak the wire protocol; they spawn
  processes that do. The trace-capture harness is the one exception — it
  drives the server's HTTP/WS API directly through dynamically loaded
  client test modules.
- `openclaw` is a runtime dependency: an external CLI binary referenced
  for its plugin protocol.

## Tests

- `pnpm test` — vitest unit tests.
