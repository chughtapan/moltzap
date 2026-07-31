import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReflectionKind } from "typedoc";
import { describe, expect, it } from "vitest";
import { loadTypeDoc, normalizeSourcePath } from "../typedoc-load.js";

describe("normalizeSourcePath", () => {
  it("retains both workspace source roots", () => {
    expect(
      normalizeSourcePath(
        "/workspace/v2/moltzap/packages/protocol/src/index.ts",
      ),
    ).toBe("packages/protocol/src/index.ts");
    expect(
      normalizeSourcePath(
        "C:\\workspace\\archive-v2\\moltzap\\v2\\identity\\src\\index.ts",
      ),
    ).toBe("v2/identity/src/index.ts");
  });

  it("recovers a v2 path from a TypeDoc permalink", () => {
    expect(
      normalizeSourcePath(
        "index.ts",
        "https://github.com/chughtapan/moltzap/blob/v2/v2/router/src/index.ts",
      ),
    ).toBe("v2/router/src/index.ts");
  });
});

describe("loadTypeDoc", () => {
  it("indexes package roots and server entrypoints as separate public surfaces", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "typedoc-load-"));
    const cachePath = join(sandbox, "typedoc.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        children: [
          {
            name: "@moltzap/v2-identity",
            children: [
              {
                id: 1,
                name: "index",
                kind: ReflectionKind.Module,
                children: [
                  {
                    id: 2,
                    name: "Registry",
                    kind: ReflectionKind.Namespace,
                    sources: [
                      {
                        fileName: "v2/identity/src/registry/contract.ts",
                        line: 1,
                        character: 17,
                      },
                    ],
                  },
                ],
              },
              {
                id: 3,
                name: "server",
                kind: ReflectionKind.Module,
                children: [
                  {
                    id: 4,
                    name: "RegistryServer",
                    kind: ReflectionKind.Namespace,
                    sources: [
                      {
                        fileName: "v2/identity/src/registry/server.ts",
                        line: 1,
                        character: 17,
                      },
                    ],
                    children: [
                      {
                        id: 5,
                        name: "StartupError",
                        kind: ReflectionKind.Class,
                        sources: [
                          {
                            fileName: "v2/identity/src/registry/server.ts",
                            line: 2,
                            character: 15,
                          },
                        ],
                      },
                      {
                        id: 6,
                        name: "layer",
                        kind: ReflectionKind.Variable,
                        sources: [
                          {
                            fileName: "v2/identity/src/registry/server.ts",
                            line: 3,
                            character: 15,
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                id: 7,
                name: "registry/private-helper",
                kind: ReflectionKind.Module,
                children: [
                  {
                    id: 8,
                    name: "privateHelper",
                    kind: ReflectionKind.Function,
                    sources: [
                      {
                        fileName: "v2/identity/src/registry/private-helper.ts",
                        line: 1,
                        character: 0,
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

    try {
      const cache = await Effect.runPromise(
        loadTypeDoc(cachePath, {
          packageSubpaths: ["@moltzap/v2-identity/server"],
        }).pipe(Effect.provide(NodeContext.layer)),
      );

      expect(
        cache.byPackageEntrypoint
          .get("@moltzap/v2-identity")
          ?.map((entry) => entry.name),
      ).toEqual(["Registry"]);
      expect(
        cache.byPackageEntrypoint
          .get("@moltzap/v2-identity/server")
          ?.map((entry) => entry.name),
      ).toEqual(["RegistryServer", "StartupError", "layer"]);
      expect(
        cache.byPackageEntrypoint.has(
          "@moltzap/v2-identity/registry/private-helper",
        ),
      ).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
