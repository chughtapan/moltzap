/**
 * Claude Code runtime adapter (issue #255).
 *
 * Mirrors `openclaw-adapter.ts`'s shape: the agent runtime binary is
 * Anthropic's `claude` CLI; the channel plugin is `@moltzap/claude-code-
 * channel`, installed into a per-agent state dir and wired in via
 * `claude --strict-mcp-config --mcp-config &lt;path>`. The cc-channel's MCP
 * stdio server connects to moltzap, the moltzap server's
 * `ConnectionManager` records the auth, and `waitUntilReady` resolves —
 * same auth-on-connection signal openclaw and nanoclaw use.
 *
 * Subprocess lifecycle is Effect-native via `@effect/platform`'s
 * `Command` API: spawn returns a `Process` whose `kill`, `exitCode`,
 * `stdout`, and `stderr` are typed Effects/Streams. We do NOT spawn with
 * `detached: true` because cc-channel runs as `claude`'s direct child
 * (claude --mcp-config spawns the MCP server itself), so a SIGTERM on
 * `claude` propagates naturally to cc-channel — no group-kill required,
 * unlike openclaw whose gateway children sit outside the openclaw bin's
 * own process tree.
 *
 * Auth gate: cc-channel needs only the moltzap api key (env-injected via
 * the MCP config). Claude Code itself authenticates against Anthropic via
 * whichever path the host has set up — `ANTHROPIC_API_KEY`, OAuth, or a
 * keychain credential. We do not pin the strategy; if auth fails the
 * subprocess exits with an error and `waitUntilReady` surfaces it as a
 * `ProcessExited` outcome.
 */
import { Command, FileSystem, Path } from "@effect/platform";
import type { Signal } from "@effect/platform/CommandExecutor";
import { NodeContext } from "@effect/platform-node";
import { Data, Effect, Exit, Fiber, Option, Scope, Stream, pipe } from "effect";

import type {
  Runtime,
  RuntimeServerHandle,
  SpawnInput,
  LogSlice,
  ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed } from "./errors.js";
import {
  processExitLoop,
  promoteTimeoutIfProcessExited,
} from "./adapter-readiness.js";
import {
  installChannelPlugin,
  resolveChannelDependency,
  seedWorkspaceFiles,
} from "./channel-plugin-install.js";
import {
  resolveClaudeCodeChannelDistDir,
  resolveWorkspaceClaudeBin,
} from "./package-resolution.js";

class WorkspaceRootNotFound extends Data.TaggedError("WorkspaceRootNotFound")<{
  readonly message: string;
}> {}
import { writeClaudeCodeMcpConfig } from "./claude-code-process.js";

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

export interface WorkspaceClaudeCodeAdapterInput {
  readonly server: RuntimeServerHandle;
  readonly claudeBin?: string;
  readonly channelDistDir?: string;
  readonly repoRoot?: string;
}

interface SpawnedProcess {
  /**
   * Long-running fiber that resolves with the exit code (or -1 if the
   * underlying `Process.exitCode` errors). Polled synchronously by
   * `waitUntilReady` and `doTeardown` via `Fiber.poll` rather than a
   * side-channel mutable.
   */
  readonly exitFiber: Fiber.RuntimeFiber<number, never>;
  readonly kill: (signal: Signal) => Effect.Effect<void, never, never>;

  /**
   * Long-lived `Scope` that carries `Command.start`'s finalizer (which
   * kills the process). The adapter closes this scope on teardown.
   */
  readonly scope: Scope.CloseableScope;
}

interface AdapterState {
  process: SpawnedProcess;
  stateDir: string;
  spawnInput: SpawnInput;
  // Mutable string buffer; the stdout/stderr fibers append to it.
  logBuffer: { value: string };
  tornDown: boolean;
}

const TERM_WAIT_MS = 10_000;
const UTF8_DECODER = new TextDecoder("utf-8");

function consumeProcessStream(
  stream: Stream.Stream<Uint8Array, unknown>,
  logBuffer: { value: string },
): Effect.Effect<void, never, never> {
  return pipe(
    stream,
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        logBuffer.value += UTF8_DECODER.decode(chunk);
      }),
    ),
    Effect.catchAll(() => Effect.void),
  );
}

