/**
 * Claude Code runtime adapter (issue #255).
 *
 * Mirrors `openclaw-adapter.ts`'s shape: the agent runtime binary is
 * Anthropic's `claude` CLI; the channel plugin is `@moltzap/claude-code-
 * channel`, installed into a per-agent state dir and wired in via
 * `claude --strict-mcp-config --mcp-config <path>`. The cc-channel's MCP
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
import { Command } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit, Fiber, Option, Scope, Stream, pipe } from "effect";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Runtime,
  RuntimeServerHandle,
  SpawnInput,
  LogSlice,
  ReadyOutcome,
} from "./runtime.js";
import { SpawnFailed } from "./errors.js";
import {
  installChannelPlugin,
  seedWorkspaceFiles,
} from "./channel-plugin-install.js";
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
  readonly kill: (signal: NodeJS.Signals) => Effect.Effect<void, never, never>;
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

/**
 * Spawn `claude` via @effect/platform's Command, layering the Node
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

    const consumeStream = (
      stream: Stream.Stream<Uint8Array, unknown>,
    ): Effect.Effect<void, never, never> =>
      pipe(
        stream,
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            opts.logBuffer.value += Buffer.from(chunk).toString("utf8");
          }),
        ),
        Effect.catchAll(() => Effect.void),
      );

    // Stream consumers also live in the process scope so they keep
    // appending logs until the subprocess closes its stdout/stderr.
    yield* consumeStream(proc.stdout).pipe(Effect.forkIn(scope));
    yield* consumeStream(proc.stderr).pipe(Effect.forkIn(scope));

    const kill = (signal: NodeJS.Signals): Effect.Effect<void, never, never> =>
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

/**
 * `Fiber.poll` returns `Effect<Option<Exit<A, E>>>` — None while running,
 * Some(Exit) once resolved. We project to `Option<number>` so callers
 * stay in plain-number land (matching the underlying exit-code surface).
 */
function pollExitCode(
  fiber: Fiber.RuntimeFiber<number, never>,
): Effect.Effect<Option.Option<number>, never, never> {
  return pipe(
    Fiber.poll(fiber),
    Effect.map(
      Option.match({
        onNone: () => Option.none<number>(),
        onSome: (exit: Exit.Exit<number, never>): Option.Option<number> =>
          Exit.match(exit, {
            onSuccess: (code) => Option.some(code),
            // Defects (incl. fiber interrupt on scope close) collapse to
            // -1 — same shape `proc.exitCode.pipe(catchAll → -1)` produces
            // for PlatformError, so callers see one consistent number.
            onFailure: () => Option.some(-1),
          }),
      }),
    ),
  );
}

