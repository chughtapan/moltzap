import { describe, expect, it } from "vitest";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const packageJsonPath = path.join(packageRoot, "package.json");

describe("@moltzap/server-core package metadata", () => {
  it("publishes a single executable bin for npx invocation", async () => {
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
      bin?: Record<string, string>;
      files?: string[];
    };

    expect(packageJson.files).toContain("bin");
    expect(packageJson.files).toContain("src/app/core-schema.sql");
    expect(packageJson.bin).toEqual({
      "moltzap-server": "bin/moltzap-server",
    });

    await access(path.join(packageRoot, "bin/moltzap-server"), constants.X_OK);
    await access(
      path.join(packageRoot, "src/app/core-schema.sql"),
      constants.R_OK,
    );
  });
});
