# @moltzap/testbed

Launches and supervises a collection of external agents connected through
MoltZap. OpenClaw and Nanoclaw remain runtime-adapter implementations beneath
the testbed surface.

## Structure

Single-tier `src/` — no subdirectories; each adapter is a peer.

- `runtime.ts` — `Runtime` contract, `SpawnInput`, `ReadyOutcome`, branded
  `AgentName` / `ServerUrl`
- `testbed.ts` — `launchTestbed`, coordinated startup and interruption
- `{openclaw,nanoclaw}-adapter.ts` — one adapter per runtime; installed
  runtime packages are the defaults and explicit binary/plugin paths remain
  available for tests and custom installations
- `install-mode.ts` — one fleet-wide `published` / `workspace` artifact
  decision, inferred from package resolution or selected explicitly
- `immutable-cache.ts` — generic building-directory, ready-marker, and
  immutable-generation lifecycle shared by runtime installers, plus the
  fingerprint envelope and the process-wide cold-build permit
- `json-guards.ts` — `makeJsonGuards`, manifest/lockfile shape checks bound to
  one module's error factory
- `openclaw-plugin-cache.ts` — pinned npm plugin installation, provenance
  validation, immutable project caching, and per-agent materialization
- `nanoclaw-install.ts` — pinned source/assets, deterministic dependency
  lock, workspace package packing, immutable cache promotion, and Docker
  image build
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
- **Install mode** — one decision applies to the whole testbed and each
  adapter interprets it. `published` runs every `@moltzap` artifact from the
  npm registry at the testbed's exact installed pins; `workspace` runs every
  `@moltzap` artifact from the current workspace build. Columns never mix.
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
