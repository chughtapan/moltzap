import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReflectionKind } from "typedoc";
import { describe, expect, it } from "vitest";
import {
  exportsForModuleFolder,
  exportsForPackageRoot,
  generateModuleDocs,
  modulePageSlug,
  sourcePermalink,
} from "../modules.js";
import type { TypeDocCache, TypeDocExport } from "../typedoc-load.js";

const exported = (
  id: number,
  name: string,
  packageName: string,
  fileName: string,
): TypeDocExport => ({
  id,
  name,
  kind: ReflectionKind.Function,
  kindString: "Function",
  packageName,
  sources: [{ fileName, line: 1, character: 0 }],
  comment: null,
  signatureReturnTypeName: null,
});

describe("exportsForModuleFolder", () => {
  it("gives a package root every symbol exported by its entry point", () => {
    const root = exported(
      1,
      "defineSociety",
      "@moltzap/simulator",
      "packages/simulator/src/definition.ts",
    );
    const nested = exported(
      2,
      "openClawRuntime",
      "@moltzap/simulator",
      "packages/simulator/src/runtime/openclaw/runtime.ts",
    );
    const privateCapability = exported(
      3,
      "makeRuntimeProcess",
      "@moltzap/simulator",
      "packages/simulator/src/runtime/process.ts",
    );
    const cache: TypeDocCache = {
      all: [root, nested, privateCapability],
      byPackage: new Map([
        ["@moltzap/simulator", [root, nested, privateCapability]],
      ]),
      byPackageEntrypoint: new Map([["@moltzap/simulator", [root, nested]]]),
      byFolder: new Map([
        ["packages/simulator/src", [root]],
        ["packages/simulator/src/runtime", [nested]],
      ]),
    };

    expect(exportsForPackageRoot(cache, "@moltzap/simulator")).toEqual([
      root,
      nested,
    ]);
  });

  it("keeps nested module ownership scoped to the declaration folder", () => {
    const nested = exported(
      1,
      "openClawRuntime",
      "@moltzap/simulator",
      "packages/simulator/src/runtime/openclaw/runtime.ts",
    );
    const sibling = exported(
      2,
      "openLedger",
      "@moltzap/simulator",
      "packages/simulator/src/ledger/open.ts",
    );
    const cache: TypeDocCache = {
      all: [nested, sibling],
      byPackage: new Map([["@moltzap/simulator", [nested, sibling]]]),
      byPackageEntrypoint: new Map([["@moltzap/simulator", [nested, sibling]]]),
      byFolder: new Map([
        ["packages/simulator/src/runtime", [nested]],
        ["packages/simulator/src/ledger", [sibling]],
      ]),
    };

    expect(
      exportsForModuleFolder(cache, "packages/simulator/src/runtime"),
    ).toEqual([nested]);
  });
});

