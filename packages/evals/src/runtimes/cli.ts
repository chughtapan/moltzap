import { Effect } from "effect";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { MoltZapService } from "@moltzap/client";
import {
  startCoreTestServer,
  stopCoreTestServer,
} from "@moltzap/server-core/test-utils";

import {
  OpenClawAdapter,
  type OpenClawAdapterDeps,
} from "./openclaw-adapter.js";

export type ChatPhase =
  | "server-start"
  | "agent-register"
  | "agent-spawn"
  | "agent-ready"
  | "dm-send"
  | "dm-delivery"
  | "teardown";

export type ChatResult =
  | { readonly _tag: "Pass"; readonly durationMs: number }
  | {
      readonly _tag: "Fail";
      readonly phase: ChatPhase;
      readonly agentName?: string;
      readonly detail: string;
      readonly logExcerpt: string;
    };

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

const CHANNEL_DIST = path.join(REPO_ROOT, "packages", "openclaw-channel");

function findOpenclawBin(): string {
  const requireFromHere = createRequire(import.meta.url);
  const openclawEntry = requireFromHere.resolve("openclaw");
  let dir = path.dirname(openclawEntry);
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "openclaw.mjs");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`could not find openclaw.mjs near ${openclawEntry}`);
}

const OPENCLAW_BIN = findOpenclawBin();

function brand<T extends string>(
  value: string,
  _brand: T,
): string & { readonly __brand: T } {
  return value as string & { readonly __brand: T };
}

function fail(
  phase: ChatPhase,
  detail: string,
  opts?: { agentName?: string; logExcerpt?: string },
): ChatResult {
  return {
    _tag: "Fail",
    phase,
    agentName: opts?.agentName,
    detail,
    logExcerpt: opts?.logExcerpt ?? "",
  };
}

function tailN(text: string, n: number): string {
  return text.split("\n").slice(-n).join("\n");
}

/**
 * Orchestrates the full two-agent chat lifecycle:
 * start server → register agents → spawn OpenClaw runtimes →
 * verify readiness → send DM → detect inbound marker →
 * teardown all resources → return result.
 */
export function agentsChat(): Effect.Effect<ChatResult, never, never> {
  return Effect.promise(() => runChat()); // #ignore-sloppy-code[effect-promise]: runChat never rejects — all errors become ChatResult.Fail
}

