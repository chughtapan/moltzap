import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { loadRuntimeProcessConfig } from "./config.js";

/**
 * Regression: `withPatchedProcessEnv(processEnv, …)` was called with
 * `processEnv === process.env` from `loadRuntimeProcessConfig`. The previous
 * implementation deleted every key from `process.env` and then iterated
 * `Object.entries(next)` over the now-empty same reference — leaving
 * `process.env` empty for the duration of the YAML load. Compose-style
 * `${VAR}` interpolation in moltzap.yaml then reported the var missing
 * even when it was set in the container's env.
 *
 * This test pins the fix: passing `process.env` directly must preserve every
 * key both during the load (so YAML interpolation works) and after.
 */

let tmpDir: string;
const ENV_KEY = "MOLTZAP_TEST_PATCH_KEY";
const ENV_VALUE = "regression-352-value";
const TOUCHED_KEYS = [ENV_KEY, "MOLTZAP_DEV_MODE"] as const;
let savedEnv: Map<string, string | undefined>;

function writeYaml(path: string, body: string): void {
  writeFileSync(path, body, "utf-8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "moltzap-runtime-config-"));
  // Save prior values so afterEach restores rather than blindly deletes —
  // otherwise we could erase a caller-provided env value or leak across
  // tests that share these keys.
  savedEnv = new Map(TOUCHED_KEYS.map((k) => [k, process.env[k]]));
  process.env[ENV_KEY] = ENV_VALUE;
  process.env["MOLTZAP_DEV_MODE"] = "true";
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  for (const key of TOUCHED_KEYS) {
    const prior = savedEnv.get(key);
    if (prior === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prior;
    }
  }
});

describe("loadRuntimeProcessConfig — env patching", () => {
  it("does not lose keys when processEnv === process.env (regression #352)", async () => {
    const configPath = join(tmpDir, "moltzap.yaml");
    writeYaml(configPath, `registration:\n  secret: \${${ENV_KEY}}\n`);

    const beforeKeys = Object.keys(process.env).length;

    const result = await Effect.runPromise(
      loadRuntimeProcessConfig({
        configPath: configPath as Parameters<
          typeof loadRuntimeProcessConfig
        >[0]["configPath"],
        // Critical: same reference as process.env reproduces the bug.
        processEnv: process.env,
      }),
    );

    expect(result.app.registration?.secret).toBe(ENV_VALUE);
    // process.env survives the load (no keys lost).
    expect(process.env[ENV_KEY]).toBe(ENV_VALUE);
    expect(Object.keys(process.env).length).toBe(beforeKeys);
  });

  it("still works when processEnv is a separate snapshot", async () => {
    const configPath = join(tmpDir, "moltzap.yaml");
    writeYaml(configPath, `registration:\n  secret: \${${ENV_KEY}}\n`);

    // Spread to break reference identity with process.env.
    const snapshot = { ...process.env };
    const result = await Effect.runPromise(
      loadRuntimeProcessConfig({
        configPath: configPath as Parameters<
          typeof loadRuntimeProcessConfig
        >[0]["configPath"],
        processEnv: snapshot,
      }),
    );

    expect(result.app.registration?.secret).toBe(ENV_VALUE);
    expect(process.env[ENV_KEY]).toBe(ENV_VALUE);
  });
});
