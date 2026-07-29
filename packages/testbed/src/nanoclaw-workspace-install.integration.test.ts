import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Config, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ensureNanoclawRuntimeInstalledEffect } from "./nanoclaw-install.js";

const CLIENT_PACKAGE_NAME = "@moltzap/client";
const PROTOCOL_PACKAGE_NAME = "@moltzap/protocol";
const FILE_VENDOR_PREFIX = "file:vendor/";
const WORKSPACE_INSTALL_TEST_TIMEOUT_MS = 1_500_000;
const REGISTRY_MOLTZAP_PATTERN = /registry\.npmjs\.org\/@moltzap(?:\/|%2f)/i;
const EXPECTED_MOLTZAP_LOCK_KEYS = [
  `node_modules/${CLIENT_PACKAGE_NAME}`,
  `node_modules/${PROTOCOL_PACKAGE_NAME}`,
].sort();

const NANOCLAW_INSTALL_INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_NANOCLAW_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);

describe.skipIf(!NANOCLAW_INSTALL_INTEGRATION_ENABLED)(
  "NanoClaw real workspace install",
  () => {
    it(
      "uses only the two workspace MoltZap tarballs",
      verifiesWorkspaceInstallLock,
      WORKSPACE_INSTALL_TEST_TIMEOUT_MS,
    );
  },
);

function verifiesWorkspaceInstallLock() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const install = yield* ensureNanoclawRuntimeInstalledEffect("workspace");
      const fileSystem = yield* FileSystem.FileSystem;
      const lockText = yield* fileSystem.readFileString(
        join(install.cacheDir, "package-lock.json"),
        "utf8",
      );
      expect(lockText).not.toMatch(REGISTRY_MOLTZAP_PATTERN);

      const parsed: unknown = JSON.parse(lockText);
      const lock = requireRecord(parsed);
      const packages = requireRecord(lock.packages);
      const root = requireRecord(packages[""]);
      const rootDependencies = requireRecord(root.dependencies);
      expect(rootDependencies[CLIENT_PACKAGE_NAME]).toMatch(FILE_VENDOR_PREFIX);
      expect(rootDependencies[PROTOCOL_PACKAGE_NAME]).toMatch(
        FILE_VENDOR_PREFIX,
      );
      const moltzapKeys = Object.keys(packages)
        .filter((location) => location.includes("node_modules/@moltzap/"))
        .sort();
      expect(moltzapKeys).toEqual(EXPECTED_MOLTZAP_LOCK_KEYS);
      for (const location of moltzapKeys) {
        const entry = requireRecord(packages[location]);
        expect(entry.resolved).toMatch(FILE_VENDOR_PREFIX);
      }
    }).pipe(Effect.provide(NodeContext.layer)),
  );
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error("Expected NanoClaw package lock object");
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
