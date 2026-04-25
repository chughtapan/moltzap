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
import { Effect, Exit, Scope, Stream, pipe } from "effect";
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
  writeClaudeCodeMcpConfig,
} from "./claude-code-process.js";

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
  readonly exitCode: Effect.Effect<number, never, never>;
  readonly kill: (signal: NodeJS.Signals) => Effect.Effect<void, never, never>;
  readonly isExited: () => boolean;
  readonly currentExitCode: () => number | null;
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
 * platform context so PlatformError fans out to never. Returns a
 * `SpawnedProcess` with synchronous helpers (`isExited`,
 * `currentExitCode`) in addition to the Effect-native ones — the
 * adapter's `waitUntilReady` is an `Effect.iterate` polling loop that
 * only needs a sync probe per tick, so we keep a sync mirror of the
 * exit code populated by a forked observer fiber.
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

    let resolvedExit: number | null = null;
    const exitObserver = pipe(
      proc.exitCode,
      Effect.tap((code) =>
        Effect.sync(() => {
          resolvedExit = code;
        }),
      ),
      // PlatformError on the exit channel collapses to "treat as exit -1
      // with reason in logs"; the adapter only consumes a number.
      Effect.catchAll(() =>
        Effect.sync(() => {
          resolvedExit = -1;
          return -1;
        }),
      ),
    );
    const exitFiber = yield* Effect.fork(exitObserver);
    const exitCodeEffect = pipe(
      exitFiber,
      (fiber) => fiber.await,
      Effect.map((exit) => (exit._tag === "Success" ? exit.value : -1)),
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

    yield* Effect.fork(consumeStream(proc.stdout));
    yield* Effect.fork(consumeStream(proc.stderr));

    const kill = (signal: NodeJS.Signals): Effect.Effect<void, never, never> =>
      pipe(
        proc.kill(signal),
        Effect.catchAll(() => Effect.void),
      );

    return {
      exitCode: exitCodeEffect,
      kill,
      isExited: () => resolvedExit !== null,
      currentExitCode: () => resolvedExit,
      scope,
    } satisfies SpawnedProcess;
  }).pipe(
    Effect.provide(NodeContext.layer),
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
  );
}

export class ClaudeCodeAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: ClaudeCodeAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    return Effect.gen(this, function* () {
      const stateDir = yield* Effect.try({
        try: () =>
          fs.mkdtempSync(
            path.join(os.tmpdir(), `claude-code-${input.agentName}-`),
          ),
        catch: (cause) =>
          new SpawnFailed(
            input.agentName,
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
      });

      yield* Effect.try({
        try: () => {
          seedWorkspaceFiles(stateDir, input.workspaceFiles);
        },
        catch: (cause) =>
          new SpawnFailed(
            input.agentName,
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
      });

      const extDir = yield* Effect.try({
        try: () =>
          installChannelPlugin(
            stateDir,
            this.deps.channelDistDir,
            this.deps.repoRoot,
          ),
        catch: (cause) =>
          new SpawnFailed(
            input.agentName,
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
      });

      const mcpConfigPath = yield* Effect.try({
        try: () =>
          writeClaudeCodeMcpConfig({
            stateDir,
            extDir,
            serverUrl: input.serverUrl,
            apiKey: input.apiKey,
            agentName: input.agentName,
          }),
        catch: (cause) =>
          new SpawnFailed(
            input.agentName,
            cause instanceof Error ? cause : new Error(String(cause)),
          ),
      });

      // `--strict-mcp-config` ensures only adapter-provided MCP servers
      // load (no leakage from host claude config).
      // `--print --input-format stream-json --output-format stream-json`
      // is the long-running streaming mode the agent SDK uses; without
      // it, `claude` either drops into interactive (TTY-bound) or
      // one-shots and exits.
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
        env: {
          ...(globalThis.process.env as Record<string, string>),
          CLAUDE_CODE_HOME: stateDir,
        },
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

    // One synchronous probe: returns a `ReadyOutcome` once the agent is
    // authenticated or the subprocess has exited; returns `null` to signal
    // "keep polling." `Effect.repeat` with `Schedule.spaced(500ms)` and a
    // `while` predicate replaces the prior `setTimeout` recursion.
    const tick: Effect.Effect<ReadyOutcome | null, never, never> = Effect.sync(
      () => {
        const exitCode = proc.currentExitCode();
        if (exitCode !== null) {
          return {
            _tag: "ProcessExited" as const,
            exitCode,
            stderr: logBuffer.value,
          };
        }
        const connections = this.deps.server.connections.getByAgent(agentId);
        if (connections.length > 0 && connections[0]!.auth !== null) {
          return { _tag: "Ready" as const };
        }
        return null;
      },
    );

    // Probe once, then iterate-with-sleep until probe yields a non-null
    // outcome. `Effect.iterate` is the Effect-native equivalent of a
    // `while (state === null) { sleep; state = probe(); }` loop and
    // returns the final state.
    const pollLoop = pipe(
      tick,
      Effect.flatMap((initial) =>
        Effect.iterate(initial, {
          while: (state) => state === null,
          body: () => Effect.sleep("500 millis").pipe(Effect.zipRight(tick)),
        }),
      ),
    );

    return pipe(
      pollLoop,
      // Timeout fans the never-ready case into a `Timeout` outcome and
      // hands the rest of the pipeline a uniform `ReadyOutcome` value.
      Effect.timeoutTo({
        duration: `${timeoutMs} millis`,
        onSuccess: (outcome): ReadyOutcome =>
          outcome ?? { _tag: "Ready" as const },
        onTimeout: (): ReadyOutcome => ({
          _tag: "Timeout" as const,
          timeoutMs,
        }),
      }),
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
    const killAndWait = proc.isExited()
      ? Effect.void
      : pipe(
          proc.kill("SIGTERM"),
          Effect.flatMap(() =>
            proc.exitCode.pipe(
              Effect.timeout(`${TERM_WAIT_MS} millis`),
              Effect.catchAll(() =>
                pipe(
                  proc.kill("SIGKILL"),
                  Effect.flatMap(() => proc.exitCode),
                ),
              ),
            ),
          ),
          Effect.asVoid,
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
