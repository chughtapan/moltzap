/** @file End-to-end acceptance tests for generated MODULE and MDX surfaces. */

import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ReflectionKind } from "typedoc";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  generateModuleDocs,
  REQUIRED_PACKAGE_SUBPATHS,
  type ModuleRenderResult,
} from "../modules.js";
import { loadTypeDoc, type TypeDocCache } from "../typedoc-load.js";

const GITHUB_SOURCE = "https://github.com/chughtapan/moltzap/blob";

let sandbox = "";
let rendered: readonly ModuleRenderResult[] = [];
let identityModule = "";
let identityMdx = "";
let typeDocCache: TypeDocCache;

function writeFixture(relativePath: string, contents: string): void {
  const absolutePath = join(sandbox, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
}

function source(
  fileName: string,
  line: number,
  url?: string,
): ReadonlyArray<{
  readonly fileName: string;
  readonly line: number;
  readonly character: number;
  readonly url?: string;
}> {
  return [
    {
      fileName,
      line,
      character: 0,
      ...(url === undefined ? {} : { url }),
    },
  ];
}

beforeAll(async () => {
  sandbox = mkdtempSync(join(tmpdir(), "module-docs-"));
  const cachePath = join(sandbox, "typedoc.json");
  const docsModulesDir = join(sandbox, "docs/modules");

  writeFixture(
    "packages/identity/package.json",
    JSON.stringify({ name: "@moltzap/identity" }),
  );
  writeFixture(
    "packages/identity/src/index.ts",
    "/** @file Public identity values. */\nexport interface AgentCard {}\n",
  );
  writeFixture(
    "packages/identity/src/registry.ts",
    'export class Registry {}\nexport type OperationId = string;\nexport const OperationId = "operation";\n',
  );
  writeFixture(
    "packages/identity/src/registry/server.ts",
    'export class StartupError extends Error {}\n/** Complete production Registry process composition. */\nexport const layer = "layer";\n',
  );
  writeFixture(
    "packages/identity/src/registry/client.ts",
    "export const privateClient = {};\n",
  );
  writeFixture("packages/identity/src/registry/README.md", "# Registry\n");
  writeFixture(
    "packages/identity/src/ignored.test.ts",
    "export const ignoredTest = true;\n",
  );
  writeFixture(
    "packages/identity/src/registry/__tests__/fixture.ts",
    "export const ignoredFixture = true;\n",
  );
  writeFixture(
    "packages/identity/src/registry/registry.types-check.ts",
    "export type IgnoredCanary = true;\n",
  );

  writeFixture(
    "packages/router/package.json",
    JSON.stringify({ name: "@moltzap/router" }),
  );
  writeFixture(
    "packages/router/src/index.ts",
    "/** @file Public Router values. */\nexport class Router {}\n",
  );
  writeFixture(
    "packages/router/src/server.ts",
    'export { RouterServer } from "./router/server.js";\n',
  );
  writeFixture(
    "packages/router/src/router/server.ts",
    'export namespace RouterServer {\n  export const layer = "layer";\n}\n',
  );

  writeFixture("docs/modules/v2/identity/src.mdx", "stale identity page\n");
  writeFixture("docs/modules/v2/router/src.mdx", "stale router page\n");
  writeFixture("v2/identity/src/MODULE.md", "# stale identity module\n");
  writeFixture("v2/router/src/MODULE.md", "# stale router module\n");

  writeFileSync(
    cachePath,
    JSON.stringify({
      children: [
        {
          name: "@moltzap/identity",
          children: [
            {
              id: 3,
              name: "index",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 4,
                  name: "AgentCard",
                  kind: ReflectionKind.Interface,
                  sources: source("packages/identity/src/index.ts", 2),
                },
              ],
            },
            {
              id: 5,
              name: "registry",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 6,
                  name: "Registry",
                  kind: ReflectionKind.Class,
                  sources: source("packages/identity/src/registry.ts", 1),
                },
                {
                  id: 7,
                  name: "OperationId",
                  kind: ReflectionKind.TypeAlias,
                  sources: source("packages/identity/src/registry.ts", 2),
                },
                {
                  id: 8,
                  name: "OperationId",
                  kind: ReflectionKind.Variable,
                  sources: source("packages/identity/src/registry.ts", 3),
                },
              ],
            },
            {
              id: 9,
              name: "registry/server",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 10,
                  name: "StartupError",
                  kind: ReflectionKind.Class,
                  sources: source(
                    "C:\\workspace\\moltzap\\packages\\identity\\src\\registry\\server.ts",
                    1,
                  ),
                },
                {
                  id: 11,
                  name: "layer",
                  kind: ReflectionKind.Variable,
                  sources: source(
                    "packages/identity/src/registry/server.ts",
                    3,
                  ),
                  comment: {
                    summary: [
                      {
                        kind: "text",
                        text: "Complete production Registry process composition.",
                      },
                    ],
                  },
                },
              ],
            },
            {
              id: 12,
              name: "registry/client",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 13,
                  name: "privateClient",
                  kind: ReflectionKind.Variable,
                  sources: source(
                    "packages/identity/src/registry/client.ts",
                    1,
                  ),
                },
              ],
            },
          ],
        },
        {
          name: "@moltzap/router",
          children: [
            {
              id: 14,
              name: "index",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 15,
                  name: "Router",
                  kind: ReflectionKind.Class,
                  sources: source("packages/router/src/index.ts", 2),
                },
              ],
            },
            {
              id: 16,
              name: "server",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 17,
                  name: "RouterServer",
                  kind: ReflectionKind.Namespace,
                  sources: source("packages/router/src/router/server.ts", 1),
                  children: [
                    {
                      id: 18,
                      name: "layer",
                      kind: ReflectionKind.Variable,
                      sources: source(
                        "packages/router/src/router/server.ts",
                        2,
                      ),
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );

  typeDocCache = await Effect.runPromise(
    loadTypeDoc(cachePath, {
      packageSubpaths: REQUIRED_PACKAGE_SUBPATHS,
    }).pipe(Effect.provide(NodeContext.layer)),
  );
  rendered = await Effect.runPromise(
    generateModuleDocs(typeDocCache, {
      workspaceRoot: sandbox,
      docsModulesDir,
    }).pipe(Effect.provide(NodeContext.layer)),
  );
  identityModule = readFileSync(
    join(sandbox, "packages/identity/src/MODULE.md"),
    "utf8",
  );
  identityMdx = readFileSync(join(docsModulesDir, "identity/src.mdx"), "utf8");
});