function exitPollToCode(exit: Exit.Exit<number, never>): Option.Option<number> {
  return Exit.match(exit, {
    onSuccess: (code) => Option.some(code),
    onFailure: () => Option.some(-1),
  });
}

function pollExitCode(
  proc: SpawnedProcess,
): Effect.Effect<Option.Option<number>, never, never> {
  return Fiber.poll(proc.exitFiber).pipe(
    Effect.map(
      Option.match({
        onNone: () => Option.none<number>(),
        onSome: exitPollToCode,
      }),
    ),
  );
}

function killAndPoll(
  proc: SpawnedProcess,
  signal: Signal,
  timeoutMs: number,
): Effect.Effect<Option.Option<number>, never, never> {
  return proc.kill(signal).pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.catchAll(() => Effect.void),
    Effect.zipRight(pollExitCode(proc)),
  );
}

function waitAfterSigterm(
  proc: SpawnedProcess,
): Effect.Effect<number, never, never> {
  return killAndPoll(proc, "SIGTERM", TERM_WAIT_MS).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          killAndPoll(proc, "SIGKILL", TERM_WAIT_MS).pipe(
            Effect.map(Option.getOrElse(() => -1)),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
}

/**
 * Spawn `claude` via `@effect/platform`'s Command, layering the Node
 * platform context so PlatformError fans out to never. The returned
 * `SpawnedProcess` exposes the exit fiber for callers that need to
 * `Fiber.poll` synchronously inside an `Effect.gen` polling loop.
 */
function spawnClaudeProcess(opts: {
  readonly claudeBin: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly logBuffer: { value: string };
}): Effect.Effect<SpawnedProcess, Error, never> {
  const command = pipe(
    Command.make(opts.claudeBin, ...opts.args),
    Command.workingDirectory(opts.cwd),
    Command.env(opts.env),
    Command.stdin("inherit"),
  );

  return Effect.gen(function* () {
    // `Command.start` allocates the child and yields a `Process`, plus
    // registers a finalizer in the current scope that kills the process.
    // We allocate our own long-lived `Scope` and extend the start-effect
    // into it so the process outlives the spawn-effect — the adapter
    // closes the scope on teardown, which runs the kill finalizer.
    const scope = yield* Scope.make();
    const proc = yield* Command.start(command).pipe(Scope.extend(scope));

    // PlatformError on the exit channel collapses to "treat as exit -1
    // with reason in logs"; the adapter consumes a plain number.
    // `Effect.forkIn(scope)` (NOT `Effect.fork`) ties the observer's
    // lifetime to the process scope rather than this gen's scope —
    // otherwise the fiber gets interrupted the moment spawn returns and
    // every later `Fiber.poll` reports the interrupt as exit.
    const exitFiber = yield* proc.exitCode.pipe(
      Effect.catchAll(() => Effect.succeed(-1)),
      Effect.forkIn(scope),
    );

    // Stream consumers also live in the process scope so they keep
    // appending logs until the subprocess closes its stdout/stderr.
    yield* consumeProcessStream(proc.stdout, opts.logBuffer).pipe(
      Effect.forkIn(scope),
    );
    yield* consumeProcessStream(proc.stderr, opts.logBuffer).pipe(
      Effect.forkIn(scope),
    );

    const kill = (signal: Signal): Effect.Effect<void, never, never> =>
      pipe(
        proc.kill(signal),
        Effect.catchAll(() => Effect.void),
      );

    return {
      exitFiber,
      kill,
      scope,
    } satisfies SpawnedProcess;
  }).pipe(
    Effect.provide(NodeContext.layer),
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
  );
}

function prepareClaudeCodeStateDir(
  deps: ClaudeCodeAdapterDeps,
  input: SpawnInput,
): Effect.Effect<
  { readonly stateDir: string; readonly extDir: string },
  unknown,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = yield* fileSystem.makeTempDirectory({
      prefix: `claude-code-${input.agentName}-`,
    });
    yield* seedWorkspaceFiles(stateDir, input.workspaceFiles);
    const extDir = yield* installClaudeCodeChannelPlugin(deps, stateDir);
    return { stateDir, extDir };
  });
}

