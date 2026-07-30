/**
 * @file The MoltZap server image and `server.ts` share one
 * contract: container port, durable mount, PGlite location, identity
 * registration posture, readable traffic storage, and published build inputs.
 * These assertions keep the image assets aligned with the code that launches
 * them.
 */
// @agent-code-guard/regression-only: the subject is one fixed image contract, so every assertion is an example by construction
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVER_CONTAINER_PORT,
  SERVER_DATA_MOUNT,
  SERVER_REGISTRATION_SECRET_ENV,
} from "./server-image.js";
import { SERVER_PGLITE_DIR } from "./message-store.js";

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const imageDir = join(packageRoot, "server-image");

const config = readFileSync(join(imageDir, "moltzap.yaml"), "utf8");
const dockerfile = readFileSync(join(imageDir, "Dockerfile"), "utf8");
const packageManifest =
  /* Safe because the test fixture establishes this asserted shape. */ JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly files?: readonly string[];
  };
const REGISTRATION_CONFIG_BLOCK = "registration:";
const REGISTRATION_SECRET_CONFIG = `secret: "\${${SERVER_REGISTRATION_SECRET_ENV}}"`;
const EXACT_WORKSPACE_DEPENDENCY = "workspace:*";

/** Config lines with comments and indentation stripped, in file order. */
const configLines = config
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

describe("simulator server image", () => {
  it("pins the PGlite data directory where traffic reconciliation reads it", () => {
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

  it("carries no at-rest encryption secret, so reconciliation can read messages", () => {
    expect(configLines.some((line) => line.startsWith("encryption:"))).toBe(
      false,
    );
    expect(configLines.some((line) => line.startsWith("master_secret:"))).toBe(
      false,
    );
  });

  it("requires the launcher's per-run secret for identity registration", () => {
    expect(configLines).toContain(REGISTRATION_CONFIG_BLOCK);
    expect(configLines).toContain(REGISTRATION_SECRET_CONFIG);
  });

  it("serves the container port the MoltZap server publishes", () => {
    expect(configLines).toContain(`port: ${String(SERVER_CONTAINER_PORT)}`);
    expect(dockerfile).toContain(`EXPOSE ${String(SERVER_CONTAINER_PORT)}`);
  });

  it("runs the @moltzap/server-core bin", () => {
    expect(dockerfile).toMatch(
      /^ENTRYPOINT \[.*@moltzap\/server-core\/bin\/moltzap-server.*\]$/m,
    );
  });

  it("publishes every build input with the exact server package", () => {
    expect(packageManifest.files).toEqual(
      expect.arrayContaining([
        "scripts/build-server-image.mjs",
        "server-image",
      ]),
    );
    expect(packageManifest.dependencies?.["@moltzap/server-core"]).toBe(
      EXACT_WORKSPACE_DEPENDENCY,
    );
  });
});