afterAll(() => {
  if (sandbox !== "") {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

describe("module documentation", () => {
  it("renders Registry APIs only under their public package subpaths", () => {
    const [publicSurface = ""] = identityModule.split("## Package subpaths");
    const registrySection = identityModule
      .split("### `@moltzap/identity/registry`\n")[1]
      ?.split("### `@moltzap/identity/registry/server`\n")[0];
    const serverSection = identityModule.split(
      "### `@moltzap/identity/registry/server`\n",
    )[1];

    expect(publicSurface).not.toContain("### [`Registry`]");
    expect(publicSurface).not.toContain("OperationId");
    expect(publicSurface).toContain("### [`AgentCard`]");
    expect(registrySection).toContain("#### [`Registry`]");
    expect(registrySection).toContain("#### [`OperationId (type)`]");
    expect(registrySection).toContain("#### [`OperationId (value)`]");
    expect(serverSection).toContain("#### [`StartupError`]");
    expect(serverSection).toContain("#### [`layer`]");
    expect(identityModule).toContain(
      "Complete production Registry process composition.",
    );
    expect(identityModule).not.toContain("@moltzap/identity/server");
    expect(identityModule).not.toContain("#### [`RegistryServer`]");
    expect(identityModule).not.toContain("RegistryServer.");
    expect(identityModule).not.toContain("privateClient");
  });

  it("lists only production identity files", () => {
    const filesSection = identityModule.split("## Files\n")[1]?.trim();

    expect(filesSection).toBe(
      [
        "- `index.ts`",
        "- `registry.ts`",
        "- `registry/client.ts`",
        "- `registry/README.md`",
        "- `registry/server.ts`",
      ].join("\n"),
    );
  });

  it("uses final package paths and cutover-branch source links", () => {
    expect(rendered.map(({ folder, pageSlug }) => [folder, pageSlug])).toEqual([
      ["packages/identity/src", "identity/src"],
      ["packages/router/src", "router/src"],
    ]);
    expect(identityModule).toContain("# identity/src\n");
    expect(identityModule).toContain("_`packages/identity/src`_");
    expect(existsSync(join(sandbox, "docs/modules/router/src.mdx"))).toBe(true);
    expect(identityMdx).toContain(
      `${GITHUB_SOURCE}/cutover/four-layer-v2/packages/identity/src/registry/server.ts#L1`,
    );
  });

  it("requires final TypeDoc package names and public subpaths", async () => {
    const missingPackageEntries = new Map(typeDocCache.byPackageEntrypoint);
    missingPackageEntries.delete("@moltzap/router");
    await expect(
      Effect.runPromise(
        generateModuleDocs(
          { ...typeDocCache, byPackageEntrypoint: missingPackageEntries },
          {
            workspaceRoot: sandbox,
            docsModulesDir: join(sandbox, "docs/modules"),
          },
        ).pipe(Effect.provide(NodeContext.layer)),
      ),
    ).rejects.toThrow(
      "Required TypeDoc packages were not loaded: @moltzap/router",
    );

    const missingSubpathEntries = new Map(typeDocCache.byPackageEntrypoint);
    missingSubpathEntries.delete("@moltzap/identity/registry/server");
    await expect(
      Effect.runPromise(
        generateModuleDocs(
          { ...typeDocCache, byPackageEntrypoint: missingSubpathEntries },
          {
            workspaceRoot: sandbox,
            docsModulesDir: join(sandbox, "docs/modules"),
          },
        ).pipe(Effect.provide(NodeContext.layer)),
      ),
    ).rejects.toThrow(
      "Required TypeDoc package subpaths were not loaded: @moltzap/identity/registry/server",
    );
  });

  it("prunes generated pages for retired v2 source roots", () => {
    expect(existsSync(join(sandbox, "docs/modules/v2/identity/src.mdx"))).toBe(
      false,
    );
    expect(existsSync(join(sandbox, "docs/modules/v2/router/src.mdx"))).toBe(
      false,
    );
    expect(existsSync(join(sandbox, "v2/identity/src/MODULE.md"))).toBe(false);
    expect(existsSync(join(sandbox, "v2/router/src/MODULE.md"))).toBe(false);
  });
});