export class ClaudeCodeAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: ClaudeCodeAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    // Wrap each fs/spawn step in an `Effect.try` that maps the cause to
    // `SpawnFailed(agentName, ...)`. Hoisted to a single helper so the
    // four sequential steps don't repeat the same boilerplate (issue
    // #272 item 4).
    const tryStep = <A>(fn: () => A): Effect.Effect<A, SpawnFailed, never> =>
      Effect.try({
        try: fn,
        catch: (cause) =>
          new SpawnFailed(
            input.agentName,
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
      });

    return Effect.gen(this, function* () {
      const stateDir = yield* tryStep(() =>
        fs.mkdtempSync(
          path.join(os.tmpdir(), `claude-code-${input.agentName}-`),
        ),
      );

      yield* tryStep(() => seedWorkspaceFiles(stateDir, input.workspaceFiles));

      const extDir = yield* tryStep(() =>
        installChannelPlugin({
          stateDir,
          channelDistDir: this.deps.channelDistDir,
          repoRoot: this.deps.repoRoot,
          extName: "claude-code-channel",
          // cc-channel resolves @modelcontextprotocol/sdk + effect at
          // MCP-load time; symlink them into the per-agent ext dir.
          extraSymlinks: [
            {
              linkPath: "@modelcontextprotocol/sdk",
              candidates: [
                path.join(
                  this.deps.channelDistDir,
                  "../node_modules/@modelcontextprotocol/sdk",
                ),
                path.join(
                  this.deps.repoRoot,
                  "node_modules/@modelcontextprotocol/sdk",
                ),
              ],
            },
            {
              linkPath: "effect",
              candidates: [
                path.join(this.deps.channelDistDir, "../node_modules/effect"),
                path.join(this.deps.repoRoot, "node_modules/effect"),
              ],
            },
          ],
        }),
      );

      const mcpConfigPath = yield* tryStep(() =>
        writeClaudeCodeMcpConfig({
          stateDir,
          extDir,
          serverUrl: input.serverUrl,
          apiKey: input.apiKey,
          agentName: input.agentName,
        }),
      );

      // `--strict-mcp-config` ensures only adapter-provided MCP servers
      // load (no leakage from host claude config).
      // `--print --input-format stream-json --output-format stream-json`
      // is the long-running streaming mode the agent SDK uses; without
      // it, `claude` either drops into interactive (TTY-bound) or
      // one-shots and exits.
      // `--dangerously-skip-permissions` is needed because `claude` in
      // `--print` mode otherwise blocks on permission prompts the moment
      // a tool is invoked, and there is no TTY to answer them. Long-term
      // a per-session permission-mode = "bypassPermissions" via
      // `--permission-mode` would be tighter, but the sandbox boundary
      // is the per-agent state dir + MoltZap auth, so the looser flag is
      // acceptable here.
      // We omit `--bare`: bare-mode auth is strictly ANTHROPIC_API_KEY
      // and skips OAuth/keychain. Host environments where the user has
      // logged into `claude` (OAuth) should not be forced to set an API
      // key just for a runtime spawn. `--strict-mcp-config` is the only
      // isolation we need for the channel; CLAUDE.md / hooks remain
      // host-controlled.
      const claudeArgs: ReadonlyArray<string> = [
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

      const logBuffer = { value: "" };

      const child = yield* spawnClaudeProcess({
        claudeBin: this.deps.claudeBin,
        args: claudeArgs,
        cwd: stateDir,
        // `process.env` values are `string | undefined`; filter to
        // string-only to satisfy `Command.env`'s `Record<string, string>`
        // contract without a wholesale `as` cast (issue #272 item 7).
        env: filterDefinedEnv(globalThis.process.env, {
          CLAUDE_CODE_HOME: stateDir,
        }),
        logBuffer,
      }).pipe(
        Effect.mapError((cause) => new SpawnFailed(input.agentName, cause)),
      );

      this.state = {
        process: child,
        stateDir,
        spawnInput: input,
        logBuffer,
        tornDown: false,
      };
    });
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

    // The adapter side of readiness — only resolves on `ProcessExited`.
    // Effect.race interrupts whichever branch loses, so as long as one
    // side resolves the other gets cancelled cleanly.
    const exitTick: Effect.Effect<ReadyOutcome | null, never, never> =
      Effect.gen(function* () {
        const exitOpt = yield* pollExitCode(proc.exitFiber);
        if (Option.isSome(exitOpt)) {
          return {
            _tag: "ProcessExited" as const,
            exitCode: exitOpt.value,
            stderr: logBuffer.value,
          };
        }
        return null;
      });
    const exitLoop: Effect.Effect<ReadyOutcome, never, never> = pipe(
      Effect.iterate(null as ReadyOutcome | null, {
        while: (s) => s === null,
        body: () => Effect.sleep("250 millis").pipe(Effect.zipRight(exitTick)),
      }),
      // The `?? Timeout` fallback is unreachable (iterate exits only on
      // non-null), but TypeScript narrows away the `null` branch and gives
      // us a uniform `ReadyOutcome` for the race.
      Effect.map(
        (s): ReadyOutcome => s ?? { _tag: "Timeout" as const, timeoutMs },
      ),
    );

    return pipe(
      Effect.race(serverReady, exitLoop),
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

    const removeStateDir = Effect.sync(() => {
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
        // #ignore-sloppy-code-next-line[bare-catch]: teardown cleanup — nothing actionable on rm failure
      } catch (_err) {
        void _err;
      }
    });

    // SIGTERM with a timeout; escalate to SIGKILL if SIGTERM doesn't
    // reap. Closing `proc.scope` afterward runs Command.start's kill
    // finalizer + the stream-consumer fiber finalizers.
    const exitCodeEffect = Fiber.join(proc.exitFiber);
    const killAndWait = pipe(
      pollExitCode(proc.exitFiber),
      Effect.flatMap((exitOpt) =>
        Option.isSome(exitOpt)
          ? Effect.void
          : pipe(
              proc.kill("SIGTERM"),
              Effect.flatMap(() =>
                exitCodeEffect.pipe(
                  Effect.timeout(`${TERM_WAIT_MS} millis`),
                  Effect.catchAll(() =>
                    pipe(
                      proc.kill("SIGKILL"),
                      Effect.flatMap(() => exitCodeEffect),
                    ),
                  ),
                ),
              ),
              Effect.asVoid,
            ),
      ),
    );

    return pipe(
      killAndWait,
      Effect.zipRight(Scope.close(proc.scope, Exit.succeed(undefined))),
      Effect.zipRight(removeStateDir),
    );
  }
}

export function createWorkspaceClaudeCodeAdapter(
  input: WorkspaceClaudeCodeAdapterInput,
): ClaudeCodeAdapter {
  const packageRoot = resolveWorkspacePackageRoot();
  const repoRoot = input.repoRoot ?? path.dirname(path.dirname(packageRoot));
  return new ClaudeCodeAdapter({
    server: input.server,
    claudeBin:
      input.claudeBin ?? resolveWorkspaceClaudeBin(packageRoot, repoRoot),
    channelDistDir:
      input.channelDistDir ??
      path.join(repoRoot, "packages/claude-code-channel/dist"),
    repoRoot,
  });
}

// --- Module-private helpers ---

function resolveWorkspacePackageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.parse(current).root) {
    if (path.basename(current) === "packages") {
      return path.join(current, "runtimes");
    }
    current = path.dirname(current);
  }
  throw new Error("Unable to resolve packages/runtimes workspace root");
}

function resolveWorkspaceClaudeBin(
  packageRoot: string,
  repoRoot: string,
): string {
  const packageBin = path.join(packageRoot, "node_modules/.bin/claude");
  if (fs.existsSync(packageBin)) {
    return packageBin;
  }
  return path.join(repoRoot, "node_modules/.bin/claude");
}

/**
 * Project `process.env` (`Record<string, string | undefined>`) onto a
 * strict `Record<string, string>` so it slots into `Command.env` without
 * a wholesale `as` cast (issue #272 item 7). Also folds in adapter-set
 * extras (`CLAUDE_CODE_HOME` etc.) on top.
 */
function filterDefinedEnv(
  source: NodeJS.ProcessEnv,
  extras: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extras)) {
    out[key] = value;
  }
  return out;
}