describe("v2 module documentation", () => {
  it("renders server namespaces beneath their package subpaths", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "module-server-subpaths-"));
    const docsModulesDir = join(sandbox, "docs/modules");
    const identityRootType = {
      ...exported(
        1,
        "Registry",
        "@moltzap/v2-identity",
        "v2/identity/src/index.ts",
      ),
      kind: ReflectionKind.TypeAlias,
      kindString: "TypeAlias",
      sources: [
        {
          fileName: "v2/identity/src/index.ts",
          line: 2,
          character: 0,
        },
      ],
    };
    const identityRootValue = {
      ...exported(
        9,
        "Registry",
        "@moltzap/v2-identity",
        "v2/identity/src/index.ts",
      ),
      kind: ReflectionKind.Variable,
      kindString: "Variable",
      sources: [
        {
          fileName: "v2/identity/src/index.ts",
          line: 3,
          character: 0,
        },
      ],
    };
    const identityServer = [
      {
        ...exported(
          2,
          "RegistryServer",
          "@moltzap/v2-identity",
          "v2/identity/src/registry/server.ts",
        ),
        kind: ReflectionKind.Namespace,
        kindString: "Namespace",
      },
      {
        ...exported(
          3,
          "StartupError",
          "@moltzap/v2-identity",
          "v2/identity/src/registry/server.ts",
        ),
        kind: ReflectionKind.Class,
        kindString: "Class",
      },
      {
        ...exported(
          4,
          "layer",
          "@moltzap/v2-identity",
          "v2/identity/src/registry/server.ts",
        ),
        kind: ReflectionKind.Variable,
        kindString: "Variable",
        comment: {
          summary: "Complete production Registry process composition.",
          tags: [],
        },
      },
    ];
    const routerRoot = exported(
      5,
      "Router",
      "@moltzap/v2-router",
      "v2/router/src/index.ts",
    );
    const routerServer = [
      {
        ...exported(
          6,
          "RouterServer",
          "@moltzap/v2-router",
          "v2/router/src/router/server.ts",
        ),
        kind: ReflectionKind.Namespace,
        kindString: "Namespace",
      },
      {
        ...exported(
          7,
          "StartupError",
          "@moltzap/v2-router",
          "v2/router/src/router/server.ts",
        ),
        kind: ReflectionKind.Class,
        kindString: "Class",
      },
      {
        ...exported(
          8,
          "layer",
          "@moltzap/v2-router",
          "v2/router/src/router/server.ts",
        ),
        kind: ReflectionKind.Variable,
        kindString: "Variable",
      },
    ];
    const cache: TypeDocCache = {
      all: [
        identityRootType,
        identityRootValue,
        ...identityServer,
        routerRoot,
        ...routerServer,
      ],
      byPackage: new Map([
        [
          "@moltzap/v2-identity",
          [identityRootType, identityRootValue, ...identityServer],
        ],
        ["@moltzap/v2-router", [routerRoot, ...routerServer]],
      ]),
      byPackageEntrypoint: new Map([
        ["@moltzap/v2-identity", [identityRootType, identityRootValue]],
        ["@moltzap/v2-identity/server", identityServer],
        ["@moltzap/v2-router", [routerRoot]],
        ["@moltzap/v2-router/server", routerServer],
      ]),
      byFolder: new Map(),
    };

    for (const [folder, packageName, namespaceName, rootName, moduleName] of [
      [
        "v2/identity",
        "@moltzap/v2-identity",
        "RegistryServer",
        "Registry",
        "registry",
      ],
      ["v2/router", "@moltzap/v2-router", "RouterServer", "Router", "router"],
    ] as const) {
      const packageRoot = join(sandbox, folder);
      mkdirSync(join(packageRoot, "src", moduleName), { recursive: true });
      mkdirSync(join(packageRoot, "src", "__tests__"), { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: packageName }),
      );
      writeFileSync(
        join(packageRoot, "src/index.ts"),
        `/** @file ${namespaceName} package purpose. */\nexport type ${rootName} = { readonly kind: "${moduleName}" };\nexport const ${rootName} = {};\n`,
      );
      writeFileSync(
        join(packageRoot, "src/server.ts"),
        `export { ${namespaceName} } from "./${moduleName}/server.js";\n`,
      );
      writeFileSync(
        join(packageRoot, "src", moduleName, "client.ts"),
        "export const privateClient = {};\n",
      );
      writeFileSync(
        join(packageRoot, "src", moduleName, "server.ts"),
        `export namespace ${namespaceName} {\n  export class StartupError extends Error {}\n  export const layer = "layer";\n}\n`,
      );
      writeFileSync(
        join(packageRoot, "src", moduleName, "README.md"),
        `# ${namespaceName}\n`,
      );
      writeFileSync(
        join(packageRoot, "src", "__tests__", "ignored.test.ts"),
        "export const ignoredTest = true;\n",
      );
      writeFileSync(
        join(packageRoot, "src", `${moduleName}.types-check.ts`),
        "export type IgnoredCanary = true;\n",
      );
    }

    try {
      await Effect.runPromise(
        generateModuleDocs(cache, {
          workspaceRoot: sandbox,
          docsModulesDir,
        }).pipe(Effect.provide(NodeContext.layer)),
      );
      const moduleMarkdown = readFileSync(
        join(sandbox, "v2/identity/src/MODULE.md"),
        "utf8",
      );
      const publicSurface = moduleMarkdown.split("## Server subpath")[0];

      expect(publicSurface).toContain("`Registry (type)`");
      expect(publicSurface).toContain("`Registry (value)`");
      expect(publicSurface).not.toContain("`RegistryServer`");
      expect(moduleMarkdown).toContain("### `@moltzap/v2-identity/server`");
      expect(moduleMarkdown).toContain("#### [`RegistryServer`]");
      expect(moduleMarkdown).toContain("#### [`RegistryServer.StartupError`]");
      expect(moduleMarkdown).toContain("#### [`RegistryServer.layer`]");
      expect(moduleMarkdown).toContain(
        "Complete production Registry process composition.",
      );
      expect(moduleMarkdown).toContain("- `index.ts`");
      expect(moduleMarkdown).toContain("- `server.ts`");
      expect(moduleMarkdown).toContain("- `registry/client.ts`");
      expect(moduleMarkdown).toContain("- `registry/README.md`");
      expect(moduleMarkdown).toContain("- `registry/server.ts`");
      expect(moduleMarkdown).not.toContain("ignored.test.ts");
      expect(moduleMarkdown).not.toContain("registry.types-check.ts");

      const moduleMdx = readFileSync(
        join(docsModulesDir, "v2/identity/src.mdx"),
        "utf8",
      );
      expect(moduleMdx).toContain(
        "https://github.com/chughtapan/moltzap/blob/v2/v2/identity/src/registry/server.ts#L1",
      );
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("uses collision-free v2 page slugs", () => {
    expect({
      v1: modulePageSlug("packages/simulator/src"),
      identity: modulePageSlug("v2/identity/src"),
      routerState: modulePageSlug("v2/router/src/state"),
    }).toEqual({
      v1: "simulator/src",
      identity: "v2/identity/src",
      routerState: "v2/router/state",
    });
  });

  it("links each source track to its owning branch", () => {
    expect(sourcePermalink("packages/protocol/src/index.ts", 4)).toBe(
      "https://github.com/chughtapan/moltzap/blob/main/packages/protocol/src/index.ts#L4",
    );
    expect(sourcePermalink("v2/router/src/index.ts", 7)).toBe(
      "https://github.com/chughtapan/moltzap/blob/v2/v2/router/src/index.ts#L7",
    );
  });
});
