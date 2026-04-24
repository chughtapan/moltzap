/**
 * Server-core conformance entry — thin wrapper around
 * `@moltzap/protocol/testing`'s `runConformanceSuite`. Passes
 * `startCoreTestServer` as the real-server factory and asserts the
 * typed suite result in a single `it(...)`.
 *
 * All orchestration (property registration, Effect run loop, artifact
 * dump, seed pinning) lives in protocol. The file here exists only to
 * name the implementation under test.
 *
 * Any other consumer — a third-party server, a client-side harness
 * driving `TestServer`, arena — writes an equivalent ~20-line file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  runConformanceSuite,
  type SuiteResult,
} from "@moltzap/protocol/testing";
import {
  startCoreTestServer,
  stopCoreTestServer,
} from "../../test-utils/index.js";

const SKIP_TOXIPROXY = process.env.SKIP_TOXIPROXY === "1";
const SKIP_DOCKER = process.env.SKIP_DOCKER === "1";
const TOXIPROXY_URL = process.env.TOXIPROXY_URL ?? "http://127.0.0.1:8474";

interface ComposeController {
  readonly teardown: () => Promise<void>;
}

function findComposeFile(): string {
  const fromPkg = path.resolve(
    process.cwd(),
    "../../docker-compose.conformance.yml",
  );
  if (existsSync(fromPkg)) return fromPkg;
  const fromRoot = path.resolve(
    process.cwd(),
    "docker-compose.conformance.yml",
  );
  if (existsSync(fromRoot)) return fromRoot;
  throw new Error(
    `docker-compose.conformance.yml not found (cwd=${process.cwd()})`,
  );
}

// #ignore-sloppy-code-next-line[promise-type]: docker-compose is a consumer concern; Promise-native
function bringUpToxiproxy(): Promise<ComposeController> {
  const composePath = findComposeFile();
  return new Promise((resolve, reject) => {
    const up = spawn("docker", ["compose", "-f", composePath, "up", "-d"], {
      stdio: "inherit",
    });
    up.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`docker compose up exited with code ${code}`));
        return;
      }
      resolve({
        teardown: () =>
          new Promise((resolveDown) => {
            const down = spawn(
              "docker",
              ["compose", "-f", composePath, "down", "-v"],
              { stdio: "inherit" },
            );
            down.on("exit", () => resolveDown());
          }),
      });
    });
  });
}

// #ignore-sloppy-code-next-line[async-keyword]: Vitest hook-native orchestration
async function waitForToxiproxy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/version`);
      if (res.ok) return;
      // #ignore-sloppy-code-next-line[bare-catch]: transient polling failure — loop retries
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Toxiproxy not reachable at ${url} after ${timeoutMs}ms`);
}

describe("moltzap-server-core conformance", () => {
  let compose: ComposeController | null = null;
  let toxiproxyUrl: string | null = null;

  beforeAll(async () => {
    if (SKIP_TOXIPROXY) return;
    if (!SKIP_DOCKER) {
      compose = await bringUpToxiproxy();
      await waitForToxiproxy(TOXIPROXY_URL, 30_000);
    } else {
      await waitForToxiproxy(TOXIPROXY_URL, 5_000);
    }
    toxiproxyUrl = TOXIPROXY_URL;
  }, 60_000);

  afterAll(async () => {
    if (compose !== null) await compose.teardown();
  });

  it("every protocol conformance property passes against the core server", async () => {
    const exit = await Effect.runPromiseExit(
      runConformanceSuite({
        realServer: async () => {
          const handle = await startCoreTestServer();
          return {
            wsUrl: handle.wsUrl,
            baseUrl: handle.baseUrl,
            close: () => stopCoreTestServer(),
          };
        },
        toxiproxyUrl,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result: SuiteResult = exit.value;
    console.log(
      `[conformance] seed=${result.seed} passed=${result.passed.length} deferred=${result.deferred.length} unavailable=${result.unavailable.length} failed=${result.failed.length}`,
    );
    if (result.unavailable.length > 0) {
      console.log(
        `[conformance] unavailable: ${result.unavailable.map((u) => `${u.name}: ${u.reason}`).join(" | ")}`,
      );
    }
    if (result.failed.length > 0) {
      const summary = result.failed
        .map((f) => {
          const tag = "_tag" in f.failure ? f.failure._tag : "unknown";
          const reason =
            "cause" in f.failure
              ? String(f.failure.cause)
              : "reason" in f.failure
                ? f.failure.reason
                : "message" in f.failure
                  ? f.failure.message
                  : "";
          return `${f.name}: ${tag} — ${reason}`;
        })
        .join("; ");
      throw new Error(
        `${result.failed.length}/${result.failed.length + result.passed.length + result.deferred.length + result.unavailable.length} failed: ${summary}`,
      );
    }
  }, 600_000);
});
