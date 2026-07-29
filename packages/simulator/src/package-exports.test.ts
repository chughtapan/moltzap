import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as customerApi from "./index.js";
import * as ledgerApi from "./ledger.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadPackageExports(): Record<string, unknown> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(here, "../package.json");
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed["exports"])) {
    return {};
  }
  return parsed["exports"];
}

// @agent-code-guard/regression-only: exact package surfaces are finite compatibility and privilege boundaries
describe("@moltzap/simulator package exports", () => {
  it("publishes exactly the customer, network, and ledger surfaces", () => {
    expect(loadPackageExports()).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./network": {
        types: "./dist/network.d.ts",
        import: "./dist/network.js",
      },
      "./ledger": {
        types: "./dist/ledger.d.ts",
        import: "./dist/ledger.js",
      },
    });
  });

  it("keeps platform-authoring values off the experiment root", () => {
    expect(Object.keys(customerApi)).not.toEqual(
      expect.arrayContaining([
        "AgentRoster",
        "LinkDriver",
        "RouterProvider",
        "RouterStopped",
        "makeAgentHandle",
        "makeParticipantHandle",
        "makeRouterStopReport",
        "networkFailure",
      ]),
    );
  });

  it("keeps run-ledger construction and producer writers inside the kernel", () => {
    expect(ledgerApi).not.toHaveProperty("makeRunLedger");
  });

  it("exposes one definition constructor through Simulator", () => {
    expect(customerApi).not.toHaveProperty("defineSimulator");
    expect(customerApi.Simulator).toHaveProperty("define");
  });
});
