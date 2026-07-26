/**
 * @file The per-run server image is pinned by two files, and
 * `launcher-live.ts` launches against what they say: the container port
 * it publishes, the `/data` mount it bind-mounts, the PGlite directory
 * the transcript drain reads under it, the open registration its identity
 * provisioning needs, and the absent encryption secret that keeps message
 * content readable at rest. Asserting against the launcher's own
 * constants is what makes these two files one contract instead of two
 * copies that drift.
 */
// @agent-code-guard/regression-only: the subject is two fixed configuration files, so every assertion is an example by construction; the generative gate for this row lives in receiver-bind.test.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVER_CONTAINER_PORT,
  SERVER_DATA_MOUNT,
  SERVER_PGLITE_DIR,
} from "./launcher-live.js";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const imageDir = join(packageRoot, "server-image");

const config = readFileSync(join(imageDir, "moltzap.yaml"), "utf8");
const dockerfile = readFileSync(join(imageDir, "Dockerfile"), "utf8");

/** Config lines with comments and indentation stripped, in file order. */
const configLines = config
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

describe("simulator server image", () => {
  it("pins the PGlite data directory where the drain reads it", () => {
    expect(configLines).toContain(
      `data_dir: ${SERVER_DATA_MOUNT}/${SERVER_PGLITE_DIR}`,
    );
    expect(dockerfile).toContain(`VOLUME ["${SERVER_DATA_MOUNT}"]`);
  });

  it("names the boot admin the server requires", () => {
    // The absence assertions below pass on an empty file; this one does
    // not, so a gutted config fails the suite instead of reading as
    // "nothing forbidden is present".
    const adminUserId = configLines.find((line) =>
      line.startsWith("admin_user_id:"),
    );
    expect(adminUserId).toMatch(
      /^admin_user_id: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("carries no at-rest encryption secret, so the drain can read messages", () => {
    expect(configLines.some((line) => line.startsWith("encryption:"))).toBe(
      false,
    );
    expect(configLines.some((line) => line.startsWith("master_secret:"))).toBe(
      false,
    );
  });

  it("leaves registration open, so the launcher can mint per-run identities", () => {
    expect(configLines.some((line) => line.startsWith("registration:"))).toBe(
      false,
    );
  });

  it("serves the container port the launcher publishes", () => {
    expect(configLines).toContain(`port: ${String(SERVER_CONTAINER_PORT)}`);
    expect(dockerfile).toContain(`EXPOSE ${String(SERVER_CONTAINER_PORT)}`);
  });

  it("runs the @moltzap/server-core bin", () => {
    expect(dockerfile).toMatch(
      /^ENTRYPOINT \[.*@moltzap\/server-core\/bin\/moltzap-server.*\]$/m,
    );
  });
});
