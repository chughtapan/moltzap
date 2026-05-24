# runtimes/src

_`packages/runtimes/src`_

## Purpose

Public exports for runtime adapter orchestration.

## Public surface

### [`AgentName`](./runtime.ts#L6)

_TypeAlias_

```ts
export type AgentName = string & Brand.Brand<"AgentName">;
```

### [`AgentName`](./runtime.ts#L6)

_Variable_

```ts
export type AgentName = string & Brand.Brand<"AgentName">
```

### [`ApiKey`](./runtime.ts#L7)

_TypeAlias_

```ts
export type ApiKey = string & Brand.Brand<"ApiKey">;
```

### [`ApiKey`](./runtime.ts#L7)

_Variable_

```ts
export type ApiKey = string & Brand.Brand<"ApiKey">
```

### [`awaitAgentReadyByPolling`](./await-agent-ready.ts#L105)

_Function_

```ts
export function awaitAgentReadyByPolling(
  connections: PollingConnections,
  agentId: string,
  timeoutMs: number,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Effect.Effect<ReadyOutcome, never, never>
```

### [`ClaudeCodeAdapter`](./claude-code-adapter.ts#L417)

_Class_

```ts
export class ClaudeCodeAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: ClaudeCodeAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    const toSpawnFailed = (cause: unknown): SpawnFailed => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return new SpawnFailed({
        agentName: input.agentName,
        cause: error,
        message: `Failed to spawn agent "${input.agentName}": ${error.message}`,
      });
    };

    return Effect.gen(this, function* () {
      const { stateDir, extDir } = yield* prepareClaudeCodeStateDir(
        this.deps,
        input,
      );

      const mcpConfigPath = yield* writeClaudeCodeMcpConfig({
        stateDir,
        extDir,
        serverUrl: input.serverUrl,
        apiKey: input.apiKey,
        agentName: input.agentName,
      });

      const logBuffer = { value: "" };
      const child = yield* spawnConfiguredClaude({
        deps: this.deps,
        stateDir,
        mcpConfigPath,
        logBuffer,
      });

      this.state = {
        process: child,
        stateDir,
        spawnInput: input,
        logBuffer,
        tornDown: false,
      };
    }).pipe(Effect.mapError(toSpawnFailed), Effect.provide(NodeContext.layer));
  }
```

Claude Code runtime adapter. Spawns the `claude` CLI as the host
process with the moltzap channel installed as a stdio MCP server.

```mermaid
flowchart TD
  CCS["ClaudeCodeAdapter.spawn(input)"]
  CC1["1. prepareClaudeCodeStateDir&lt;br>makeTempDirectory, seedWorkspaceFiles,&lt;br>installClaudeCodeChannelPlugin&lt;br>(resolves modelcontextprotocol/sdk + effect)"]
  CC2["2. writeClaudeCodeMcpConfig&lt;br>{ mcpServers: { moltzap: { command: 'node', args: [extDir/dist/cli.js], env: { MOLTZAP_API_KEY, MOLTZAP_SERVER_URL, MOLTZAP_SERVER_NAME } } } }"]
  CC3["3. spawnConfiguredClaude&lt;br>buildClaudeArgs:&lt;br>--strict-mcp-config --mcp-config&lt;br>--print --input-format stream-json&lt;br>--output-format stream-json --verbose&lt;br>--dangerously-skip-permissions&lt;br>--add-dir stateDir/workspace&lt;br>env: CLAUDE_CODE_HOME=stateDir"]
  CC4["4. state = { process, stateDir, logBuffer, ... }"]
  CCR["waitUntilReady&lt;br>race(server.awaitAgentReady, processExitLoop)&lt;br>(cc-channel MCP stdio server authenticates on start)"]
  CCS --> CC1 --> CC2 --> CC3 --> CC4 --> CCR
```

