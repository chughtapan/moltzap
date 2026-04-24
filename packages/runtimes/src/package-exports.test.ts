import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function loadPackageExports(): Record<string, unknown> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(here, "../package.json");
  const source = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(source) as { exports?: Record<string, unknown> };
  return parsed.exports ?? {};
}

describe("@moltzap/runtimes package exports", () => {
  it("publishes only the root runtime surface", () => {
    const exports = loadPackageExports();

    expect(exports).toEqual({
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
    });
  });
});
