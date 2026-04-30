import { Effect } from "effect";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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

const OPENCLAW_TERM_WAIT_MS = 10_000;
const OPENCLAW_KILL_WAIT_MS = 5_000;
const PROCESS_GROUP_POLL_INTERVAL_MS = 100;
const DEFAULT_OPENCLAW_MODEL_ID = "openai-codex/gpt-5.4";

export interface OpenClawAdapterDeps {
  readonly server: RuntimeServerHandle;
  readonly openclawBin: string;
  readonly channelDistDir: string;
  readonly repoRoot: string;
}

export interface WorkspaceOpenClawAdapterInput {
  readonly server: RuntimeServerHandle;
  readonly openclawBin?: string;
  readonly channelDistDir?: string;
  readonly repoRoot?: string;
}

interface AdapterState {
  child: ChildProcess;
  stateDir: string;
  logBuffer: string;
  spawnInput: SpawnInput;
  tornDown: boolean;
}

export class OpenClawAdapter implements Runtime {
  private state: AdapterState | null = null;

  constructor(private readonly deps: OpenClawAdapterDeps) {}

  spawn(input: SpawnInput): Effect.Effect<void, SpawnFailed, never> {
    return Effect.tryPromise({
      // #ignore-sloppy-code-next-line[async-keyword]: port allocation requires a Promise — deferred step before nodeSpawn
      try: async () => {
        const port = await allocateFreePort();
        const stateDir = fs.mkdtempSync(
          path.join(os.tmpdir(), `openclaw-${input.agentName}-`),
        );

        writeOpenClawConfig({
          stateDir,
          serverUrl: input.serverUrl,
          apiKey: input.apiKey,
          agentName: input.agentName,
          modelId: input.modelId,
        });
        seedWorkspaceFiles(stateDir, input.workspaceFiles);

        installChannelPlugin(
          stateDir,
          this.deps.channelDistDir,
          this.deps.repoRoot,
        );

        const openclawArgs = [
          "gateway",
          "run",
          "--allow-unconfigured",
          "--port",
          String(port),
        ];
        const [command, args] = this.deps.openclawBin.endsWith(".mjs")
          ? ["node", [this.deps.openclawBin, ...openclawArgs]]
          : [this.deps.openclawBin, openclawArgs];

        const child = nodeSpawn(command, args, {
          cwd: stateDir,
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          },
          stdio: ["ignore", "pipe", "pipe"],
          // detached:true makes the child the leader of its own process group.
          // This lets teardown kill the entire group via process.kill(-pid, signal).
          detached: true,
        });

        const st: AdapterState = {
          child,
          stateDir,
          logBuffer: "",
          spawnInput: input,
          tornDown: false,
        };

        const onChunk = (chunk: Buffer) => {
          st.logBuffer += chunk.toString();
        };
        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);

        this.state = st;
      },
      catch: (cause) =>
        new SpawnFailed(
          input.agentName,
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
    });
  }

  waitUntilReady(timeoutMs: number): Effect.Effect<ReadyOutcome, never, never> {
    return Effect.async<ReadyOutcome, never, never>((resume) => {
      if (!this.state) {
        resume(Effect.succeed({ _tag: "Ready" as const }));
        return;
      }

      const deadline = Date.now() + timeoutMs;
      const { child, spawnInput } = this.state;
      const agentId = spawnInput.agentId;

      const check = () => {
        if (child.exitCode !== null) {
          const stderr = this.state?.logBuffer ?? "";
          // #ignore-sloppy-code-next-line[promise-type]: fire-and-forget cleanup — resume callback cannot await
          void this.doTeardown();
          resume(
            Effect.succeed({
              _tag: "ProcessExited" as const,
              exitCode: child.exitCode,
              stderr,
            }),
          );
          return;
        }

        const connections = this.deps.server.connections.getByAgent(agentId);
        if (connections.length > 0 && connections[0]!.auth !== null) {
          resume(Effect.succeed({ _tag: "Ready" as const }));
          return;
        }

        if (Date.now() > deadline) {
          // #ignore-sloppy-code-next-line[promise-type]: fire-and-forget cleanup — resume callback cannot await
          void this.doTeardown();
          resume(Effect.succeed({ _tag: "Timeout" as const, timeoutMs }));
          return;
        }

        setTimeout(check, 500);
      };

      check();
    });
  }

  teardown(): Effect.Effect<void, never, never> {
    // #ignore-sloppy-code-next-line[effect-promise, promise-type]: doTeardown is internally guarded — torn-down flag prevents double-run, errors are swallowed by design
    return Effect.promise(() => this.doTeardown());
  }

  getLogs(offset: number): LogSlice {
    if (!this.state) return { text: "", nextOffset: 0 };
    const text = this.state.logBuffer.slice(offset);
    return { text, nextOffset: this.state.logBuffer.length };
  }

  getInboundMarker(): string {
    return "inbound from agent:";
  }

  /** Async teardown: SIGTERM → await group exit (≤10s) → SIGKILL → rm workdir. */
  // #ignore-sloppy-code-next-line[async-keyword, promise-type]: child_process exit event + fs.rm boundary
  private async doTeardown(): Promise<void> {
    if (!this.state || this.state.tornDown) return;
    this.state.tornDown = true;

    const { child, stateDir } = this.state;
    const groupId = child.pid ?? null;

    if (groupId !== null) {
      this.killGroup(groupId, "SIGTERM");
      const exitedAfterTerm = await Effect.runPromise(
        this.waitForProcessGroupExit(groupId, OPENCLAW_TERM_WAIT_MS),
      );
      if (!exitedAfterTerm) {
        this.killGroup(groupId, "SIGKILL");
        await Effect.runPromise(
          this.waitForProcessGroupExit(groupId, OPENCLAW_KILL_WAIT_MS),
        );
      }
    }

    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
      // #ignore-sloppy-code-next-line[bare-catch]: teardown cleanup — nothing to do if rmSync fails
    } catch (_err) {
      void _err;
    }
  }

  private waitForProcessGroupExit(
    groupId: number,
    timeoutMs: number,
  ): Effect.Effect<boolean, never, never> {
    const deadline = Date.now() + timeoutMs;
    const poll = (): Effect.Effect<boolean, never, never> =>
      Effect.sync(() => this.isProcessGroupAlive(groupId)).pipe(
        Effect.flatMap((alive) => {
          if (!alive) {
            return Effect.succeed(true);
          }
          if (Date.now() >= deadline) {
            return Effect.succeed(false);
          }
          return Effect.sleep(`${PROCESS_GROUP_POLL_INTERVAL_MS} millis`).pipe(
            Effect.flatMap(() => poll()),
          );
        }),
      );
    return poll();
  }

  private isProcessGroupAlive(groupId: number): boolean {
    try {
      process.kill(-groupId, 0);
      return true;
    } catch (error) {
      return !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      );
    }
  }

  private killGroup(groupId: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-groupId, signal);
      // #ignore-sloppy-code-next-line[bare-catch]: ESRCH — process already dead
    } catch (_err) {
      void _err;
    }
  }
}

