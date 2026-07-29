import { describe, expect, it } from "vitest";
import { ReflectionKind } from "typedoc";
import { exportsForModuleFolder, exportsForPackageRoot } from "../modules.js";
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
