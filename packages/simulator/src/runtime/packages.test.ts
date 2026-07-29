/* eslint-disable agent-code-guard/prefer-effect-platform -- Synchronous package fixtures exercise Node's synchronous createRequire resolution boundary. */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  makeInstallModeResolver,
  RuntimePackageError,
  resolveInstalledPackageDependency,
  resolveInstalledPackageBin,
  resolveInstalledPackageRoot,
  resolveOwningPackageRoot,
  resolvePackageRoot,
  type InstallMode,
} from "./packages.js";

const SCOPED_PACKAGE_NAME = "@moltzap-test/resolved";
const OWNER_PACKAGE_NAME = "@moltzap-test/owner";
const DECOY_MANIFEST_NAME = "some-other-package";
const MISSING_PACKAGE_NAME = "@moltzap-test/definitely-missing";
const REAL_PACKAGE_NAME = "effect";
const MISSING_BIN_NAME = "no-such-bin";
const DECLARED_DEPENDENCY_SPEC = "^1.2.0";
const INSTALLED_PACKAGE_VERSION = "1.2.3";
const NON_EXACT_PACKAGE_VERSION = "^1.2.3";
const NESTED_PACKAGE_VERSION = "9.9.9";

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

function seedOwnedDependency(
  fixtureName: string,
  ownerManifest: Record<string, unknown>,
  installedManifest: Record<string, unknown>,
): {
  readonly anchor: string;
  readonly ownerPackageRoot: string;
  readonly packageRoot: string;
} {
  const ownerPackageRoot = join(fixtureRoot, fixtureName);
  const anchor = join(ownerPackageRoot, "src", "nested", "anchor.js");
  const packageRoot = join(
    ownerPackageRoot,
    "node_modules",
    SCOPED_PACKAGE_NAME,
  );
  mkdirSync(join(ownerPackageRoot, "src", "nested"), { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(anchor, "export {};");
  writeFileSync(
    join(ownerPackageRoot, "package.json"),
    JSON.stringify(ownerManifest),
  );
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify(installedManifest),
  );
  return { anchor, ownerPackageRoot, packageRoot };
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

describe("resolveOwningPackageRoot", () => {
  it("finds the named owner independently of module depth", () => {
    const fixture = seedOwnedDependency(
      "owning-package",
      {
        name: OWNER_PACKAGE_NAME,
        dependencies: {
          [SCOPED_PACKAGE_NAME]: DECLARED_DEPENDENCY_SPEC,
        },
      },
      {
        name: SCOPED_PACKAGE_NAME,
        version: INSTALLED_PACKAGE_VERSION,
      },
    );

    expect(resolveOwningPackageRoot(OWNER_PACKAGE_NAME, fixture.anchor)).toBe(
      fixture.ownerPackageRoot,
    );
  });
});

describe("resolveInstalledPackageDependency metadata", () => {
  it("returns the owner's declared spec and installed exact version", () => {
    const fixture = seedOwnedDependency(
      "installed-dependency",
      {
        name: OWNER_PACKAGE_NAME,
        dependencies: {
          [SCOPED_PACKAGE_NAME]: DECLARED_DEPENDENCY_SPEC,
        },
      },
      {
        name: SCOPED_PACKAGE_NAME,
        version: INSTALLED_PACKAGE_VERSION,
      },
    );

    expect(
      resolveInstalledPackageDependency(
        OWNER_PACKAGE_NAME,
        SCOPED_PACKAGE_NAME,
        fixture.anchor,
      ),
    ).toEqual({
      ownerPackageRoot: fixture.ownerPackageRoot,
      declaredSpec: DECLARED_DEPENDENCY_SPEC,
      packageRoot: realpathSync(fixture.packageRoot),
      version: INSTALLED_PACKAGE_VERSION,
    });
  });
});

describe("resolveInstalledPackageDependency anchoring", () => {
  it("resolves from the owner anchor instead of a nested dependency", () => {
    const fixture = seedOwnedDependency(
      "owner-anchored-dependency",
      {
        name: OWNER_PACKAGE_NAME,
        dependencies: {
          [SCOPED_PACKAGE_NAME]: DECLARED_DEPENDENCY_SPEC,
        },
      },
      {
        name: SCOPED_PACKAGE_NAME,
        version: INSTALLED_PACKAGE_VERSION,
      },
    );
    const nestedPackageRoot = join(
      dirname(fixture.anchor),
      "node_modules",
      SCOPED_PACKAGE_NAME,
    );
    mkdirSync(nestedPackageRoot, { recursive: true });
    writeFileSync(
      join(nestedPackageRoot, "package.json"),
      JSON.stringify({
        name: SCOPED_PACKAGE_NAME,
        version: NESTED_PACKAGE_VERSION,
      }),
    );

    const resolved = resolveInstalledPackageDependency(
      OWNER_PACKAGE_NAME,
      SCOPED_PACKAGE_NAME,
      fixture.anchor,
    );

    expect(resolved.packageRoot).toBe(realpathSync(fixture.packageRoot));
    expect(resolved.version).toBe(INSTALLED_PACKAGE_VERSION);
  });
});

describe("resolveInstalledPackageDependency declaration validation", () => {
  it("requires the dependency in the owner's own dependencies", () => {
    const fixture = seedOwnedDependency(
      "dev-only-dependency",
      {
        name: OWNER_PACKAGE_NAME,
        devDependencies: {
          [SCOPED_PACKAGE_NAME]: DECLARED_DEPENDENCY_SPEC,
        },
      },
      {
        name: SCOPED_PACKAGE_NAME,
        version: INSTALLED_PACKAGE_VERSION,
      },
    );

    expect(() =>
      resolveInstalledPackageDependency(
        OWNER_PACKAGE_NAME,
        SCOPED_PACKAGE_NAME,
        fixture.anchor,
      ),
    ).toThrow(`must declare ${SCOPED_PACKAGE_NAME} in its own dependencies`);
  });
});

describe("resolveInstalledPackageDependency version validation", () => {
  it("rejects an installed manifest without an exact version", () => {
    const fixture = seedOwnedDependency(
      "ranged-installed-version",
      {
        name: OWNER_PACKAGE_NAME,
        dependencies: {
          [SCOPED_PACKAGE_NAME]: DECLARED_DEPENDENCY_SPEC,
        },
      },
      {
        name: SCOPED_PACKAGE_NAME,
        version: NON_EXACT_PACKAGE_VERSION,
      },
    );

    expect(() =>
      resolveInstalledPackageDependency(
        OWNER_PACKAGE_NAME,
        SCOPED_PACKAGE_NAME,
        fixture.anchor,
      ),
    ).toThrow(`does not declare an exact version`);
  });
});

describe("resolveInstalledPackageBin", () => {
  it("fails with PackageResolutionFailed when the bin is not exposed", () => {
    expect(() =>
      resolveInstalledPackageBin(REAL_PACKAGE_NAME, MISSING_BIN_NAME),
    ).toThrow(`does not expose bin ${MISSING_BIN_NAME}`);
  });
});

const WORKSPACE_PACKAGES_DIR = join("/workspace", "packages");
const WORKSPACE_CHANNEL_ROOT = join(WORKSPACE_PACKAGES_DIR, "openclaw-channel");
const INSTALLED_CHANNEL_ROOT = join(
  "/consumer",
  "node_modules",
  "@moltzap",
  "openclaw-channel",
);

interface DecisionCase {
  readonly expected: InstallMode;
  readonly explicit?: InstallMode;
  readonly packageRoot: string;
  readonly title: string;
}

const DECISION_CASES: ReadonlyArray<DecisionCase> = [
  {
    title: "infers workspace from a workspace package root",
    packageRoot: WORKSPACE_CHANNEL_ROOT,
    expected: "workspace",
  },
  {
    title: "infers published from an installed node_modules root",
    packageRoot: INSTALLED_CHANNEL_ROOT,
    expected: "published",
  },
  {
    title: "lets a published override beat workspace inference",
    explicit: "published",
    packageRoot: WORKSPACE_CHANNEL_ROOT,
    expected: "published",
  },
  {
    title: "lets a workspace override beat published inference",
    explicit: "workspace",
    packageRoot: INSTALLED_CHANNEL_ROOT,
    expected: "workspace",
  },
];

describe("resolveInstallMode", () => {
  it.each(DECISION_CASES)("$title", ({ expected, explicit, packageRoot }) => {
    const resolveChannelPackageRoot = vi.fn(() => packageRoot);
    const resolve = makeInstallModeResolver({
      resolveChannelPackageRoot,
      workspacePackagesDir: WORKSPACE_PACKAGES_DIR,
    });

    const mode = Effect.runSync(resolve(explicit));

    expect(mode).toBe(expected);
    expect(resolveChannelPackageRoot).toHaveBeenCalledTimes(
      explicit === undefined ? 1 : 0,
    );
  });

  it("surfaces package-resolution failures in the typed error channel", () => {
    const resolve = makeInstallModeResolver({
      resolveChannelPackageRoot: () => {
        throw new Error("package root unavailable");
      },
      workspacePackagesDir: WORKSPACE_PACKAGES_DIR,
    });
    const exit = Effect.runSync(Effect.exit(resolve()));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Option.getOrThrow(Cause.failureOption(exit.cause));
      expect(failure).toBeInstanceOf(RuntimePackageError);
    }
  });
});