Inbound marker: `notifications/claude/channel`. The cc-channel
sends MCP `notifications/claude/channel` per inbound message; this
is visible in claude's `--verbose` stream-json output. Shutdown
via SIGTERM on the claude process propagates to the MCP stdio
child naturally — no process-group kill needed (unlike OpenClaw).

### [`ClaudeCodeAdapterDeps`](./claude-code-adapter.ts#L60)

_Interface_

```ts
export interface ClaudeCodeAdapterDeps {
  readonly server: RuntimeServerHandle;

  /**
   * Absolute path to the `claude` CLI bin. Production callers pass the
   * workspace `node_modules/.bin/claude` (resolved by
   * `createWorkspaceClaudeCodeAdapter`).
   */
  readonly claudeBin: string;

  /**
   * Absolute path to `@moltzap/claude-code-channel`'s built `dist/` dir.
   * The adapter copies this into the per-agent state dir and points the
   * MCP config at the copied bin.
   */
  readonly channelDistDir: string;

  /**
   * Absolute path to the moltzap repo root — used to symlink workspace
   * deps (`@moltzap/protocol`, `@moltzap/client`, etc.) into the plugin
   * state dir's `node_modules`.
   */
  readonly repoRoot: string;
}
```

### [`createWorkspaceClaudeCodeAdapter`](./claude-code-adapter.ts#L573)

_Function_

```ts
export function createWorkspaceClaudeCodeAdapter(
  input: WorkspaceClaudeCodeAdapterInput,
): ClaudeCodeAdapter
```

Workspace-aware factory mirroring
createWorkspaceOpenClawAdapter. Resolves `claudeBin` and
`channelDistDir` from the monorepo at construction time.

```mermaid
flowchart TD
  CCWF["createWorkspaceClaudeCodeAdapter(input)"]
  CCBIN["claudeBin = input.claudeBin ??&lt;br>resolveWorkspaceClaudeBin&lt;br>(resolveWorkspaceBin binName='claude', packageName='@anthropic-ai/claude-code')"]
  CCROOT["resolveClaudeCodePackageRoot&lt;br>(requireFromHere.resolve('@anthropic-ai/claude-code/package.json'))"]
  CCCH["channelDistDir = input.channelDistDir ??&lt;br>resolveClaudeCodeChannelDistDir"]
  CCCHTRY["Try: requireFromHere.resolve('@moltzap/claude-code-channel') → dirname/dist"]
  CCCHFALL["Fallback: repoRoot/packages/claude-code-channel/dist (logs warning)"]
  CCWF --> CCBIN --> CCROOT --> CCCH
  CCCH --> CCCHTRY
  CCCH --> CCCHFALL
```

### [`createWorkspaceOpenClawAdapter`](./openclaw-adapter.ts#L406)

_Function_

```ts
export function createWorkspaceOpenClawAdapter(
  input: WorkspaceOpenClawAdapterInput,
): OpenClawAdapter
```

Workspace-aware factory: resolves `openclawBin`, `channelDistDir`,
and `repoRoot` from the monorepo layout at module-load time
(synchronously via `Effect.runSync`), then constructs an
OpenClawAdapter.

```mermaid
flowchart TD
  OCWF["createWorkspaceOpenClawAdapter(input)"]
  OCPR["resolveWorkspacePackageRoot&lt;br>(walk import.meta.url ancestors to 'packages' segment)"]
  OCRR["repoRoot = input.repoRoot ?? two-dirs-up-from-packageRoot"]
  OCBIN["openclawBin = input.openclawBin ??&lt;br>resolveWorkspaceOpenClawBin&lt;br>(createRequire(packages/runtimes/package.json).resolve('openclaw') → walk back to package root → read package.json bin)"]
  OCCH["channelDistDir = input.channelDistDir ??&lt;br>repoRoot/packages/openclaw-channel/dist"]
  OCOUT["new OpenClawAdapter({ server, openclawBin, channelDistDir, repoRoot })"]
  OCWF --> OCPR --> OCRR --> OCBIN --> OCCH --> OCOUT
```