function installClaudeCodeChannelPlugin(
  deps: ClaudeCodeAdapterDeps,
  stateDir: string,
): Effect.Effect<string, unknown, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const channelPackageDir = path.dirname(deps.channelDistDir);
    const mcpSdkResolved = yield* resolveChannelDependency(
      channelPackageDir,
      "@modelcontextprotocol/sdk",
    );
    const effectResolved = yield* resolveChannelDependency(
      channelPackageDir,
      "effect",
    );
    return yield* installChannelPlugin({
      stateDir,
      channelDistDir: deps.channelDistDir,
      repoRoot: deps.repoRoot,
      extName: "claude-code-channel",
      extraSymlinks: claudeCodeExtraSymlinks({
        path,
        deps,
        channelPackageDir,
        mcpSdkResolved,
        effectResolved,
      }),
    });
  });
}

function claudeCodeExtraSymlinks(input: {
  readonly path: Path.Path;
  readonly deps: ClaudeCodeAdapterDeps;
  readonly channelPackageDir: string;
  readonly mcpSdkResolved: string | null;
  readonly effectResolved: string | null;
}) {
  return [
    {
      linkPath: "@modelcontextprotocol/sdk",
      candidates: [
        ...(input.mcpSdkResolved === null ? [] : [input.mcpSdkResolved]),
        input.path.join(
          input.channelPackageDir,
          "node_modules/@modelcontextprotocol/sdk",
        ),
        input.path.join(
          input.deps.repoRoot,
          "node_modules/@modelcontextprotocol/sdk",
        ),
      ],
    },
    {
      linkPath: "effect",
      candidates: [
        ...(input.effectResolved === null ? [] : [input.effectResolved]),
        input.path.join(input.channelPackageDir, "node_modules/effect"),
        input.path.join(input.deps.repoRoot, "node_modules/effect"),
      ],
    },
  ];
}

// `--strict-mcp-config` ensures only adapter-provided MCP servers load.
// `--print --input-format stream-json --output-format stream-json` is the
// long-running streaming mode the agent SDK uses; without it, `claude` either
// drops into interactive (TTY-bound) or one-shots and exits.
// `--dangerously-skip-permissions` is needed because `claude` in `--print`
// mode otherwise blocks on permission prompts with no TTY to answer them.
// We omit `--bare`: bare-mode auth is strictly ANTHROPIC_API_KEY and skips
// OAuth/keychain. Host OAuth setup should keep working for runtime spawn.
function buildClaudeArgs(
  path: Path.Path,
  stateDir: string,
  mcpConfigPath: string,
): ReadonlyArray<string> {
  return [
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--add-dir",
    path.join(stateDir, "workspace"),
  ];
}

function spawnConfiguredClaude(input: {
  readonly deps: ClaudeCodeAdapterDeps;
  readonly stateDir: string;
  readonly mcpConfigPath: string;
  readonly logBuffer: { value: string };
}): Effect.Effect<SpawnedProcess, Error, Path.Path> {
  return Path.Path.pipe(
    Effect.flatMap((path) =>
      spawnClaudeProcess({
        claudeBin: input.deps.claudeBin,
        args: buildClaudeArgs(path, input.stateDir, input.mcpConfigPath),
        cwd: input.stateDir,
        env: { CLAUDE_CODE_HOME: input.stateDir },
        logBuffer: input.logBuffer,
      }),
    ),
  );
}

function exitToCode(exit: Exit.Exit<number, never>): number {
  return Exit.match(exit, {
    onSuccess: (code) => code,
    onFailure: () => -1,
  });
}

function pollClaudeExitCode(
  proc: SpawnedProcess,
): Effect.Effect<Option.Option<number>, never, never> {
  return Fiber.poll(proc.exitFiber).pipe(Effect.map(Option.map(exitToCode)));
}