export function createWorkspaceOpenClawAdapter(
  input: WorkspaceOpenClawAdapterInput,
): OpenClawAdapter {
  const packageRoot = resolveWorkspacePackageRoot();
  const repoRoot = input.repoRoot ?? path.dirname(path.dirname(packageRoot));
  return new OpenClawAdapter({
    server: input.server,
    openclawBin:
      input.openclawBin ?? resolveWorkspaceOpenClawBin(packageRoot, repoRoot),
    channelDistDir:
      input.channelDistDir ??
      path.join(repoRoot, "packages/openclaw-channel/dist"),
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

function resolveWorkspaceOpenClawBin(
  packageRoot: string,
  repoRoot: string,
): string {
  const packageBin = path.join(packageRoot, "node_modules/.bin/openclaw");
  if (fs.existsSync(packageBin)) {
    return packageBin;
  }
  return path.join(repoRoot, "node_modules/.bin/openclaw");
}

// #ignore-sloppy-code-next-line[promise-type]: net.createServer callback boundary — no Effect wrapper needed for this one-shot utility
function allocateFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const addr = server.address() as net.AddressInfo;
      server.close(() => resolve(addr.port));
    });
    server.on("error", reject);
  });
}

// --- Config and plugin install (module-private) ---

interface OpenClawConfig {
  agents: {
    defaults: {
      model: { primary: string };
      workspace: string;
      compaction: { mode: string };
    };
  };
  commands: { native: string; nativeSkills: string; restart: boolean };
  messages: {
    queue: { mode: string; debounceMs: number; cap: number; drop: string };
  };
  channels: {
    moltzap: {
      accounts: Array<{
        id: string;
        apiKey: string;
        serverUrl: string;
        agentName: string;
      }>;
    };
  };
  gateway: {
    mode: string;
    auth: { mode: string; token: string };
  };
}