Non-workspace usage: pass explicit `openclawBin` /
`channelDistDir` to OpenClawAdapter's constructor
directly. This factory is a convenience for monorepo callers.

### [`launchRuntimeFleet`](./fleet.ts#L335)

_Function_

```ts
export function launchRuntimeFleet(
  options: RuntimeFleetLaunchOptions,
): Effect.Effect<RuntimeFleet, RuntimeLaunchFailed, never>
```

Launch N agents (sequentially by default; concurrency is opt-in),
tearing down all already-started agents if any one fails.

```mermaid
flowchart TD
  FL["launchRuntimeFleet(options)&lt;br>Effect.scoped, withSpan"]
  FL --> SEQ["Effect.forEach(options.agents, startFleetAgent,&lt;br>{ concurrency: options.concurrency ?? 1 })"]
  SEQ -->|One fails| TD["onExit: teardownStartedAgents&lt;br>in REVERSE insertion order"]
  SEQ -->|All succeed| RF["toRuntimeFleet(started)&lt;br>→ RuntimeFleet { agents, stopAll, getLogs }"]
```

Sibling: launchRuntimeFleetWithProcessSignals adds SIGINT
/ SIGTERM handlers so Ctrl-C during startup interrupts cleanly via
`RuntimeFleetStartupInterrupted`.

### [`launchRuntimeFleetWithProcessSignals`](./fleet.ts#L436)

_Function_

```ts
export function launchRuntimeFleetWithProcessSignals(
  options: RuntimeFleetProcessSignalOptions,
): Effect.Effect<
  RuntimeFleet,
  RuntimeLaunchFailed | RuntimeFleetStartupInterrupted,
  never
>
```

Wraps launchRuntimeFleet with OS-signal handlers so user
Ctrl-C during startup interrupts cleanly instead of half-launching
a fleet.

```mermaid
flowchart TD
  LRFPS["launchRuntimeFleetWithProcessSignals(options)"]
  LRFPS --> FORK["Effect.runFork(launchRuntimeFleet) → fiber"]
  FORK --> SIGS["installProcessSignalHandlers&lt;br>(SIGINT, SIGTERM by default)&lt;br>first signal: shutdownSignal.value = signal&lt;br>Fiber.interrupt(fiber)"]
  SIGS --> OBS["observeFleetLaunchFiber&lt;br>routes by exit shape"]
  OBS -->|Success| OK["resume(Effect.succeed(fleet))"]
  OBS -->|Interrupted via signal| INT["resume(interruptedStartup(signal))&lt;br>→ RuntimeFleetStartupInterrupted"]
  OBS -->|Other failure| ERR["resume(Effect.failCause(...))"]
```

**Fails with:**

- `RuntimeFleetStartupInterrupted` — a signal arrives during fleet startup

### [`LogSlice`](./runtime.ts#L51)

_Interface_

```ts
export interface LogSlice {
  /** stdout+stderr bytes starting from the requested offset. */
  readonly text: string;
  /** Byte offset to pass on the next call to continue reading. */
  readonly nextOffset: number;
}
```

### [`NanoclawAdapter`](./nanoclaw-adapter.ts#L79)

_Class_

```ts
export class NanoclawAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: NanoclawAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    const toSpawnFailed = (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return new SpawnFailed({
        agentName: input.agentName,
        cause: error,
        message: `Failed to spawn agent "${input.agentName}": ${error.message}`,
      });
    };

    return Effect.gen(this, function* () {
      yield* ensureNanoclawRuntimeInstalledEffect();

      const handle = yield* startNanoclawRuntimeEffect({
        apiKey: input.apiKey,
        serverUrl: input.serverUrl,
        workspaceFiles: input.workspaceFiles,
      });

      yield* Effect.sync(() => {
        this.state = { handle, spawnInput: input, tornDown: false };
      });
    }).pipe(Effect.mapError(toSpawnFailed), Effect.provide(NodeContext.layer));
```