/**
 * Claude Code runtime adapter. Spawns the `claude` CLI as the host
 * process with the moltzap channel installed as a stdio MCP server.
 *
 * ```mermaid
 * flowchart TD
 *   CCS["ClaudeCodeAdapter.spawn(input)"]
 *   CC1["1. prepareClaudeCodeStateDir&lt;br>makeTempDirectory, seedWorkspaceFiles,&lt;br>installClaudeCodeChannelPlugin&lt;br>(resolves modelcontextprotocol/sdk + effect)"]
 *   CC2["2. writeClaudeCodeMcpConfig&lt;br>{ mcpServers: { moltzap: { command: 'node', args: [extDir/dist/cli.js], env: { MOLTZAP_API_KEY, MOLTZAP_SERVER_URL, MOLTZAP_SERVER_NAME } } } }"]
 *   CC3["3. spawnConfiguredClaude&lt;br>buildClaudeArgs:&lt;br>--strict-mcp-config --mcp-config&lt;br>--print --input-format stream-json&lt;br>--output-format stream-json --verbose&lt;br>--dangerously-skip-permissions&lt;br>--add-dir stateDir/workspace&lt;br>env: CLAUDE_CODE_HOME=stateDir"]
 *   CC4["4. state = { process, stateDir, logBuffer, ... }"]
 *   CCR["waitUntilReady&lt;br>race(server.awaitAgentReady, processExitLoop)&lt;br>(cc-channel MCP stdio server authenticates on start)"]
 *   CCS --> CC1 --> CC2 --> CC3 --> CC4 --> CCR
 * ```
 *
 * Inbound marker: `notifications/claude/channel`. The cc-channel
 * sends MCP `notifications/claude/channel` per inbound message; this
 * is visible in claude's `--verbose` stream-json output. Shutdown
 * via SIGTERM on the claude process propagates to the MCP stdio
 * child naturally — no process-group kill needed (unlike OpenClaw).
 */
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

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    if (!this.state) {
      return Effect.succeed({ _tag: "Ready" as const });
    }
    const { process: proc, spawnInput, logBuffer } = this.state;
    const agentId = spawnInput.agentId;

    // The server side of readiness — Ready when ConnectionManager records
    // an authenticated connection, Timeout if it never does. Pluggable per
    // server-handle implementation (in-process polling vs. out-of-process
    // WS-presence subscription).
    const serverReady = this.deps.server.awaitAgentReady(agentId, timeoutMs);
    const processExit = {
      pollExitCode: () => pollClaudeExitCode(proc),
      stderr: () => logBuffer.value,
      timeoutMs,
    };

    return pipe(
      Effect.race(serverReady, processExitLoop(processExit)),
      // Final-check: if the race resolved `Timeout`, the process may have
      // exited within the last `exitLoop` tick window — give the adapter one
      // last sync poll so a near-deadline exit still surfaces with stderr
      // instead of an opaque `Timeout`.
      Effect.flatMap((outcome) =>
        promoteTimeoutIfProcessExited(outcome, processExit),
      ),
      // Failure outcomes (Timeout, ProcessExited) tear down before returning
      // — keeps the Runtime contract that the adapter cleans up after itself.
      Effect.tap((outcome) =>
        outcome._tag === "Ready" ? Effect.void : this.doTeardown(),
      ),
    );
  }

  teardown(): Effect.Effect<void, never, never> {
    return Effect.suspend(() => this.doTeardown());
  }

  getLogs(offset: number): LogSlice {
    if (!this.state) return { text: "", nextOffset: 0 };
    const full = this.state.logBuffer.value;
    return { text: full.slice(offset), nextOffset: full.length };
  }

  getInboundMarker(): string {
    // The cc-channel pushes an MCP `notifications/claude/channel` to claude
    // for every inbound; that method name appears in `--verbose` stream-json
    // output. Used by trace-capture as a coarse "did inbound reach the
    // agent" signal.
    return "notifications/claude/channel";
  }

  private doTeardown(): Effect.Effect<void, never, never> {
    if (!this.state || this.state.tornDown) return Effect.void;
    this.state.tornDown = true;
    const { process: proc, stateDir } = this.state;

    const removeStateDir = FileSystem.FileSystem.pipe(
      Effect.flatMap((fileSystem) =>
        fileSystem.remove(stateDir, { recursive: true, force: true }),
      ),
      Effect.provide(NodeContext.layer),
      Effect.catchAll((cause) =>
        Effect.logWarning(
          "failed to remove claude-code adapter state dir",
          cause,
        ),
      ),
    );

    // SIGTERM with a timeout; escalate to SIGKILL if SIGTERM doesn't
    // reap. Closing `proc.scope` afterward runs Command.start's kill
    // finalizer + the stream-consumer fiber finalizers.
    const killAndWait = pipe(
      pollExitCode(proc),
      Effect.flatMap((exitOpt) =>
        Option.isSome(exitOpt)
          ? Effect.void
          : waitAfterSigterm(proc).pipe(Effect.asVoid),
      ),
    );

    return pipe(
      killAndWait,
      Effect.zipRight(Scope.close(proc.scope, Exit.succeed(undefined))),
      Effect.zipRight(removeStateDir),
    );
  }
}

