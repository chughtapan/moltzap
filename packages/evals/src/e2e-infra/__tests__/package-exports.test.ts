import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function loadPackageExports(): Record<string, unknown> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(here, "../../../package.json");
  const source = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(source) as { exports?: Record<string, unknown> };
  return parsed.exports ?? {};
}

describe("@moltzap/evals package exports", () => {
  it("does not expose deprecated eval runtime subpaths", () => {
    const exports = loadPackageExports();

    expect(exports).not.toHaveProperty("./agent-fleet");
    expect(exports).not.toHaveProperty("./nanoclaw-manager");
    expect(exports).not.toHaveProperty("./nanoclaw-smoke");
    expect(exports).not.toHaveProperty("./llm-judge");
    expect(exports).not.toHaveProperty("./report");
  });
});