Nanoclaw runtime adapter. Runs agent subprocesses inside Docker
containers via the OneCLI gateway. Two-phase startup: ensure the
runtime cache is installed, then launch.

```mermaid
flowchart TD
  NS["NanoclawAdapter.spawn(input)"]
  subgraph P1["Phase 1 — ensureNanoclawRuntimeInstalledEffect"]
    P1C{".ready exists?"}
    P1WARM["syncChannelFileIntoCache&lt;br>(diff channel + client/dist; rebuild if drifted)"]
    P1COLD["preflightDocker → downloadTarball&lt;br>→ copy channel + barrel + skill&lt;br>→ buildNanoclawRuntimeCache&lt;br>→ promoteRuntimeCache"]
    P1C -->|warm| P1WARM
    P1C -->|cold| P1COLD
  end
  subgraph P2["Phase 2 — startNanoclawRuntimeEffect"]
    P2DIR[createNanoclawDataDir]
    P2OC["ensureOnecliRunning&lt;br>(probe 10254; up if unreachable)"]
    P2WS[writeRuntimeWorkspaceFiles]
    P2SP["startNanoclawProcess&lt;br>(node dist/index.js + ONECLI_URL env)"]
    P2WAIT["waitForNanoclawConnection&lt;br>(scan logs for CONNECTED_MARKER)"]
    P2DIR --> P2OC --> P2WS --> P2SP --> P2WAIT
  end
  NCR["waitUntilReady — TWO gates:&lt;br>1. inner: waitForNanoclawConnection (stdout marker)&lt;br>2. outer: server.awaitAgentReady (WS auth)"]
  NS --> P1 --> P2 --> NCR
```

Inbound marker: `New messages`. Cache lives at
`NANOCLAW_RUNTIME_CACHE`; the channel-file sync detects drift in
the moltzap channel + client-dist files and rebuilds.

### [`NanoclawAdapterDeps`](./nanoclaw-adapter.ts#L24)

_Interface_

```ts
export interface NanoclawAdapterDeps {
  readonly server: RuntimeServerHandle;
  readonly nanoclawCache?: string;
}
```

### [`OpenClawAdapter`](./openclaw-adapter.ts#L267)

_Class_

```ts
export class OpenClawAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: OpenClawAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    const toSpawnFailed = (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return new SpawnFailed({
        agentName: input.agentName,
        cause: error,
        message: `Failed to spawn agent "${input.agentName}": ${error.message}`,
      });
    };

    return Effect.gen(this, function* () {
      const port = yield* allocateFreePort();
      const { deps } = this;
      const stateDir = yield* prepareOpenClawStateDir(deps, input);
      const logBuffer = { value: "" };
      const child = yield* spawnConfiguredOpenClaw(
        deps,
        stateDir,
        port,
        logBuffer,
      );

      const st: AdapterState = {
        process: child,
        stateDir,
        logBuffer,
        spawnInput: input,
        tornDown: false,
      };

      this.state = st;
    }).pipe(Effect.mapError(toSpawnFailed), Effect.provide(NodeContext.layer));
  }
```

OpenClaw runtime adapter. Spawns the OpenClaw gateway as a child
process, configures it with a moltzap channel plugin, and reports
readiness via the server-side WS authentication event.

```mermaid
flowchart TD
  OCS["OpenClawAdapter.spawn(input)"]
  OC1["1. allocateFreePort()&lt;br>NodeSocketServer.make({ port: 0 })"]
  OC2["2. prepareOpenClawStateDir&lt;br>makeTempDirectory, writeOpenClawConfig,&lt;br>seedWorkspaceFiles, installChannelPlugin"]
  OC3["3. buildOpenClawProcessPlan(openclawBin, port)&lt;br>(handles .mjs vs binary entry)"]
  OC4["4. spawnOpenClawProcess(env=OPENCLAW_STATE_DIR,&lt;br>OPENCLAW_CONFIG_PATH)&lt;br>scope-bound; exitFiber + log buffer"]
  OC5["5. state = { process, stateDir, logBuffer, ... }"]
  OCR["waitUntilReady&lt;br>race(server.awaitAgentReady, processExitLoop)&lt;br>inbound marker: 'inbound from agent:'"]
  OCS --> OC1 --> OC2 --> OC3 --> OC4 --> OC5 --> OCR
```

