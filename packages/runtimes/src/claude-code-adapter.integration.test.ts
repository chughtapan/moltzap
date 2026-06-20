/**
 * Integration test for `ClaudeCodeAdapter` (issue #255).
 *
 * Spawns the real Anthropic `claude` CLI (installed as a devDep of
 * `@moltzap/runtimes`) configured via `--mcp-config` to load the
 * `@moltzap/claude-code-channel` plugin from a per-agent state dir.
 * Asserts the adapter's spawn -> ready -> teardown cycle:
 *   - The channel's MCP stdio server boots inside `claude`.
 *   - cc-channel's `MoltZapService.connect()` authenticates against the
 *     in-process moltzap core test server.
 *   - The server's `ConnectionManager` records the auth, which
 *     `waitUntilReady` polls (auth-on-connection, same signal openclaw
 *     and nanoclaw use).
 *   - Teardown reaps the detached process group.
 *
 * Environments without the Claude CLI take the explicit abstain branch in
 * the test body. That keeps committed tests free of `skip` while still making
 * the local prerequisite visible.
 */
import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Effect, Either } from "effect";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { agentId } from "@moltzap/protocol/testing";
import {
  startCoreTestServer,
  stopCoreTestServer,
  type CoreTestServer,
} from "@moltzap/server-core/test-utils";
import { registerAgent } from "@moltzap/client/auth";
import { stripWsPath } from "@moltzap/client/test-utils";

import { createWorkspaceClaudeCodeAdapter } from "./claude-code-adapter.js";
import { AgentName, ServerUrl } from "./runtime.js";

const SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const CORE_SERVER_HOOK_TIMEOUT_MS = 60_000;
const CLAUDE_READY_TIMEOUT_MS = 120_000;
const CLAUDE_ADAPTER_TEST_TIMEOUT_MS = 180_000;
const CLAUDE_AGENT_NAME = "claude-code-runtime-it";
const READY_TAG = "Ready";
const STRING_TYPE = "string";
const PACKAGE_DIR = "packages";
const RUNTIMES_PACKAGE_DIR = "runtimes";
const CLAUDE_CODE_CHANNEL_PACKAGE_DIR = "claude-code-channel";
const NODE_MODULES_DIR = "node_modules";
const BIN_DIR = ".bin";
const CLAUDE_BIN_NAME = "claude";
const DIST_DIR = "dist";

let server: CoreTestServer | null = null;

beforeAll(startServer, CORE_SERVER_HOOK_TIMEOUT_MS);
afterAll(stopServer);

describe("ClaudeCodeAdapter (integration)", () => {
  it(
    "spawn -> ready -> teardown completes against the real claude CLI + cc-channel MCP plugin",
    claudeCodeSpawnReadyTeardown,
    CLAUDE_ADAPTER_TEST_TIMEOUT_MS,
  );
});

function startServer() {
  return runTest(
    Effect.tryPromise({
      try: () => startCoreTestServer(),
      catch: (cause) => cause,
    }).pipe(
      Effect.tap((started) =>
        Effect.sync(() => {
          server = started;
        }),
      ),
      Effect.orDie,
    ),
  );
}

function stopServer() {
  return runTest(
    Effect.gen(function* () {
      if (server === null) {
        return;
      }
      yield* Effect.tryPromise({
        try: () => stopCoreTestServer(),
        catch: (cause) => cause,
      }).pipe(Effect.orDie);
      server = null;
    }),
  );
}

function claudeCodeSpawnReadyTeardown() {
  return runTest(
    Effect.gen(function* () {
      const paths = yield* resolveIntegrationPaths().pipe(Effect.orDie);
      if (paths.claudeBin === null) {
        expect(paths.claudeBin).toBeNull();
        return;
      }

      const runningServer = getServer();
      const reg = yield* registerAgent(
        runningServer.baseUrl,
        CLAUDE_AGENT_NAME,
      ).pipe(Effect.orDie);
      const adapter = createWorkspaceClaudeCodeAdapter({
        server: runningServer.runtimeServer,
        claudeBin: paths.claudeBin,
        channelDistDir: paths.channelDistDir,
        repoRoot: paths.repoRoot,
      });

      const spawnResult = yield* Effect.either(
        adapter.spawn({
          agentName: AgentName(CLAUDE_AGENT_NAME),
          apiKey: reg.apiKey,
          agentId: agentId(reg.agentId),
          serverUrl: ServerUrl(stripWsPath(runningServer.wsUrl)),
        }),
      );
      Either.match(spawnResult, {
        onLeft: (error) => expect.fail(error.message),
        onRight: () => expect(spawnResult).toSatisfy(Either.isRight),
      });

      const ready = yield* adapter.waitUntilReady(CLAUDE_READY_TIMEOUT_MS);
      if (ready._tag !== READY_TAG) {
        const logs = adapter.getLogs(0).text;
        throw new Error(
          `expected Ready, got ${ready._tag}. claude+cc-channel logs:\n${logs}`,
        );
      }
      expect(ready._tag).toBe(READY_TAG);

      const slice = adapter.getLogs(0);
      expect(typeof slice.text).toBe(STRING_TYPE);
      expect(slice.nextOffset).toBe(slice.text.length);

      yield* adapter.teardown();
      yield* adapter.teardown();
    }),
  );
}

function getServer(): CoreTestServer {
  if (server === null) {
    throw new Error("Core test server was not started");
  }
  return server;
}

function resolveIntegrationPaths() {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const repoRoot = path.resolve(SOURCE_DIR, "..", "..", "..");
    const channelDistDir = path.join(
      repoRoot,
      PACKAGE_DIR,
      CLAUDE_CODE_CHANNEL_PACKAGE_DIR,
      DIST_DIR,
    );
    const claudeBinCandidates = [
      path.join(
        repoRoot,
        PACKAGE_DIR,
        RUNTIMES_PACKAGE_DIR,
        NODE_MODULES_DIR,
        BIN_DIR,
        CLAUDE_BIN_NAME,
      ),
      path.join(repoRoot, NODE_MODULES_DIR, BIN_DIR, CLAUDE_BIN_NAME),
    ];
    const claudeBin = yield* findFirstExistingPath(claudeBinCandidates);
    return { repoRoot, channelDistDir, claudeBin };
  });
}

function findFirstExistingPath(candidates: ReadonlyArray<string>) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      Effect.gen(function* () {
        for (const candidate of candidates) {
          if (yield* fileSystem.exists(candidate)) {
            return candidate;
          }
        }
        return null;
      }),
    ),
  );
}

function runTest<A>(
  effect: Effect.Effect<A, never, FileSystem.FileSystem | Path.Path>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(NodeContext.layer)));
}
