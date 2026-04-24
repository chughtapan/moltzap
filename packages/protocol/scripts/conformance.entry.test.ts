/**
 * Conformance entry — runs under `vitest run --config vitest.conformance.config.ts`.
 *
 * Flow:
 *   1. Bring up Toxiproxy via docker-compose (unless `TOXIPROXY_URL` is set).
 *   2. Dynamically import `@moltzap/server-core/test-utils` to spin up a
 *      real MoltZap core test server. Dynamic import keeps the compile-
 *      time dependency graph one-way (AC13): `packages/protocol/src/testing/`
 *      never imports `packages/server`. This file lives at
 *      `packages/protocol/scripts/` — outside `src/testing/` — so AC13 is
 *      preserved.
 *   3. Build a `RealServerHandle` + optional Toxiproxy client under a
 *      single `Scope`; run each tier's registered properties.
 *   4. On failure, write a seed + toxic-profile artifact for replay.
 *
 * Invoked via `pnpm -F @moltzap/protocol test:conformance`.
 * `FC_SEED=<n>` reproduces an exact run. `SKIP_TOXIPROXY=1` skips Tier D.
 * `SKIP_DOCKER=1` assumes Toxiproxy is already running at `TOXIPROXY_URL`.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import { Effect, Scope, Exit } from "effect";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  acquireRunContext,
  runConformance,
  collectProperties,
  tierA,
  tierB,
  tierC,
  tierD,
  tierE,
  type ConformanceRunContext,
  type RealServerHandle,
} from "../src/testing/conformance/index.js";

const SKIP_TOXIPROXY = process.env.SKIP_TOXIPROXY === "1";
const SKIP_DOCKER = process.env.SKIP_DOCKER === "1";
const TOXIPROXY_URL = process.env.TOXIPROXY_URL ?? "http://127.0.0.1:8474";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ??
  path.resolve(process.cwd(), "conformance-artifacts");

interface ComposeController {
  readonly teardown: () => Promise<void>;
}

function findComposeFile(): string {
  // Run-from-package-dir path.
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

// #ignore-sloppy-code-next-line[promise-type]: script bootstrap — docker compose spawn is Promise-native
function bringUpDockerCompose(): Promise<ComposeController> {
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

// #ignore-sloppy-code-next-line[async-keyword]: Vitest hook-native orchestration; Promise-returning fetch polling inside
async function waitForToxiproxy(
  url: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/version`);
      if (res.ok) return;
      // #ignore-sloppy-code-next-line[bare-catch]: transient polling failure — loop retries
    } catch {
      /* retry until deadline */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Toxiproxy not reachable at ${url} after ${timeoutMs}ms`);
}

// #ignore-sloppy-code-next-line[async-keyword]: dynamic import pattern for AC13 (no compile-time server dep)
async function buildRealServer(): Promise<RealServerHandle> {
  const serverUtils = (await import("@moltzap/server-core/test-utils")) as {
    startCoreTestServer: (opts?: unknown) => Promise<{
      baseUrl: string;
      wsUrl: string;
    }>;
    stopCoreTestServer: () => Promise<void>;
  };
  const handle = await serverUtils.startCoreTestServer();
  return {
    wsUrl: handle.wsUrl,
    baseUrl: handle.baseUrl,
    close: () => serverUtils.stopCoreTestServer(),
  };
}

describe("conformance suite", () => {
  let compose: ComposeController | null = null;
  let ctx: ConformanceRunContext | null = null;
  let scope: Scope.CloseableScope | null = null;

  beforeAll(async () => {
    if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });
    if (!SKIP_TOXIPROXY && !SKIP_DOCKER) {
      compose = await bringUpDockerCompose();
      await waitForToxiproxy(TOXIPROXY_URL);
    } else if (!SKIP_TOXIPROXY) {
      await waitForToxiproxy(TOXIPROXY_URL, 5_000);
    }

    const tiers = SKIP_TOXIPROXY
      ? (["A", "B", "C", "E"] as const)
      : (["A", "B", "C", "D", "E"] as const);

    const localScope = await Effect.runPromise(Scope.make());
    scope = localScope;

    ctx = await Effect.runPromise(
      acquireRunContext({
        tiers: [...tiers],
        realServer: buildRealServer,
        toxiproxyUrl: TOXIPROXY_URL,
        manageToxiproxy: !SKIP_DOCKER,
        artifactDir: ARTIFACT_DIR,
      }).pipe(Scope.extend(localScope)),
    );

    await Effect.runPromise(runConformance(ctx));

    // Register every tier's properties under one context.
    if (tiers.includes("A")) {
      tierA.registerA1Requests(ctx);
      tierA.registerA2Events(ctx);
      tierA.registerA3RoundTrip(ctx);
      tierA.registerA4Malformed(ctx);
      tierA.registerA5Coverage(ctx);
    }
    if (tiers.includes("B")) {
      tierB.registerB1ModelEquivalence(ctx);
      tierB.registerB2AuthorityPositive(ctx);
      tierB.registerB3AuthorityNegative(ctx);
      tierB.registerB4RequestIdUniqueness(ctx);
      tierB.registerB5Idempotence(ctx);
    }
    if (tiers.includes("C")) {
      tierC.registerC1FanOut(ctx);
      tierC.registerC2StoreReplay(ctx);
      tierC.registerC3PayloadOpacity(ctx);
      tierC.registerC4TaskIsolation(ctx);
    }
    if (tiers.includes("D") && ctx.toxiproxy !== null) {
      tierD.registerD1Latency(ctx);
      // D2 is tombstoned (epic #186).
      tierD.registerD3Slicer(ctx);
      tierD.registerD4ResetPeer(ctx);
      tierD.registerD5Timeout(ctx);
      tierD.registerD6SlowClose(ctx);
    }
    if (tiers.includes("E")) {
      tierE.registerE2SchemaFuzz(ctx);
      // E1 requires a WebhookAdapterProbe; supplied by server-side suite.
    }
  }, 90_000);

  afterAll(async () => {
    if (scope !== null) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    if (compose !== null) {
      await compose.teardown();
    }
  });

  it("registers every non-D2 tier property", () => {
    if (ctx === null) throw new Error("ctx not set");
    const registered = collectProperties(ctx);
    // eslint-disable-next-line no-console
    console.log(`[conformance] registered ${registered.length} properties`);
    if (registered.length === 0) {
      throw new Error("no properties registered");
    }
  });

  it("every registered property runs to completion", async () => {
    if (ctx === null) throw new Error("ctx not set");
    const registered = collectProperties(ctx);
    const failures: Array<{ id: string; err: string }> = [];
    for (const p of registered) {
      try {
        // eslint-disable-next-line no-console
        console.log(`[conformance] ▶ ${p.tier}/${p.id} ${p.description}`);
        await p.run();
        // eslint-disable-next-line no-console
        console.log(`[conformance] ✓ ${p.tier}/${p.id}`);
        // #ignore-sloppy-code-next-line[bare-catch]: property registry defines errors as failures of that specific property
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push({ id: `${p.tier}/${p.id}`, err: msg });
        writeFileSync(
          path.join(ARTIFACT_DIR, `${p.tier}-${p.id}.seed.json`),
          JSON.stringify(
            { tier: p.tier, id: p.id, seed: ctx.seed, error: msg },
            null,
            2,
          ),
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${registered.length} properties failed: ${failures.map((f) => `${f.id}: ${f.err}`).join("; ")}`,
      );
    }
  }, 600_000);
});
