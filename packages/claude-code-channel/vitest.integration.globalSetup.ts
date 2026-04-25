/**
 * Global setup for integration tests.
 *
 * Pattern: sbd#182 spike (evidence in
 * `safer-by-default/spike/moltzap-headless-ci-fixture/probe.mjs`).
 * Spawns `packages/server/dist/standalone.js` with PGlite (no external
 * Postgres, no docker). Registers two agents so the echo test can boot a
 * channel as agent A and drive inbound traffic via an in-process MoltZap
 * client as agent B. Provides WS URL + per-agent API keys + agent IDs to
 * the test via vitest `provide()`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { GlobalSetupContext } from "vitest/node";

let child: ChildProcess | null = null;
let tempDir: string | null = null;

function pickPort(): number {
  // 41990-42240 band per spike-182.
  return 41990 + Math.floor(Math.random() * 250);
}

async function registerAgent(
  baseUrl: string,
  name: string,
): Promise<{ agentId: string; apiKey: string }> {
  const r = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`register ${name}: ${r.status} ${text}`);
  }
  const json = JSON.parse(text) as { agentId: string; apiKey: string };
  if (!json.agentId || !json.apiKey) {
    throw new Error(`register ${name}: missing agentId/apiKey in ${text}`);
  }
  return json;
}

export default async function ({ provide }: GlobalSetupContext) {
  // Locate the built standalone.js relative to this package.
  const here = dirname(fileURLToPath(import.meta.url));
  const moltzapRoot = resolve(here, "..", "..");
  const standalone = join(
    moltzapRoot,
    "packages",
    "server",
    "dist",
    "standalone.js",
  );

  tempDir = mkdtempSync(join(tmpdir(), "ccc-integration-"));
  const configPath = join(tempDir, "moltzap.yaml");
  const port = pickPort();
  writeFileSync(
    configPath,
    `server:\n  port: ${port}\n  cors_origins: ["*"]\nlog_level: warn\n`,
    "utf8",
  );

  const baseUrl = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}`;

  let stderr = "";
  child = spawn("node", [standalone], {
    cwd: moltzapRoot,
    env: {
      ...process.env,
      MOLTZAP_CONFIG: configPath,
      // `MOLTZAP_DEV_MODE=true` makes `DATABASE_URL` optional; empty URL
      // triggers embedded PGlite (standalone.ts:319). Required because
      // DATABASE_URL is otherwise mandatory outside dev-mode and we have
      // no external Postgres in CI.
      MOLTZAP_DEV_MODE: "true",
      PORT: String(port),
      ENCRYPTION_MASTER_SECRET: "a".repeat(44),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  // Poll `/api/v1/auth/register` with OPTIONS until ≥200 < 500 (server up).
  const t0 = performance.now();
  const deadline = t0 + 60_000;
  let ready = false;
  while (performance.now() < deadline) {
    try {
      const probe = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: "OPTIONS",
        signal: AbortSignal.timeout(500),
      });
      if (probe.status < 500) {
        ready = true;
        break;
      }
    } catch {
      // not yet
    }
    await delay(50);
  }
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error(
      `moltzap standalone did not become ready within 60s. stderr tail:\n${stderr.split("\n").slice(-20).join("\n")}`,
    );
  }

  const agentA = await registerAgent(baseUrl, "channel-agent-a");
  const agentB = await registerAgent(baseUrl, "peer-agent-b");

  provide("moltzapBaseUrl", baseUrl);
  provide("moltzapWsUrl", wsUrl);
  provide("agentAAgentId", agentA.agentId);
  provide("agentAApiKey", agentA.apiKey);
  provide("agentBAgentId", agentB.agentId);
  provide("agentBApiKey", agentB.apiKey);

  return async () => {
    const p = child;
    if (p !== null) {
      p.kill("SIGTERM");
      await new Promise<void>((resolveStop) => {
        const t = setTimeout(() => {
          p.kill("SIGKILL");
          resolveStop();
        }, 5000);
        p.on("exit", () => {
          clearTimeout(t);
          resolveStop();
        });
      });
      child = null;
    }
    if (tempDir !== null) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  };
}
