/** @file Built native commands run with an isolated packed Client closure, without a source checkout or another npm product. */

import { Effect, Schema } from "effect";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageNativePlugins } from "./package-native-plugins.ts";
import {
  installPackedConsumer,
  packWorkspaceClosure,
  readJsonFile,
  requireCondition,
  runGate,
} from "./test/packed-workspace.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeSourceManifest = Schema.Struct({
  dependencies: Schema.Record({ key: Schema.String, value: Schema.String }),
});
const coreRoots = {
  "@moltzap/client": join(workspaceRoot, "packages/client"),
  "@moltzap/identity": join(workspaceRoot, "packages/identity"),
  "@moltzap/router": join(workspaceRoot, "packages/router"),
};

runGate("moltzap-native-assets-", (temporaryRoot) =>
  Effect.gen(function* () {
    const { archives } = yield* packWorkspaceClosure(
      coreRoots,
      temporaryRoot,
      new Set(Object.keys(coreRoots)),
    );
    const nativeManifest = yield* readJsonFile(
      join(workspaceRoot, "plugins/package.json"),
      nativeSourceManifest,
    );
    const first = yield* packageNativePlugins(
      workspaceRoot,
      join(temporaryRoot, "first"),
    );
    const second = yield* packageNativePlugins(
      workspaceRoot,
      join(temporaryRoot, "second"),
    );
    yield* requireCondition(
      first.sha256 === second.sha256,
      "native archive is not reproducible",
    );
    const consumerRoot = yield* installPackedConsumer({
      temporaryRoot,
      workspaceRoot,
      name: "native-assets-consumer",
      archives: { ...archives, "@moltzap/native-plugins": first.archive },
      dependencies: Object.fromEntries(
        Object.entries(nativeManifest.dependencies).filter(
          ([name]) => name !== "@moltzap/client",
        ),
      ),
    });
    yield* verifyEntrypoint(consumerRoot);
    yield* verifyInstallPrompts(consumerRoot);
    return "native assets: reproducible archive, isolated receive command and install prompts passed; native installation and publication remain unqualified";
  }),
);

/**
 * The public receive command must reach its closed configuration failure
 * through the packed runtime. Only synthetic configuration reaches this child;
 * a failure reports its bounded output and process outcome, never ambient env.
 */
function verifyEntrypoint(consumerRoot: string) {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ["node_modules/@moltzap/native-plugins/bin/receive.mjs"],
    {
      cwd: consumerRoot,
      env: {
        MOLTZAP_NATIVE_PLATFORM: "instinct",
        MOLTZAP_MCP_URL: "http://remote.example/mcp",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return requireCondition(
    result.status === 1 &&
      output.includes("invalid-configuration") &&
      !output.includes("ERR_MODULE_NOT_FOUND"),
    `isolated native entrypoint did not fail closed through its real built runtime:\n${describeChild(result, performance.now() - started)}`,
  );
}

/**
 * Public prompt commands render without reading owner configuration. These
 * checks exercise output and argument refusal, not the documents' wording.
 */
function verifyInstallPrompts(consumerRoot: string) {
  return Effect.gen(function* () {
    for (const platform of ["muse", "instinct", "grokbot", "openclaw", "dot"]) {
      yield* verifyInstallPrompt(consumerRoot, platform);
    }
    for (const args of [[], ["nanoclaw"], ["../private"], ["dot", "extra"]]) {
      const started = performance.now();
      const result = renderInstallPrompt(consumerRoot, args);
      yield* requireCondition(
        result.status === 64 &&
          result.stdout === "" &&
          !result.stderr.includes("fixture-private-credential-must-not-appear"),
        `install prompt must refuse unknown, extra or path-like arguments:\n${describeChild(result, performance.now() - started)}`,
      );
    }
  });
}

function verifyInstallPrompt(consumerRoot: string, platform: string) {
  const started = performance.now();
  const result = renderInstallPrompt(consumerRoot, [platform]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return requireCondition(
    result.status === 0 &&
      result.stdout.trim().length > 0 &&
      !output.includes("fixture-private-credential-must-not-appear") &&
      !output.includes("ERR_MODULE_NOT_FOUND"),
    `isolated install prompt failed or disclosed authority (${platform}):\n${describeChild(result, performance.now() - started)}`,
  );
}

function renderInstallPrompt(consumerRoot: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["node_modules/@moltzap/native-plugins/bin/install-prompt.mjs", ...args],
    {
      cwd: consumerRoot,
      env: {
        MOLTZAP_MCP_CREDENTIAL: "fixture-private-credential-must-not-appear",
      },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
}

/** Synthetic child diagnostics stay bounded even when its captured output is not. */
function describeChild(result: SpawnSyncReturns<string>, elapsedMs: number) {
  return JSON.stringify(
    {
      elapsedMs: Math.round(elapsedMs),
      status: result.status,
      signal: result.signal,
      error:
        result.error === undefined
          ? null
          : {
              name: result.error.name,
              message: result.error.message,
              code: "code" in result.error ? result.error.code : null,
            },
      stdoutBytes: Buffer.byteLength(result.stdout ?? ""),
      stderrBytes: Buffer.byteLength(result.stderr ?? ""),
      stdout: (result.stdout ?? "").slice(0, 8192),
      stderr: (result.stderr ?? "").slice(0, 8192),
    },
    null,
    2,
  );
}
