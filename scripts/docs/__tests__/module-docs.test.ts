/** @file Workspace acceptance tests for generated MODULE and MDX surfaces. */

import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Synchronous filesystem operations create and restore test fixtures outside the Effect under test.
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
  type ModuleRenderResult,
  REQUIRED_PACKAGE_SUBPATHS,
} from "../modules.ts";
import { folderOf, loadTypeDoc, type TypeDocCache } from "../typedoc-load.ts";

const GITHUB_SOURCE = "https://github.com/chughtapan/moltzap/blob/main";

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

// eslint-disable-next-line agent-code-guard/async-keyword, max-lines-per-function, sonarjs/max-lines-per-function -- This fixture builds a complete TypeDoc workspace before Vitest awaits the Effect runner.
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

  writeFixture(
    "packages/client/package.json",
    JSON.stringify({ name: "@moltzap/client" }),
  );
  writeFixture(
    "packages/client/src/index.ts",
    "/** @file Public client values. */\nexport interface HarnessEndpoint {}\n",
  );
  writeFixture(
    "packages/client/src/service/index.ts",
    '/** @file Process composition. */\nexport namespace Daemon {\n  export const withFirewall = "layer";\n}\nexport const makeFirewall = "firewall";\n',
  );

  writeFixture("docs/modules/legacy/src.mdx", "stale page\n");
  writeFixture("packages/legacy/src/MODULE.md", "# stale module\n");

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
          name: "@moltzap/client",
          children: [
            {
              id: 19,
              name: "index",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 20,
                  name: "HarnessEndpoint",
                  kind: ReflectionKind.Interface,
                  sources: source("packages/client/src/index.ts", 2),
                },
              ],
            },
            {
              id: 21,
              name: "service",
              kind: ReflectionKind.Module,
              children: [
                {
                  id: 22,
                  name: "Daemon",
                  kind: ReflectionKind.Namespace,
                  sources: source("packages/client/src/service/index.ts", 2),
                  children: [
                    {
                      id: 23,
                      name: "withFirewall",
                      kind: ReflectionKind.Variable,
                      sources: source(
                        "packages/client/src/service/index.ts",
                        3,
                      ),
                    },
                  ],
                },
                {
                  id: 24,
                  name: "makeFirewall",
                  kind: ReflectionKind.Variable,
                  sources: source("packages/client/src/service/index.ts", 5),
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

// @agent-code-guard/regression-only: fixed navigation and TypeDoc fixtures exercise distinct formatting and failure regressions.
// eslint-disable-next-line max-lines-per-function, sonarjs/max-lines-per-function -- The declarative suite keeps the related generated-document regression cases together.
describe("module documentation", () => {
  // eslint-disable-next-line agent-code-guard/async-keyword -- Vitest awaits this Promise boundary; the implementation under test remains an Effect.
  it("normalizes declaration roots reported from a worktree", async () => {
    const cachePath = join(sandbox, "typedoc-dist-path.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        children: [
          {
            name: "@moltzap/identity",
            children: [
              {
                id: 101,
                name: "registry",
                kind: ReflectionKind.Module,
                children: [
                  {
                    id: 102,
                    name: "Registry",
                    kind: ReflectionKind.Class,
                    sources: source(
                      "/workspace/moltzap-worktree/packages/identity/dist/registry.d.ts",
                      1,
                    ),
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const cache = await Effect.runPromise(
      loadTypeDoc(cachePath, {
        packageSubpaths: ["@moltzap/identity/registry"],
      }).pipe(Effect.provide(NodeContext.layer)),
    );
    const [declaration] = cache.all;

    expect(declaration?.sources[0]?.fileName).toBe(
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
      "packages/identity/dist/registry.d.ts",
    );
    expect(declaration === undefined ? "" : folderOf(declaration)).toBe(
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
      "packages/identity/dist",
    );
  });

  it("renders Registry APIs only under their public package subpaths", () => {
    const [publicSurface = ""] = identityModule.split("## Package subpaths");
    const registrySection = identityModule
      .split("### `@moltzap/identity/registry`\n")[1]
      ?.split("### `@moltzap/identity/registry/server`\n")[0];
    const serverSection = identityModule.split(
      "### `@moltzap/identity/registry/server`\n",
    )[1];

    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(publicSurface).not.toContain("### [`Registry`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(publicSurface).not.toContain("OperationId");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(publicSurface).toContain("### [`AgentCard`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(registrySection).toContain("#### [`Registry`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(registrySection).toContain("#### [`OperationId (type)`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(registrySection).toContain("#### [`OperationId (value)`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(serverSection).toContain("#### [`StartupError`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(serverSection).toContain("#### [`layer`]");
    expect(identityModule).toContain(
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
      "Complete production Registry process composition.",
    );
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).not.toContain("@moltzap/identity/server");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).not.toContain("#### [`RegistryServer`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).not.toContain("RegistryServer.");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
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

  it("qualifies only namespace members in package subpaths", () => {
    const clientModule = readFileSync(
      join(sandbox, "packages/client/src/MODULE.md"),
      "utf8",
    );

    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(clientModule).toContain("#### [`Daemon.withFirewall`]");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(clientModule).toContain("#### [`makeFirewall`]");
  });

  it("uses final package paths and main-branch source links", () => {
    expect(rendered.map(({ folder, pageSlug }) => [folder, pageSlug])).toEqual([
      ["packages/client/src", "client/src"],
      ["packages/client/src/service", "client/service"],
      ["packages/identity/src", "identity/src"],
      ["packages/router/src", "router/src"],
    ]);
    expect(
      readFileSync(join(sandbox, "packages/client/src/MODULE.md"), "utf8"),
      // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    ).toContain("### `@moltzap/client/service`");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).toContain("# identity/src\n");
    // eslint-disable-next-line agent-code-guard/no-hardcoded-assertion-literals -- The expected text is the observable output for this fixed input fixture.
    expect(identityModule).toContain("_`packages/identity/src`_");
    expect(existsSync(join(sandbox, "docs/modules/router/src.mdx"))).toBe(true);
    expect(identityMdx).toContain(
      `${GITHUB_SOURCE}/packages/identity/src/registry/server.ts#L1`,
    );
  });

  // eslint-disable-next-line agent-code-guard/async-keyword -- Vitest awaits this Promise boundary; the implementation under test remains an Effect.
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

  it("prunes generated pages whose source folder is gone", () => {
    expect(existsSync(join(sandbox, "docs/modules/legacy/src.mdx"))).toBe(
      false,
    );
    expect(existsSync(join(sandbox, "packages/legacy/src/MODULE.md"))).toBe(
      false,
    );
  });
});
