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
import {
  resolveInstalledPackageBin,
  resolveInstalledPackageRoot,
  resolvePackageRoot,
} from "./package-resolution.js";

const SCOPED_PACKAGE_NAME = "@moltzap-test/resolved";
const DECOY_MANIFEST_NAME = "some-other-package";
const MISSING_PACKAGE_NAME = "@moltzap-test/definitely-missing";
const REAL_PACKAGE_NAME = "effect";
const MISSING_BIN_NAME = "no-such-bin";

const fixtureRoot = mkdtempSync(join(tmpdir(), "package-resolution-test-"));

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function seedConsumer(
  fixtureName: string,
  manifest: Record<string, unknown>,
): { readonly anchor: string; readonly packageRoot: string } {
  const consumerRoot = join(fixtureRoot, fixtureName);
  const anchor = join(consumerRoot, "package.json");
  const packageRoot = join(consumerRoot, "node_modules", SCOPED_PACKAGE_NAME);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    anchor,
    JSON.stringify({ name: `package-resolution-${fixtureName}` }),
  );
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest));
  return { anchor, packageRoot };
}

function seedLayeredConsumer(
  fixtureName: string,
  nearestManifest: string,
): { readonly anchor: string; readonly packageRoot: string } {
  const fixtureDir = join(fixtureRoot, fixtureName);
  const consumerRoot = join(fixtureDir, "consumer");
  const anchor = join(consumerRoot, "package.json");
  const nearestPackageRoot = join(
    consumerRoot,
    "node_modules",
    SCOPED_PACKAGE_NAME,
  );
  const packageRoot = join(fixtureDir, "node_modules", SCOPED_PACKAGE_NAME);
  mkdirSync(nearestPackageRoot, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    anchor,
    JSON.stringify({ name: `package-resolution-${fixtureName}` }),
  );
  writeFileSync(join(nearestPackageRoot, "package.json"), nearestManifest);
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: SCOPED_PACKAGE_NAME }),
  );
  return { anchor, packageRoot };
}

// @agent-code-guard/regression-only: seeded module layouts exercise Node resolution branches whose inputs are filesystem topology rather than generated values
describe("resolvePackageRoot", () => {
  it("resolves from the supplied consumer anchor", () => {
    const fixture = seedConsumer("anchored", {
      name: SCOPED_PACKAGE_NAME,
    });

    const root = resolvePackageRoot(fixture.anchor, SCOPED_PACKAGE_NAME);

    expect(root === null ? null : realpathSync(root)).toBe(
      realpathSync(fixture.packageRoot),
    );
  });

  it("resolves package.json when an exports map hides the subpath", () => {
    const fixture = seedConsumer("export-restricted", {
      name: SCOPED_PACKAGE_NAME,
      exports: { ".": "./dist/index.js" },
    });
    const root = resolvePackageRoot(fixture.anchor, SCOPED_PACKAGE_NAME);

    expect(root === null ? null : realpathSync(root)).toBe(
      realpathSync(fixture.packageRoot),
    );
  });

  it("skips a nearer package whose manifest name differs", () => {
    const fixture = seedLayeredConsumer(
      "decoy",
      JSON.stringify({ name: DECOY_MANIFEST_NAME }),
    );

    const root = resolvePackageRoot(fixture.anchor, SCOPED_PACKAGE_NAME);

    expect(root === null ? null : realpathSync(root)).toBe(
      realpathSync(fixture.packageRoot),
    );
  });

  it("skips a nearer package whose manifest is unparsable", () => {
    const fixture = seedLayeredConsumer("broken", "{not json");

    const root = resolvePackageRoot(fixture.anchor, SCOPED_PACKAGE_NAME);

    expect(root === null ? null : realpathSync(root)).toBe(
      realpathSync(fixture.packageRoot),
    );
  });
});

describe("resolvePackageRoot public-entry fallback", () => {
  it("does not recover a rejected package through its public entry", () => {
    const fixture = seedConsumer("only-decoy", {
      name: DECOY_MANIFEST_NAME,
      main: "index.js",
    });
    writeFileSync(join(fixture.packageRoot, "index.js"), "export {};");

    expect(resolvePackageRoot(fixture.anchor, SCOPED_PACKAGE_NAME)).toBeNull();
  });

  it("recovers a scoped root from a public entry without a manifest", () => {
    const consumerRoot = join(fixtureRoot, "public-entry");
    const anchor = join(consumerRoot, "package.json");
    const packageRoot = join(consumerRoot, "node_modules", SCOPED_PACKAGE_NAME);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(anchor, JSON.stringify({ name: "public-entry-consumer" }));
    writeFileSync(join(packageRoot, "index.js"), "export {};");

    const root = resolvePackageRoot(anchor, SCOPED_PACKAGE_NAME);

    expect(root === null ? null : realpathSync(root)).toBe(
      realpathSync(packageRoot),
    );
  });

  it("returns null when the package resolves nowhere", () => {
    const fixture = seedConsumer("missing", {
      name: SCOPED_PACKAGE_NAME,
    });

    expect(resolvePackageRoot(fixture.anchor, MISSING_PACKAGE_NAME)).toBeNull();
  });
});

describe("resolveInstalledPackageRoot", () => {
  it("throws when the package resolves nowhere", () => {
    const fixture = seedConsumer("throwing", {
      name: SCOPED_PACKAGE_NAME,
    });

    expect(() =>
      resolveInstalledPackageRoot(MISSING_PACKAGE_NAME, fixture.anchor),
    ).toThrow();
  });

  it("resolves an installed package from the default anchor", () => {
    expect(resolveInstalledPackageRoot(REAL_PACKAGE_NAME)).toContain(
      REAL_PACKAGE_NAME,
    );
  });
});

describe("resolveInstalledPackageBin", () => {
  it("fails with PackageResolutionFailed when the bin is not exposed", () => {
    expect(() =>
      resolveInstalledPackageBin(REAL_PACKAGE_NAME, MISSING_BIN_NAME),
    ).toThrow(`does not expose bin ${MISSING_BIN_NAME}`);
  });
});