function writeOpenClawConfig(opts: {
  stateDir: string;
  serverUrl: string;
  apiKey: string;
  agentName: string;
  modelId?: string;
}): void {
  const serverUrl = opts.serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:");

  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: opts.modelId ?? DEFAULT_OPENCLAW_MODEL_ID },
        workspace: path.join(opts.stateDir, "workspace"),
        compaction: { mode: "safeguard" },
      },
    },
    commands: { native: "auto", nativeSkills: "auto", restart: true },
    messages: {
      queue: { mode: "queue", debounceMs: 0, cap: 100, drop: "new" },
    },
    channels: {
      moltzap: {
        accounts: [
          {
            id: "default",
            apiKey: opts.apiKey,
            serverUrl,
            agentName: opts.agentName,
          },
        ],
      },
    },
    gateway: {
      mode: "local",
      auth: { mode: "token", token: `runtime-${Date.now().toString(36)}` },
    },
  };

  fs.mkdirSync(path.join(opts.stateDir, "workspace"), { recursive: true });
  fs.mkdirSync(path.join(opts.stateDir, "logs"), { recursive: true });
  fs.writeFileSync(
    path.join(opts.stateDir, "openclaw.json"),
    JSON.stringify(config, null, 2),
  );
}

function seedWorkspaceFiles(
  stateDir: string,
  workspaceFiles: SpawnInput["workspaceFiles"],
): void {
  if (workspaceFiles === undefined) {
    return;
  }
  const workspaceDir = path.join(stateDir, "workspace");
  for (const file of workspaceFiles) {
    const destination = path.join(workspaceDir, file.relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content);
  }
}

function installChannelPlugin(
  stateDir: string,
  channelDistDir: string,
  repoRoot: string,
): void {
  const extDir = path.join(stateDir, "extensions", "openclaw-channel");
  const channelPackageDir = path.dirname(channelDistDir);
  fs.mkdirSync(path.dirname(extDir), { recursive: true });

  // Copy the plugin package root, not just dist/. OpenClaw discovers channel
  // ids via the package metadata (`openclaw.extensions`) and then loads the
  // dist entrypoint from there.
  fs.mkdirSync(extDir, { recursive: true });
  fs.cpSync(channelDistDir, path.join(extDir, "dist"), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = path.relative(channelDistDir, src);
      return !rel.startsWith("node_modules") && !rel.startsWith("src");
    },
  });
  const packageJsonPath = path.join(channelPackageDir, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    fs.copyFileSync(packageJsonPath, path.join(extDir, "package.json"));
  }
  const pluginManifestPath = path.join(
    channelPackageDir,
    "openclaw.plugin.json",
  );
  if (fs.existsSync(pluginManifestPath)) {
    fs.copyFileSync(
      pluginManifestPath,
      path.join(extDir, "openclaw.plugin.json"),
    );
  }

  // Link workspace packages so the plugin's imports resolve.
  const pluginNm = path.join(extDir, "node_modules");
  fs.mkdirSync(path.join(pluginNm, "@moltzap"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "packages/protocol"),
    path.join(pluginNm, "@moltzap/protocol"),
    "dir",
  );
  fs.symlinkSync(
    path.join(repoRoot, "packages/client"),
    path.join(pluginNm, "@moltzap/client"),
    "dir",
  );
  fs.symlinkSync(
    path.join(channelDistDir, "node_modules", "effect"),
    path.join(pluginNm, "effect"),
    "dir",
  );
}
