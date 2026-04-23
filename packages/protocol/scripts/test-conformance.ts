#!/usr/bin/env tsx
/**
 * test-conformance — one-command conformance runner (AC11).
 *
 * Flow:
 *   1. Bring up Toxiproxy via docker-compose (unless `TOXIPROXY_URL` is set).
 *   2. Dynamically import `@moltzap/server/test-utils` to spin up a real
 *      MoltZap core test server. Dynamic import keeps the compile-time
 *      dependency graph one-way (AC13): `packages/protocol/src/testing/`
 *      never imports `packages/server`.
 *   3. Build a `RealServerHandle` + optional Toxiproxy client under a
 *      single `Scope`; run each tier's registered properties.
 *   4. On failure, write a seed + toxic-profile artifact for replay.
 *
 * The script is invoked via `pnpm -F @moltzap/protocol test:conformance`.
 * `FC_SEED=<n>` reproduces an exact run. `SKIP_TOXIPROXY=1` skips Tier D.
 * `SKIP_DOCKER=1` assumes Toxiproxy is already running at `TOXIPROXY_URL`.
 */
import { Effect, Scope } from "effect";
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

async function bringUpDockerCompose(): Promise<ComposeController> {
  const composePath = path.resolve(
    process.cwd(),
    "../../docker-compose.conformance.yml",
  );
  if (!existsSync(composePath)) {
    // Running from repo root instead of package dir.
    const rootCompose = path.resolve(
      process.cwd(),
      "docker-compose.conformance.yml",
    );
    if (!existsSync(rootCompose)) {
      throw new Error(
        `docker-compose.conformance.yml not found at ${composePath} or ${rootCompose}`,
      );
    }
    return spawnCompose(rootCompose);
  }
  return spawnCompose(composePath);
}

function spawnCompose(composePath: string): Promise<ComposeController> {
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

async function waitForToxiproxy(
  url: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/version`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Toxiproxy not reachable at ${url} after ${timeoutMs}ms`);
}

async function buildRealServer(): Promise<RealServerHandle> {
  // Dynamic import preserves AC13: no compile-time `import` from
  // packages/server lives under packages/protocol/src/testing/.
  const serverUtils = (await import("@moltzap/server/test-utils")) as {
    startCoreTestServer: (opts?: unknown) => Promise<{
      baseUrl: string;
      wsUrl: string;
      stop: () => Promise<void>;
    }>;
  };
  const handle = await serverUtils.startCoreTestServer();
  return {
    wsUrl: handle.wsUrl,
    baseUrl: handle.baseUrl,
    close: () => handle.stop(),
  };
}

async function main(): Promise<void> {
  if (!existsSync(ARTIFACT_DIR)) mkdirSync(ARTIFACT_DIR, { recursive: true });

  let compose: ComposeController | null = null;
  if (!SKIP_TOXIPROXY && !SKIP_DOCKER) {
    compose = await bringUpDockerCompose();
    await waitForToxiproxy(TOXIPROXY_URL);
  }

  try {
    const tiers = SKIP_TOXIPROXY
      ? (["A", "B", "C", "E"] as const)
      : (["A", "B", "C", "D", "E"] as const);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ctx = yield* acquireRunContext({
            tiers: [...tiers],
            realServer: buildRealServer,
            toxiproxyUrl: TOXIPROXY_URL,
            manageToxiproxy: !SKIP_DOCKER,
            artifactDir: ARTIFACT_DIR,
          });
          yield* runConformance(ctx);

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
            // E1 requires a WebhookAdapterProbe; exposed via the suite entry
            // and registered there if a probe is in scope.
          }

          const registered = collectProperties(ctx);
          // eslint-disable-next-line no-console
          console.log(
            `[conformance] registered ${registered.length} properties`,
          );

          let failed = 0;
          for (const p of registered) {
            try {
              // eslint-disable-next-line no-console
              console.log(`[conformance] ▶ ${p.tier}/${p.id} ${p.description}`);
              yield* Effect.promise(() => p.run());
              // eslint-disable-next-line no-console
              console.log(`[conformance] ✓ ${p.tier}/${p.id}`);
            } catch (err) {
              failed += 1;
              // eslint-disable-next-line no-console
              console.error(
                `[conformance] ✗ ${p.tier}/${p.id}: ${String(err)}`,
              );
              writeFileSync(
                path.join(ARTIFACT_DIR, `${p.tier}-${p.id}.seed.json`),
                JSON.stringify(
                  {
                    tier: p.tier,
                    id: p.id,
                    seed: ctx.seed,
                    error: String(err),
                  },
                  null,
                  2,
                ),
              );
            }
          }

          if (failed > 0) {
            throw new Error(
              `[conformance] ${failed}/${registered.length} properties failed; artifacts in ${ARTIFACT_DIR}`,
            );
          }
        }),
      ),
    );
    // eslint-disable-next-line no-console
    console.log("[conformance] all properties passed");
  } finally {
    if (compose !== null) {
      await compose.teardown();
    }
  }
}

// Suppress "no-top-level-await": tsx supports it, and this script is the entry.
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
void Scope;