Readiness signal: server-side WS authentication event surfaces via
`deps.server.awaitAgentReady`. Inbound traffic log marker:
`inbound from agent:`. Errors flow into the fleet via `SpawnFailed`
(boot) or `RuntimeExitedBeforeReady` / `RuntimeReadyTimedOut`
(post-spawn, surfaced by `processExitLoop`).

### [`OpenClawAdapterDeps`](./openclaw-adapter.ts#L144)

_Interface_

```ts
export interface OpenClawAdapterDeps {
  readonly server: RuntimeServerHandle;
  readonly openclawBin: string;
  readonly channelDistDir: string;
  readonly repoRoot: string;
}
```

### [`ReadyOutcome`](./runtime.ts#L58)

_TypeAlias_

```ts
export type ReadyOutcome =
  | { readonly _tag: "Ready" }
```

### [`Runtime`](./runtime.ts#L77)

_Interface_

```ts
export interface Runtime {
  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never>;

  /**
   * Blocks until the agent's subprocess has authenticated against the server
   * (confirmed by ConnectionManager entry) or timeout/exit.
   * On Timeout or ProcessExited, the adapter calls teardown internally
   * before returning.
   */
  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never>;

  /** Idempotent. SIGTERM → wait 10s → SIGKILL to process group. rm -rf workdir. */
  teardown(): Effect.Effect<void, never, never>;

  /** Returns stdout+stderr from the given byte offset. */
  getLogs(offset: number): LogSlice;

  /** Substring that proves inbound message delivery when matched against post-send logs. */
  getInboundMarker(): string;
}
```

Runtime interface contract for agent subprocess management.

Five methods. spawn starts the subprocess. waitUntilReady blocks until
the server's ConnectionManager confirms authentication (or timeout/exit).
teardown kills the process group and removes the working directory.
getLogs returns accumulated output from a byte offset.
getInboundMarker returns a substring that proves an inbound message
was received by the runtime's channel plugin.

### [`RuntimeAgentSpec`](./fleet.ts#L34)

_Interface_

```ts
export interface RuntimeAgentSpec {
  readonly agentName: string;
  readonly apiKey: string;
  readonly agentId: string;
  readonly serverUrl: string;
  readonly workspaceFiles?: ReadonlyArray<WorkspaceFile>;
  readonly modelId?: string;
}
```

### [`RuntimeExitedBeforeReady`](./errors.ts#L46)

_Class_

```ts
export class RuntimeExitedBeforeReady extends Data.TaggedError(
  "RuntimeExitedBeforeReady",
)<{
  readonly agentName: string;
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly message: string;
}> {}
```

Raised by `startPendingRuntimeAgent` when `waitUntilReady` returns
`ProcessExited`. The process exited before reaching ready.

`stderr` carries the full accumulated stdout+stderr at exit;
`exitCode` is `null` only if the process exited via signal.
Caller action: inspect `stderr`; check binary auth config.

### [`RuntimeFleet`](./fleet.ts#L74)

_Interface_

```ts
export interface RuntimeFleet {
  readonly agents: ReadonlyArray<RuntimeFleetAgent>;
  stopAll(): Effect.Effect<void, never, never>;
  getLogs(name: string): string;
}
```

### [`RuntimeFleetAgent`](./fleet.ts#L69)

_Interface_

```ts
export interface RuntimeFleetAgent {
  readonly name: string;
  readonly agentId: string;
}
```

