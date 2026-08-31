/** @file Pins the finite package map and runtime half of each public API census. */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as runtimeApi from "./agents/index.js";
import * as customerApi from "./index.js";
import * as ledgerApi from "./ledger/index.js";
import * as networkApi from "./network/index.js";

interface FacadeCensus {
  readonly declaration: string;
  readonly runtime: readonly string[];
  readonly types: readonly string[];
}

type SimulatorFacade = "." | "./network" | "./ledger" | "./agents";

function loadPackageExports(): Record<string, unknown> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = path.join(here, "../package.json");
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.exports)) {
    return {};
  }
  return parsed.exports;
}

function loadApiCensus(): Readonly<Record<SimulatorFacade, FacadeCensus>> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const censusPath = path.join(here, "../api-census.json");
  const parsed: unknown = JSON.parse(readFileSync(censusPath, "utf8"));
  if (!isRecord(parsed) || parsed.schemaVersion !== 3) {
    throw new TypeError("simulator API census has an unsupported shape");
  }
  const { facades } = parsed;
  if (!isRecord(facades)) {
    throw new TypeError("simulator API census has an unsupported shape");
  }
  return Object.freeze({
    ".": readFacade(facades, "."),
    "./network": readFacade(facades, "./network"),
    "./ledger": readFacade(facades, "./ledger"),
    "./agents": readFacade(facades, "./agents"),
  });
}

function readFacade(
  facades: Record<string, unknown>,
  subpath: SimulatorFacade,
): FacadeCensus {
  const facade = facades[subpath];
  if (!isRecord(facade) || typeof facade.declaration !== "string") {
    throw new TypeError(`simulator API census is missing ${subpath}`);
  }
  return Object.freeze({
    declaration: facade.declaration,
    runtime: stringArray(facade.runtime, `${subpath}.runtime`),
    types: stringArray(facade.types, `${subpath}.types`),
  });
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError(`simulator API census ${field} must be a string array`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const apiCensus = loadApiCensus();

function uniqueExportCount(facade: FacadeCensus): number {
  return new Set([...facade.runtime, ...facade.types]).size;
}

function sortedNames(values: readonly string[]): readonly string[] {
  return [...values].sort(compareNames);
}

function compareNames(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

// @agent-code-guard/regression-only: exact package surfaces are finite dependency and privilege boundaries
describe("@moltzap/simulator package map", () => {
  it("publishes exactly the customer, network, ledger, and agents surfaces", () => {
    expect(loadPackageExports()).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./network": {
        types: "./dist/network/index.d.ts",
        import: "./dist/network/index.js",
      },
      "./ledger": {
        types: "./dist/ledger/index.d.ts",
        import: "./dist/ledger/index.js",
      },
      "./agents": {
        types: "./dist/agents/index.d.ts",
        import: "./dist/agents/index.js",
      },
    });
  });

  it("pins the current declaration-space census", () => {
    for (const facade of Object.values(apiCensus)) {
      expect(facade.runtime).toEqual(sortedNames(facade.runtime));
      expect(facade.types).toEqual(sortedNames(facade.types));
    }
    expect({
      root: {
        unique: uniqueExportCount(apiCensus["."]),
        runtime: apiCensus["."].runtime.length,
        types: apiCensus["."].types.length,
      },
      network: {
        unique: uniqueExportCount(apiCensus["./network"]),
        runtime: apiCensus["./network"].runtime.length,
        types: apiCensus["./network"].types.length,
      },
      ledger: uniqueExportCount(apiCensus["./ledger"]),
      agents: uniqueExportCount(apiCensus["./agents"]),
    }).toEqual({
      root: { unique: 58, runtime: 38, types: 53 },
      network: { unique: 32, runtime: 16, types: 25 },
      ledger: 40,
      agents: 45,
    });
  });
});

describe("@moltzap/simulator/network package export", () => {
  it("publishes exactly the current network runtime values", () => {
    expect(sortedNames(Object.keys(networkApi))).toEqual(
      sortedNames(apiCensus["./network"].runtime),
    );
  });
});

describe("@moltzap/simulator root export", () => {
  it("publishes exactly the current experiment runtime values", () => {
    expect(sortedNames(Object.keys(customerApi))).toEqual(
      sortedNames(apiCensus["."].runtime),
    );
  });

  it("keeps cluster-authoring values off the experiment root", () => {
    expect(Object.keys(customerApi)).not.toEqual(
      expect.arrayContaining([
        "AgentRoster",
        "effectRuntime",
        "nanoclawRuntime",
        "openClawRuntime",
      ]),
    );
    expect(
      Object.keys(customerApi).filter(
        (name) =>
          name !== "LinkController" &&
          (/platform|kubernetes|k8s|kueue|temporal|sandbox|fake/iu.test(name) ||
            name.endsWith("Controller")),
      ),
    ).toEqual([]);
  });

  it("exposes RunSpec as the only execution entry point", () => {
    expect(customerApi).not.toHaveProperty("defineSimulator");
    expect(customerApi).not.toHaveProperty("defineRunSpec");
    expect(customerApi).not.toHaveProperty("executeRunSpec");
    expect(customerApi).not.toHaveProperty("simulator");
    expect(customerApi).not.toHaveProperty("simulatorLayer");
    expect(customerApi.RunSpec).toHaveProperty("define");
    expect(customerApi.Run).toHaveProperty("execute");
    expect(customerApi).toHaveProperty("ClusterError");
  });
});

describe("@moltzap/simulator/ledger package export", () => {
  it("publishes exactly the current ledger runtime values", () => {
    expect(sortedNames(Object.keys(ledgerApi))).toEqual(
      sortedNames(apiCensus["./ledger"].runtime),
    );
  });

  it("keeps run-ledger construction and producer writers inside the kernel", () => {
    expect(ledgerApi).not.toHaveProperty("makeRunLedger");
  });
});

describe("@moltzap/simulator/agents package export", () => {
  it("publishes exactly the current agent runtime values", () => {
    expect(sortedNames(Object.keys(runtimeApi))).toEqual(
      sortedNames(apiCensus["./agents"].runtime),
    );
  });

  it("publishes container runtime definitions and shipped implementations", () => {
    expect([
      typeof runtimeApi.defineContainerRuntime,
      typeof runtimeApi.nanoclawRuntime,
      typeof runtimeApi.openClawRuntime,
    ]).toEqual(["function", "function", "function"]);
    expect(runtimeApi).not.toHaveProperty("defineRuntime");
    expect(runtimeApi).not.toHaveProperty("effectRuntime");
  });
});
