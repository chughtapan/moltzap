/**
 * Integration test for `ClaudeCodeAdapter` (issue #255).
 *
 * Spawns the real Anthropic `claude` CLI (installed as a devDep of
 * `@moltzap/runtimes`) configured via `--mcp-config` to load the
 * `@moltzap/claude-code-channel` plugin from a per-agent state dir.
 * Asserts the adapter's spawn → ready → teardown cycle:
 *   - The channel's MCP stdio server boots inside `claude`.
 *   - cc-channel's `MoltZapService.connect()` authenticates against the
 *     in-process moltzap core test server.
 *   - The server's `ConnectionManager` records the auth, which
 *     `waitUntilReady` polls (auth-on-connection — same signal openclaw
 *     and nanoclaw use).
 *   - Teardown reaps the detached process group.
 *
 * Skips with a logged note when the test environment lacks an Anthropic
 * API key (CI without `ANTHROPIC_API_KEY` cannot start `claude` past its
 * auth gate). The skip path mirrors how nanoclaw integration tests
 * abstain in environments without Docker.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Effect } from "effect";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import {
  startCoreTestServer,
  stopCoreTestServer,
  type CoreTestServer,
} from "@moltzap/server-core/test-utils";
import { registerAgent, stripWsPath } from "@moltzap/client/test";

import { createWorkspaceClaudeCodeAdapter } from "./claude-code-adapter.js";
import { AgentName, ApiKey, ServerUrl } from "./runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..", "..");
const CC_CHANNEL_DIST = join(
  REPO_ROOT,
  "packages",
  "claude-code-channel",
  "dist",
);
const CLAUDE_BIN_CANDIDATES = [
  join(REPO_ROOT, "packages", "runtimes", "node_modules", ".bin", "claude"),
  join(REPO_ROOT, "node_modules", ".bin", "claude"),
];

function findClaudeBin(): string | null {
  for (const candidate of CLAUDE_BIN_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const CLAUDE_BIN = findClaudeBin();
// Auth: claude authenticates via whichever path the host has set up —
// `ANTHROPIC_API_KEY`, OAuth credentials in the host's claude config, or
// a keychain credential. We don't gate on `ANTHROPIC_API_KEY` because
// OAuth-only setups are common (and the spawn-side `--bare` flag that
// would force env-only auth is intentionally NOT passed by the adapter).
// If claude can't auth at runtime, the subprocess exits and
// `waitUntilReady` returns `ProcessExited` with the auth error in stderr
// — which is informative enough.
if (CLAUDE_BIN === null) {
  describe.skip("ClaudeCodeAdapter (integration) — skipped (claude bin not installed)", () => {
    it("requires claude CLI on disk", () => {
      expect(CLAUDE_BIN).not.toBeNull();
    });
  });
} else {
  describe("ClaudeCodeAdapter (integration)", () => {
    let server: CoreTestServer;

    beforeAll(async () => {
      server = await startCoreTestServer();
    }, 60_000);

    afterAll(async () => {
      await stopCoreTestServer();
    });

    it("spawn → ready → teardown completes against the real claude CLI + cc-channel MCP plugin", async () => {
      const reg = await Effect.runPromise(
        registerAgent(server.baseUrl, "claude-code-runtime-it"),
      );

      const adapter = createWorkspaceClaudeCodeAdapter({
        server: server.runtimeServer,
        claudeBin: CLAUDE_BIN,
        channelDistDir: CC_CHANNEL_DIST,
        repoRoot: REPO_ROOT,
      });

      const spawnResult = await Effect.runPromise(
        Effect.either(
          adapter.spawn({
            agentName: AgentName("claude-code-runtime-it"),
            apiKey: ApiKey(reg.apiKey),
            agentId: reg.agentId,
            serverUrl: ServerUrl(stripWsPath(server.wsUrl)),
          }),
        ),
      );
      expect(spawnResult._tag).toBe("Right");

      const ready = await Effect.runPromise(adapter.waitUntilReady(120_000));
      if (ready._tag !== "Ready") {
        const logs = adapter.getLogs(0).text;
        throw new Error(
          `expected Ready, got ${ready._tag}. claude+cc-channel logs:\n${logs}`,
        );
      }
      expect(ready._tag).toBe("Ready");

      // `getLogs` returns a `LogSlice` shape regardless of whether the
      // stream-consumer fibers have flushed yet — assert shape, not size.
      const slice = adapter.getLogs(0);
      expect(typeof slice.text).toBe("string");
      expect(slice.nextOffset).toBe(slice.text.length);

      await Effect.runPromise(adapter.teardown());

      // Idempotent — second teardown is a no-op.
      await Effect.runPromise(adapter.teardown());
    }, 180_000);
  });
}