### [`RuntimeFleetLaunchOptions`](./fleet.ts#L53)

_Interface_

```ts
export interface RuntimeFleetLaunchOptions {
  readonly kind: RuntimeKind;
  readonly server: RuntimeServerHandle;
  readonly agents: ReadonlyArray<RuntimeAgentSpec>;
  readonly readyTimeoutMs: number;
  readonly concurrency?: number | "unbounded";
  readonly openclaw?: Omit<WorkspaceOpenClawAdapterInput, "server">;
  readonly nanoclaw?: Omit<NanoclawAdapterDeps, "server">;
  readonly claudeCode?: Omit<WorkspaceClaudeCodeAdapterInput, "server">;
}
```

### [`RuntimeFleetProcessSignalOptions`](./fleet.ts#L64)

_Interface_

```ts
export interface RuntimeFleetProcessSignalOptions
  extends RuntimeFleetLaunchOptions {
  readonly signals?: ReadonlyArray<Signal>;
}
```

### [`RuntimeFleetStartupInterrupted`](./fleet.ts#L80)

_Class_

```ts
export class RuntimeFleetStartupInterrupted extends Data.TaggedError(
  "RuntimeFleetStartupInterrupted",
)<{
  readonly signal: Signal;
  readonly message: string;
}> {}
```

### [`RuntimeKind`](./fleet.ts#L30)

_TypeAlias_

```ts
export type RuntimeKind = "openclaw" | "nanoclaw" | "claude-code";
```

### [`RuntimeLaunchFailed`](./errors.ts#L64)

_TypeAlias_

```ts
export type RuntimeLaunchFailed =
  | SpawnFailed
  | RuntimeReadyTimedOut
  | RuntimeExitedBeforeReady;
```

Union of every failure mode `startRuntimeAgent` and
`launchRuntimeFleet` can produce. Use `Effect.catchTags` to
branch by tag, or `Effect.catchAll` to handle uniformly.

Note: `RuntimeFleetStartupInterrupted` lives in `fleet.ts` because
it only arises in the signal-handling variant and carries the
interrupting `Signal`.

### [`RuntimeReadyTimedOut`](./errors.ts#L30)

_Class_

```ts
export class RuntimeReadyTimedOut extends Data.TaggedError(
  "RuntimeReadyTimedOut",
)<{
  readonly agentName: string;
  readonly timeoutMs: number;
  readonly message: string;
}> {}
```

Raised by `startPendingRuntimeAgent` when `waitUntilReady` returns
`Timeout`. The process is still running but never signaled ready
within `timeoutMs`.

Caller action: increase `readyTimeoutMs`, or inspect
`runtime.getLogs(0)` to see what the subprocess is doing.

### [`RuntimeServerHandle`](./runtime.ts#L22)

_Interface_

```ts
export interface RuntimeServerHandle {
  /**
   * Resolves to `Ready` when the named agent has authenticated against the
   * server. Resolves to `Timeout` after `timeoutMs` if no authenticated
   * connection ever appears. Resolves to `ProcessExited` only if the
   * implementation can detect that the agent's owning process exited before
   * authenticating; otherwise `Timeout` covers that case (the runtime
   * adapters layer their own exit-detection on top via `Effect.race`).
   *
   * In-process implementations wire this through `awaitAgentReadyByPolling`.
   * Out-of-process implementations (e.g., a zapbot orchestrator talking to
   * a standalone moltzap-server) implement it directly, typically via a
   * presence-event subscription on the server's WebSocket API.
   */
  awaitAgentReady(
    agentId: string,
    timeoutMs: number,
  ): Effect.Effect<ReadyOutcome, never, never>;
}
```

### [`RuntimeStartOptions`](./fleet.ts#L43)

_Interface_