/**
 * Workspace-aware factory mirroring
 * {@link createWorkspaceOpenClawAdapter}. Resolves `claudeBin` and
 * `channelDistDir` from the monorepo at construction time.
 *
 * ```mermaid
 * flowchart TD
 *   CCWF["createWorkspaceClaudeCodeAdapter(input)"]
 *   CCBIN["claudeBin = input.claudeBin ??&lt;br>resolveWorkspaceClaudeBin&lt;br>(resolveWorkspaceBin binName='claude', packageName='@anthropic-ai/claude-code')"]
 *   CCROOT["resolveClaudeCodePackageRoot&lt;br>(requireFromHere.resolve('@anthropic-ai/claude-code/package.json'))"]
 *   CCCH["channelDistDir = input.channelDistDir ??&lt;br>resolveClaudeCodeChannelDistDir"]
 *   CCCHTRY["Try: requireFromHere.resolve('@moltzap/claude-code-channel') → dirname/dist"]
 *   CCCHFALL["Fallback: repoRoot/packages/claude-code-channel/dist (logs warning)"]
 *   CCWF --> CCBIN --> CCROOT --> CCCH
 *   CCCH --> CCCHTRY
 *   CCCH --> CCCHFALL
 * ```
 */
export function createWorkspaceClaudeCodeAdapter(
  input: WorkspaceClaudeCodeAdapterInput,
): ClaudeCodeAdapter {
  const packageRoot = resolveWorkspacePackageRoot();
  const repoRoot =
    input.repoRoot ??
    pathSync((path) => path.dirname(path.dirname(packageRoot)));
  return new ClaudeCodeAdapter({
    server: input.server,
    claudeBin:
      input.claudeBin ??
      resolveWorkspaceClaudeBin({
        repoRoot,
        workspacePackageRoot: packageRoot,
      }),
    channelDistDir:
      input.channelDistDir ?? resolveClaudeCodeChannelDistDir(repoRoot),
    repoRoot,
  });
}

// --- Module-private helpers ---

function resolveWorkspacePackageRoot(): string {
  return pathEffectSync(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const here = yield* path.fromFileUrl(new URL(import.meta.url));
      let current = path.dirname(here);
      while (current !== path.parse(current).root) {
        if (path.basename(current) === "packages") {
          return path.join(current, "runtimes");
        }
        current = path.dirname(current);
      }
      return yield* Effect.fail(
        new WorkspaceRootNotFound({
          message: "Unable to resolve packages/runtimes workspace root",
        }),
      );
    }),
  );
}

function pathSync<A>(f: (path: Path.Path) => A): A {
  return Effect.runSync(
    Path.Path.pipe(Effect.map(f), Effect.provide(Path.layer)),
  );
}

function pathEffectSync<A>(effect: Effect.Effect<A, unknown, Path.Path>): A {
  return Effect.runSync(effect.pipe(Effect.provide(Path.layer), Effect.orDie));
}
