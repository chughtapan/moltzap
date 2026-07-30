import { basename, join } from "node:path";
import { Command, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Config, Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  ensureNanoclawRuntimeInstalledEffect,
  findWarmNanoclawRuntimeInstallEffect,
} from "./install.js";

const PUBLISHED_INSTALL_MODE = "published";
const CACHE_GENERATION_PREFIX = "generation-";
const READY_MARKER = ".ready";
const DOCKER_COMMAND = "docker";
const DOCKER_IMAGE_SUBCOMMAND = "image";
const DOCKER_INSPECT_SUBCOMMAND = "inspect";
const SUCCESS_EXIT_CODE = 0;

// The no-process-env-at-runtime guard applies to test files, so the gate
// reads the flag through Config under the default env-backed provider.
const NANOCLAW_INSTALL_INTEGRATION_ENABLED = Effect.runSync(
  Config.string("MOLTZAP_NANOCLAW_ITEST").pipe(
    Config.withDefault("0"),
    Config.map((value) => value === "1"),
  ),
);

describe.skipIf(!NANOCLAW_INSTALL_INTEGRATION_ENABLED)(
  "NanoClaw real install cache",
  () => {
    it(
      "reuses a fingerprint-matched generation with its existing image",
      reusesWarmInstall,
    );
  },
);

function reusesWarmInstall() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const warmCandidate = yield* findWarmNanoclawRuntimeInstallEffect(
        PUBLISHED_INSTALL_MODE,
      );
      expect(warmCandidate).not.toBeNull();
      if (warmCandidate === null) {
        return;
      }

      const fileSystem = yield* FileSystem.FileSystem;
      const readyFingerprint = yield* fileSystem.readFileString(
        join(warmCandidate.cacheDir, READY_MARKER),
        "utf8",
      );
      expect(readyFingerprint).toBe(warmCandidate.cacheFingerprint);
      expect(
        basename(warmCandidate.cacheDir).startsWith(CACHE_GENERATION_PREFIX),
      ).toBeTruthy();

      const imageExitCode = yield* Command.exitCode(
        Command.make(
          DOCKER_COMMAND,
          DOCKER_IMAGE_SUBCOMMAND,
          DOCKER_INSPECT_SUBCOMMAND,
          warmCandidate.containerImage,
        ),
      );
      expect(Number(imageExitCode)).toBe(SUCCESS_EXIT_CODE);

      const firstInstall = yield* ensureNanoclawRuntimeInstalledEffect(
        PUBLISHED_INSTALL_MODE,
      );
      expect(firstInstall).toEqual(warmCandidate);
      const secondInstall = yield* ensureNanoclawRuntimeInstalledEffect(
        PUBLISHED_INSTALL_MODE,
      );
      expect(secondInstall).toBe(firstInstall);
    }).pipe(Effect.provide(NodeContext.layer)),
  );
}