```ts
export interface RuntimeStartOptions {
  readonly kind: RuntimeKind;
  readonly server: RuntimeServerHandle;
  readonly agent: RuntimeAgentSpec;
  readonly readyTimeoutMs: number;
  readonly openclaw?: Omit<WorkspaceOpenClawAdapterInput, "server">;
  readonly nanoclaw?: Omit<NanoclawAdapterDeps, "server">;
  readonly claudeCode?: Omit<WorkspaceClaudeCodeAdapterInput, "server">;
}
```

### [`ServerUrl`](./runtime.ts#L8)

_TypeAlias_

```ts
export type ServerUrl = string & Brand.Brand<"ServerUrl">;
```

### [`ServerUrl`](./runtime.ts#L8)

_Variable_

```ts
export type ServerUrl = string & Brand.Brand<"ServerUrl">
```

### [`SpawnFailed`](./errors.ts#L16)

_Class_

```ts
export class SpawnFailed extends Data.TaggedError("SpawnFailed")<{
  readonly agentName: string;
  readonly message: string;
  readonly cause: Error;
}> {}
```

Raised by `Runtime.spawn()` in any adapter when the child process
cannot be started — exec error, missing binary, port allocation
failure, state-dir creation failure.

`cause` carries the underlying Error.
Caller action: surface to user. No retry — binary or config is wrong.

### [`SpawnInput`](./runtime.ts#L42)

_Interface_

```ts
export interface SpawnInput {
  readonly agentName: AgentName;
  readonly apiKey: ApiKey;
  readonly agentId: string;
  readonly serverUrl: ServerUrl;
  readonly workspaceFiles?: ReadonlyArray<WorkspaceFile>;
  readonly modelId?: string;
}
```

### [`startRuntimeAgent`](./fleet.ts#L307)

_Function_

```ts
export function startRuntimeAgent(
  options: RuntimeStartOptions,
): Effect.Effect<Runtime, RuntimeLaunchFailed, never>
```

Spawn one runtime agent, wait for ready, release the startup cleanup
scope and hand a long-lived `Runtime` back to the caller.

```mermaid
flowchart TD
  A["startRuntimeAgent(options)"]
  A --> B["Effect.scoped:&lt;br>startPendingRuntimeAgent → PendingAgent"]
  B --> C[releaseStartupCleanup]
  C --> D["Runtime { stop, getLogs }"]
  B -->|Spawn fails| E[SpawnFailed]
  B -->|Process exits early| F[RuntimeExitedBeforeReady]
  B -->|Ready signal times out| G[RuntimeReadyTimedOut]
```

Error channel is the union `RuntimeLaunchFailed` of the three
shapes above. Sibling: launchRuntimeFleet for multi-agent
coordinated startup.

**Fails with:**

- `SpawnFailed` — the child process cannot be started (exec error, bad binary, port allocation failure, state-dir error)
- `RuntimeReadyTimedOut` — `waitUntilReady` exceeds `readyTimeoutMs`
- `RuntimeExitedBeforeReady` — the process exits before signaling ready (inspect `stderr`)

### [`WorkspaceClaudeCodeAdapterInput`](./claude-code-adapter.ts#L85)

_Interface_

```ts
export interface WorkspaceClaudeCodeAdapterInput {
  readonly server: RuntimeServerHandle;
  readonly claudeBin?: string;
  readonly channelDistDir?: string;
  readonly repoRoot?: string;
}
```

### [`WorkspaceFile`](./runtime.ts#L17)

_Interface_

```ts
export interface WorkspaceFile {
  readonly relativePath: string;
  readonly content: string;
}
```

### [`WorkspaceOpenClawAdapterInput`](./openclaw-adapter.ts#L151)

_Interface_

```ts
export interface WorkspaceOpenClawAdapterInput {
  readonly server: RuntimeServerHandle;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly repoRoot?: string;
}
```

## Files

- `await-agent-ready.ts`
- `claude-code-adapter.ts`
- `errors.ts`
- `fleet.ts`
- `nanoclaw-adapter.ts`
- `openclaw-adapter.ts`
- `runtime.ts`
