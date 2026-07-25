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

describe("@moltzap/testbed package exports", () => {
  it("publishes exactly the root surface, the simulator, and the grader", () => {
    const exports = loadPackageExports();

    expect(exports).toEqual({
      ".": {
        import: "./dist/index.js",
        types: "./dist/index.d.ts",
      },
      "./simulator": {
        import: "./dist/simulator/index.js",
        types: "./dist/simulator/index.d.ts",
      },
      "./grader": {
        import: "./dist/grader.js",
        types: "./dist/grader.d.ts",
      },
    });
  });

  it("keeps every consumer-specific adapter out of the export map", () => {
    const entries = Object.keys(loadPackageExports());

    // The compat adapters ship as dist files a plan can point at by path.
    // Naming one in the export map would put a consumer's name on the
    // instrument's published surface, which is the line `./grader` exists
    // to hold: generic surface is exported, grader-shaped surface is not.
    for (const entry of entries) {
      expect(entry).not.toMatch(/cc-judge|trace-capture/u);
    }
  });
});
