import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveInstalledPackageBin,
  resolveInstalledPackageRoot,
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

function seedLookupPath(
  lookupName: string,
  manifest: Record<string, unknown>,
): string {
  const lookupPath = join(fixtureRoot, lookupName);
  const packageRoot = join(lookupPath, SCOPED_PACKAGE_NAME);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest));
  return lookupPath;
}

// @agent-code-guard/regression-only: each case pins one resolution branch (manifest-name match, decoy skip, unparsable-manifest skip, require fallback, unresolvable failure) against seeded fixture layouts; the input domain is filesystem shapes, not values to generate over
describe("resolveInstalledPackageRoot", () => {
  it("returns the lookup-path candidate whose manifest name matches", () => {
    const lookupPath = seedLookupPath("matching", {
      name: SCOPED_PACKAGE_NAME,
    });

    const root = resolveInstalledPackageRoot(SCOPED_PACKAGE_NAME, [lookupPath]);

    expect(root).toBe(join(lookupPath, SCOPED_PACKAGE_NAME));
  });

  it("skips lookup-path candidates whose manifest name differs", () => {
    const decoyLookupPath = seedLookupPath("decoy", {
      name: DECOY_MANIFEST_NAME,
    });
    const realLookupPath = seedLookupPath("real", {
      name: SCOPED_PACKAGE_NAME,
    });

    const root = resolveInstalledPackageRoot(SCOPED_PACKAGE_NAME, [
      decoyLookupPath,
      realLookupPath,
    ]);

    expect(root).toBe(join(realLookupPath, SCOPED_PACKAGE_NAME));
  });

  it("skips a lookup-path candidate whose package.json is unparsable", () => {
    const brokenLookupPath = join(fixtureRoot, "broken");
    const brokenRoot = join(brokenLookupPath, SCOPED_PACKAGE_NAME);
    mkdirSync(brokenRoot, { recursive: true });
    writeFileSync(join(brokenRoot, "package.json"), "{not json");
    const realLookupPath = seedLookupPath("after-broken", {
      name: SCOPED_PACKAGE_NAME,
    });

    const root = resolveInstalledPackageRoot(SCOPED_PACKAGE_NAME, [
      brokenLookupPath,
      realLookupPath,
    ]);

    expect(root).toBe(join(realLookupPath, SCOPED_PACKAGE_NAME));
  });

  it("falls back to require resolution when no lookup path matches", () => {
    const root = resolveInstalledPackageRoot(REAL_PACKAGE_NAME, []);

    expect(root.split(sep)).toContain(REAL_PACKAGE_NAME);
  });

  it("throws when the package resolves nowhere", () => {
    expect(() =>
      resolveInstalledPackageRoot(MISSING_PACKAGE_NAME, [fixtureRoot]),
    ).toThrow();
  });
});

describe("resolveInstalledPackageBin", () => {
  it("fails with PackageResolutionFailed when the bin is not exposed", () => {
    expect(() =>
      resolveInstalledPackageBin(REAL_PACKAGE_NAME, MISSING_BIN_NAME),
    ).toThrow(`does not expose bin ${MISSING_BIN_NAME}`);
  });
});
