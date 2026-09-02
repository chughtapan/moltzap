/**
 * @file The executable's process contract under a signal: a submitter killed
 * while it waits on the cluster exits non-zero, names the signal on stderr,
 * and prints no result line.
 */

import { Exit, FiberId } from "effect";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ExecutableSignal, executableTeardown } from "./cli.js";

/* eslint-disable agent-code-guard/promise-type, agent-code-guard/no-process-env-at-runtime -- The executable is a real child process, driven through Node's process and socket APIs. */

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const EXECUTABLE = fileURLToPath(
  new URL("../../../bin/moltzap-sim", import.meta.url),
);
const EXPERIMENT = "local/end-to-end.mjs";
const SIGTERM_EXIT = 143;
const SIGINT_EXIT = 130;
const CONNECT_WAIT_MS = 30_000;
const TEST_TIMEOUT_MS = 45_000;

interface SilentListener {
  readonly port: number;
  readonly close: () => void;
}

interface ChildOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function killedWhileConnecting(
  signal: ExecutableSignal,
): Promise<ChildOutcome> {
  const listener = await silentListener();
  try {
    const child = spawn(
      process.execPath,
      [EXECUTABLE, "run", "--profile", "gke", EXPERIMENT],
      {
        cwd: PACKAGE_ROOT,
        env: submitterEnvironment(listener.port),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => {
        resolve(code);
      });
    });
    const said = connecting(child.stderr);
    const rest = new Promise<string>((resolve) => {
      let text = "";
      child.stderr.on("data", (chunk: Buffer) => {
        text += chunk.toString();
      });
      child.once("exit", () => {
        resolve(text);
      });
    });
    await said;
    child.kill(signal);
    return { code: await exited, stdout, stderr: await rest };
  } finally {
    listener.close();
  }
}

// Resolves with what the submitter said once it says it is connecting, which
// is where the silent listener holds it; rejects with what it said instead if
// it never gets there.
function connecting(stderr: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let said = "";
    const timer = setTimeout(() => {
      reject(
        new Error(
          `no Temporal connect within ${String(CONNECT_WAIT_MS)}ms: ${said}`,
        ),
      );
    }, CONNECT_WAIT_MS);
    stderr.on("data", (chunk: Buffer) => {
      said += chunk.toString();
      if (said.includes("connecting Temporal")) {
        clearTimeout(timer);
        resolve(said);
      }
    });
  });
}

// Accepts the connection and never answers, so the submitter stays inside its
// Temporal connect until it is signalled.
function silentListener(): Promise<SilentListener> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        close: () => {
          server.close();
        },
      });
    });
  });
}

function submitterEnvironment(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MOLTZAP_KUBE_CONTEXT: "kind-none",
    MOLTZAP_GKE_ARTIFACT_BUCKET: "moltzap-test-bucket",
    MOLTZAP_CONTROLLER_IMAGE: `registry.invalid/controller@sha256:${"a".repeat(64)}`,
    MOLTZAP_TEMPORAL_ADDRESS: `127.0.0.1:${String(port)}`,
  };
}

describe("executableTeardown", () => {
  const observe = () => {
    const lines: string[] = [];
    const codes: number[] = [];
    return {
      lines,
      codes,
      report: (line: string) => {
        lines.push(line);
      },
      onExit: (code: number) => {
        codes.push(code);
      },
    };
  };

  it("turns an interruption into the signal's exit and one line naming it", () => {
    const observed = observe();

    executableTeardown(() => "SIGTERM", observed.report)(
      Exit.interrupt(FiberId.make(1, 0)),
      observed.onExit,
    );

    expect(observed.codes).toEqual([SIGTERM_EXIT]);
    expect(observed.lines).toEqual([
      "SIGTERM: the submission ended before it printed a result line\n",
    ]);
  });
});

describe("moltzap-sim under a signal", () => {
  it(
    "exits 143 on SIGTERM, names the signal on stderr, and prints no result line",
    async () => {
      const outcome = await killedWhileConnecting("SIGTERM");

      expect(outcome.code).toBe(SIGTERM_EXIT);
      expect(outcome.stdout).toBe("");
      expect(outcome.stderr).toContain("SIGTERM");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exits 130 on SIGINT",
    async () => {
      const outcome = await killedWhileConnecting("SIGINT");

      expect(outcome.code).toBe(SIGINT_EXIT);
      expect(outcome.stdout).toBe("");
    },
    TEST_TIMEOUT_MS,
  );
});

/* eslint-enable agent-code-guard/promise-type, agent-code-guard/no-process-env-at-runtime -- Restore repository defaults. */
