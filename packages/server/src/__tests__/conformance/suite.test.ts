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
import { Data, Effect, Exit } from "effect";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  RealServerAcquireError,
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
const CONFORMANCE_DEV_MODE_USER_ID = "00000000-0000-4000-8000-000000000340";
const TOXIPROXY_PROBE_INTERVAL = "500 millis";

class ToxiproxyProbeFailed extends Data.TaggedError("ToxiproxyProbeFailed")<{
  readonly cause: unknown;
}> {}

class ToxiproxyProbeTimeout extends Data.TaggedError("ToxiproxyProbeTimeout")<{
  readonly url: string;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `Toxiproxy not reachable at ${this.url} after ${this.timeoutMs}ms`;
  }
}

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

function bringUpToxiproxy() {
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

function waitForToxiproxy(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const probe = (): Effect.Effect<
    void,
    ToxiproxyProbeFailed | ToxiproxyProbeTimeout,
    never
  > =>
    Date.now() >= deadline
      ? Effect.fail(new ToxiproxyProbeTimeout({ url, timeoutMs }))
      : Effect.tryPromise({
          try: () => fetch(`${url}/version`),
          catch: (cause) => new ToxiproxyProbeFailed({ cause }),
        }).pipe(
          Effect.flatMap((res) =>
            res.ok
              ? Effect.void
              : Effect.fail(
                  new ToxiproxyProbeFailed({
                    cause: `HTTP ${res.status.toString()}`,
                  }),
                ),
          ),
          Effect.catchAll((probeErr) =>
            Effect.sync(() => {
              if (probeErr instanceof ToxiproxyProbeFailed) {
                console.warn(
                  "toxiproxy readiness probe failed",
                  probeErr.cause,
                );
              }
            }).pipe(
              Effect.zipRight(Effect.sleep(TOXIPROXY_PROBE_INTERVAL)),
              Effect.zipRight(probe()),
            ),
          ),
        );

  return Effect.runPromise(probe());
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
        realServer: Effect.tryPromise({
          try: () =>
            startCoreTestServer({
              devModeUserId: CONFORMANCE_DEV_MODE_USER_ID,
            }),
          catch: (cause) => new RealServerAcquireError({ cause }),
        }).pipe(
          Effect.map((handle) => ({
            wsUrl: handle.wsUrl,
            baseUrl: handle.baseUrl,
            close: Effect.tryPromise({
              try: () => stopCoreTestServer(),
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => undefined)),
          })),
        ),
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
