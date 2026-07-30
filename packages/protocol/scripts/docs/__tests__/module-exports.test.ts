import { describe, expect, it } from "vitest";
import { ReflectionKind } from "typedoc";
import {
  exportsForModuleFolder,
  exportsForPackageRoot,
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
      "effectRuntime",
      "@moltzap/simulator",
      "packages/simulator/src/runtime/effect.ts",
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
      "effectRuntime",
      "@moltzap/simulator",
      "packages/simulator/src/runtime/effect.ts",
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
