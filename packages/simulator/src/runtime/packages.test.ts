/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function -- Regression-only package-resolution cases share one isolated module-layout fixture and stay grouped at the resolution boundary. */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveInstalledPackageBin } from "./packages.js";

const SCOPED_PACKAGE_NAME = "@moltzap-test/resolved";
const DECOY_MANIFEST_NAME = "some-other-package";
const MISSING_PACKAGE_NAME = "@moltzap-test/definitely-missing";
const SERVER_PACKAGE_NAME = "@moltzap/server-core";
const SERVER_BIN_NAME = "moltzap-server";
const TEST_BIN_NAME = "test-server";
const TEST_BIN_PATH = "bin/test-server";
const fixtureRoot = mkdtempSync(join(tmpdir(), "package-bin-resolution-test-"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writePackage(root: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(root, TEST_BIN_PATH), "");
}

function seedConsumer(
  fixtureName: string,
  manifest: Record<string, unknown>,
): { readonly anchor: string; readonly packageRoot: string } {
  const consumerRoot = join(fixtureRoot, fixtureName);
  const anchor = join(consumerRoot, "package.json");
  const packageRoot = join(consumerRoot, "node_modules", SCOPED_PACKAGE_NAME);
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(
    anchor,
    JSON.stringify({ name: `package-resolution-${fixtureName}` }),
  );
  writePackage(packageRoot, manifest);
  return { anchor, packageRoot };
}

function seedLayeredConsumer(
  fixtureName: string,
  nearestManifest: string,
): { readonly anchor: string; readonly packageRoot: string } {
  const fixtureDirectory = join(fixtureRoot, fixtureName);
  const consumerRoot = join(fixtureDirectory, "consumer");
  const anchor = join(consumerRoot, "package.json");
  const nearestPackageRoot = join(
    consumerRoot,
    "node_modules",
    SCOPED_PACKAGE_NAME,
  );
  const packageRoot = join(
    fixtureDirectory,
    "node_modules",
    SCOPED_PACKAGE_NAME,
  );
  mkdirSync(nearestPackageRoot, { recursive: true });
  mkdirSync(consumerRoot, { recursive: true });
  writeFileSync(
    anchor,
    JSON.stringify({ name: `package-resolution-${fixtureName}` }),
  );
  writeFileSync(join(nearestPackageRoot, "package.json"), nearestManifest);
  writePackage(packageRoot, {
    name: SCOPED_PACKAGE_NAME,
    bin: { [TEST_BIN_NAME]: TEST_BIN_PATH },
  });
  return { anchor, packageRoot };
}

function expectedTestBinary(packageRoot: string): string {
  return realpathSync(join(packageRoot, TEST_BIN_PATH));
}

// @agent-code-guard/regression-only: seeded module layouts exercise the production router's Node package-resolution boundary
describe("resolveInstalledPackageBin", () => {
  it("resolves a declared binary from the supplied anchor", () => {
    const fixture = seedConsumer("anchored", {
      name: SCOPED_PACKAGE_NAME,
      bin: { [TEST_BIN_NAME]: TEST_BIN_PATH },
    });

    expect(
      realpathSync(
        resolveInstalledPackageBin(
          SCOPED_PACKAGE_NAME,
          TEST_BIN_NAME,
          fixture.anchor,
        ),
      ),
    ).toBe(expectedTestBinary(fixture.packageRoot));
  });

  it("resolves metadata hidden by an exports map", () => {
    const fixture = seedConsumer("export-restricted", {
      name: SCOPED_PACKAGE_NAME,
      exports: { ".": "./dist/index.js" },
      bin: { [TEST_BIN_NAME]: TEST_BIN_PATH },
    });

    expect(
      realpathSync(
        resolveInstalledPackageBin(
          SCOPED_PACKAGE_NAME,
          TEST_BIN_NAME,
          fixture.anchor,
        ),
      ),
    ).toBe(expectedTestBinary(fixture.packageRoot));
  });

  it("skips a nearer package with the wrong manifest identity", () => {
    const fixture = seedLayeredConsumer(
      "decoy",
      JSON.stringify({ name: DECOY_MANIFEST_NAME }),
    );

    expect(
      realpathSync(
        resolveInstalledPackageBin(
          SCOPED_PACKAGE_NAME,
          TEST_BIN_NAME,
          fixture.anchor,
        ),
      ),
    ).toBe(expectedTestBinary(fixture.packageRoot));
  });

  it("rejects missing packages and undeclared binaries", () => {
    const fixture = seedConsumer("missing", {
      name: SCOPED_PACKAGE_NAME,
    });

    expect(() =>
      resolveInstalledPackageBin(
        MISSING_PACKAGE_NAME,
        TEST_BIN_NAME,
        fixture.anchor,
      ),
    ).toThrow("Unable to resolve installed package");
    expect(() =>
      resolveInstalledPackageBin(
        SCOPED_PACKAGE_NAME,
        TEST_BIN_NAME,
        fixture.anchor,
      ),
    ).toThrow(`does not expose bin ${TEST_BIN_NAME}`);
  });

  it("resolves the installed production router binary", () => {
    expect(
      resolveInstalledPackageBin(SERVER_PACKAGE_NAME, SERVER_BIN_NAME),
    ).toMatch(/[\\/]bin[\\/]moltzap-server$/u);
  });
});

/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function -- Restore project limits after the package-resolution regressions. */
