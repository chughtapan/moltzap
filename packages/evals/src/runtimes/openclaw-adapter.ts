import { Effect } from "effect";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { CoreApp } from "@moltzap/server-core";

import type { Runtime, SpawnInput, LogSlice, ReadyOutcome } from "./runtime.js";
import { SpawnFailed } from "./errors.js";

export interface OpenClawAdapterDeps {
  readonly coreApp: CoreApp;
  readonly openclawBin: string;
  readonly channelDistDir: string;
  readonly repoRoot: string;
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
        });

        installChannelPlugin(
          stateDir,
          this.deps.channelDistDir,
          this.deps.repoRoot,
        );

        const child = nodeSpawn(
          "node",
          [
            this.deps.openclawBin,
            "gateway",
            "run",
            "--allow-unconfigured",
            "--port",
            String(port),
          ],
          {
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
          },
        );

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

        const connections = this.deps.coreApp.connections.getByAgent(agentId);
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

  /** Async teardown: SIGTERM → await exit event (≤10s) → SIGKILL → rm workdir. */
  // #ignore-sloppy-code-next-line[async-keyword, promise-type]: child_process exit event + fs.rm boundary
  private async doTeardown(): Promise<void> {
    if (!this.state || this.state.tornDown) return;
    this.state.tornDown = true;

    const { child, stateDir } = this.state;

    this.killGroup(child, "SIGTERM");

    if (child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (child.exitCode === null) {
      this.killGroup(child, "SIGKILL");
    }

    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
      // #ignore-sloppy-code-next-line[bare-catch]: teardown cleanup — nothing to do if rmSync fails
    } catch (_err) {
      void _err;
    }
  }

  private killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
      if (child.pid != null) {
        process.kill(-child.pid, signal);
      }
      // #ignore-sloppy-code-next-line[bare-catch]: ESRCH — process already dead
    } catch (_err) {
      void _err;
    }
  }
}

// --- Module-private helpers ---

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
}): void {
  const serverUrl = opts.serverUrl
    .replace(/\/ws$/, "")
    .replace(/^ws:/, "http:");

  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-5" },
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

function installChannelPlugin(
  stateDir: string,
  channelDistDir: string,
  repoRoot: string,
): void {
  const extDir = path.join(stateDir, "extensions", "openclaw-channel");
  fs.mkdirSync(path.dirname(extDir), { recursive: true });

  // Copy, not symlink. OpenClaw's plugin loader rejects symlinked roots
  // (openBoundaryFileSync with rejectHardlinks: true).
  fs.cpSync(channelDistDir, extDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = path.relative(channelDistDir, src);
      return !rel.startsWith("node_modules") && !rel.startsWith("src");
    },
  });

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
}