// #ignore-sloppy-code-next-line[promise-type, async-keyword]: agentsChat() is the Effect boundary; runChat is an internal Promise bridge
async function runChat(): Promise<ChatResult> {
  const startedAt = Date.now();

  // Phase: server-start
  let server;
  try {
    server = await startCoreTestServer();
  } catch (err) {
    return fail(
      "server-start",
      `Failed to start test server: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const adapters: OpenClawAdapter[] = [];
  const services: MoltZapService[] = [];

  try {
    // Phase: agent-register
    let aliceReg: { apiKey: string; agentId: string };
    let bobReg: { apiKey: string; agentId: string };
    let senderReg: { apiKey: string; agentId: string };
    try {
      [aliceReg, bobReg, senderReg] = await Promise.all([
        fetch(`${server.baseUrl}/api/v1/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "alice" }),
          // #ignore-sloppy-code-next-line[then-chain]: idiomatic fetch→JSON mapping
        }).then(
          // #ignore-sloppy-code-next-line[async-keyword]: fetch JSON deserialisation boundary
          async (r) => (await r.json()) as { apiKey: string; agentId: string },
        ),
        fetch(`${server.baseUrl}/api/v1/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "bob" }),
          // #ignore-sloppy-code-next-line[then-chain]: idiomatic fetch→JSON mapping
        }).then(
          // #ignore-sloppy-code-next-line[async-keyword]: fetch JSON deserialisation boundary
          async (r) => (await r.json()) as { apiKey: string; agentId: string },
        ),
        // A dedicated sender agent avoids displacing alice's openclaw gateway
        // connection — the server enforces one active session per agent.
        fetch(`${server.baseUrl}/api/v1/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "runtime-sender" }),
          // #ignore-sloppy-code-next-line[then-chain]: idiomatic fetch→JSON mapping
        }).then(
          // #ignore-sloppy-code-next-line[async-keyword]: fetch JSON deserialisation boundary
          async (r) => (await r.json()) as { apiKey: string; agentId: string },
        ),
      ]);
    } catch (err) {
      return fail(
        "agent-register",
        `Failed to register agents: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const deps: OpenClawAdapterDeps = {
      coreApp: server.coreApp,
      openclawBin: OPENCLAW_BIN,
      channelDistDir: CHANNEL_DIST,
      repoRoot: REPO_ROOT,
    };

    const alice = new OpenClawAdapter(deps);
    const bob = new OpenClawAdapter(deps);
    adapters.push(alice, bob);

    // Phase: agent-spawn
    const spawnResults = await Promise.all(
      [alice, bob].map((adapter, i) => {
        const reg = i === 0 ? aliceReg : bobReg;
        const name = i === 0 ? "alice" : "bob";
        return Effect.runPromise(
          Effect.either(
            adapter.spawn({
              agentName: brand(name, "AgentName"),
              apiKey: brand(reg.apiKey, "ApiKey"),
              agentId: reg.agentId,
              serverUrl: brand(server.wsUrl, "ServerUrl"),
            }),
          ),
        );
      }),
    );

    for (let i = 0; i < spawnResults.length; i++) {
      const result = spawnResults[i]!;
      if (result._tag === "Left") {
        return fail(
          "agent-spawn",
          `Spawn failed: ${result.left.cause.message}`,
          {
            agentName: i === 0 ? "alice" : "bob",
          },
        );
      }
    }

    // Phase: agent-ready
    const readyResults = await Promise.all([
      Effect.runPromise(alice.waitUntilReady(60_000)),
      Effect.runPromise(bob.waitUntilReady(60_000)),
    ]);

    for (let i = 0; i < readyResults.length; i++) {
      const outcome = readyResults[i]!;
      const agentName = i === 0 ? "alice" : "bob";
      if (outcome._tag !== "Ready") {
        const logExcerpt =
          outcome._tag === "ProcessExited"
            ? tailN(outcome.stderr, 20)
            : tailN(adapters[i]?.getLogs(0).text ?? "", 20);
        return fail(
          "agent-ready",
          outcome._tag === "Timeout"
            ? `Timed out after ${outcome.timeoutMs}ms`
            : `Process exited with code ${outcome.exitCode}`,
          { agentName, logExcerpt },
        );
      }
    }

    // Phase: dm-send
    const bobOffset = bob.getLogs(0).nextOffset;

    const aliceService = new MoltZapService({
      serverUrl: server.baseUrl,
      agentKey: senderReg.apiKey,
    });
    services.push(aliceService);

    try {
      await Effect.runPromise(
        aliceService
          .connect()
          .pipe(
            Effect.flatMap(() =>
              aliceService.sendToAgent("bob", "hello from runtime chat"),
            ),
          ),
      );
    } catch (err) {
      return fail(
        "dm-send",
        `DM send failed: ${err instanceof Error ? err.message : String(err)}`,
        {
          agentName: "alice",
          logExcerpt: tailN(alice.getLogs(0).text, 20),
        },
      );
    }

    // Phase: dm-delivery
    const marker = bob.getInboundMarker();
    const deliveryDeadline = Date.now() + 30_000;
    let delivered = false;

    while (Date.now() < deliveryDeadline) {
      const postSendLogs = bob.getLogs(bobOffset).text;
      if (postSendLogs.includes(marker)) {
        delivered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (!delivered) {
      return fail("dm-delivery", "Inbound marker not found within 30s", {
        agentName: "bob",
        logExcerpt: tailN(bob.getLogs(bobOffset).text, 20),
      });
    }

    return { _tag: "Pass", durationMs: Date.now() - startedAt };
  } finally {
    // Phase: teardown
    for (const adapter of adapters) {
      try {
        await Effect.runPromise(adapter.teardown());
        // #ignore-sloppy-code-next-line[bare-catch]: teardown cleanup — nothing to do on failure
      } catch (_err) {
        void _err;
      }
    }
    for (const service of services) {
      try {
        service.close();
        // #ignore-sloppy-code-next-line[bare-catch]: service close — nothing to do on failure
      } catch {}
    }
    await stopCoreTestServer();
  }
}
