import { describe, expect, it } from "vitest";
import { ReflectionKind } from "typedoc";
import { computeFlowCoverage, isBehavioralExport } from "../flow-coverage.js";
import type { TypeDocCache, TypeDocExport } from "../typedoc-load.js";

function makeExport(overrides: Partial<TypeDocExport>): TypeDocExport {
  return {
    id: 1,
    name: "anon",
    kind: ReflectionKind.Variable,
    kindString: "Variable",
    packageName: "@moltzap/test",
    sources: [{ fileName: "src/x.ts", line: 1, character: 0 }],
    comment: null,
    signatureReturnTypeName: null,
    ...overrides,
  };
}

function makeCache(exports: ReadonlyArray<TypeDocExport>): TypeDocCache {
  return {
    all: exports,
    byPackage: new Map(),
    byFolder: new Map(),
  };
}

describe("isBehavioralExport", () => {
  it("returns true for Function reflections", () => {
    expect(
      isBehavioralExport(makeExport({ kind: ReflectionKind.Function })),
    ).toBe(true);
  });

  it("returns true for Method reflections", () => {
    expect(
      isBehavioralExport(makeExport({ kind: ReflectionKind.Method })),
    ).toBe(true);
  });

  it("returns true for Variables typed as Effect", () => {
    expect(
      isBehavioralExport(
        makeExport({
          kind: ReflectionKind.Variable,
          signatureReturnTypeName: "Effect",
        }),
      ),
    ).toBe(true);
  });

  it("returns true for Variables typed as Layer / Stream / Scope", () => {
    for (const name of ["Layer", "Stream", "Scope", "Schedule", "Fiber"]) {
      expect(
        isBehavioralExport(
          makeExport({
            kind: ReflectionKind.Variable,
            signatureReturnTypeName: name,
          }),
        ),
      ).toBe(true);
    }
  });

  it("returns false for TypeBox schemas and other non-Effect Variables", () => {
    expect(
      isBehavioralExport(
        makeExport({
          kind: ReflectionKind.Variable,
          signatureReturnTypeName: "TObject",
        }),
      ),
    ).toBe(false);
    expect(
      isBehavioralExport(
        makeExport({
          kind: ReflectionKind.Variable,
          signatureReturnTypeName: null,
        }),
      ),
    ).toBe(false);
  });

  it("returns false for Class / Interface / TypeAlias", () => {
    expect(isBehavioralExport(makeExport({ kind: ReflectionKind.Class }))).toBe(
      false,
    );
    expect(
      isBehavioralExport(makeExport({ kind: ReflectionKind.Interface })),
    ).toBe(false);
    expect(
      isBehavioralExport(makeExport({ kind: ReflectionKind.TypeAlias })),
    ).toBe(false);
  });
});

describe("computeFlowCoverage", () => {
  it("returns empty list when every behavioral export has both summary and mermaid", () => {
    const ex = makeExport({
      kind: ReflectionKind.Function,
      name: "documented",
      comment: {
        summary: "What it does\n\n```mermaid\nflowchart\n```",
        tags: [],
      },
    });
    expect(computeFlowCoverage(makeCache([ex]))).toEqual([]);
  });

  it("flags functions with no JSDoc summary at all", () => {
    const ex = makeExport({
      kind: ReflectionKind.Function,
      name: "naked",
      comment: null,
    });
    const gaps = computeFlowCoverage(makeCache([ex]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.symbol).toBe("naked");
    expect(gaps[0]?.reason).toBe("no-summary-or-flow");
  });

  it("flags functions with summary but no flow", () => {
    const ex = makeExport({
      kind: ReflectionKind.Function,
      name: "proseOnly",
      comment: { summary: "Just prose, no diagram.", tags: [] },
    });
    const gaps = computeFlowCoverage(makeCache([ex]));
    expect(gaps[0]?.reason).toBe("no-flow");
  });

  it("clears coverage when flow lives in summary even without prose", () => {
    const ex = makeExport({
      kind: ReflectionKind.Function,
      name: "diagramOnly",
      comment: { summary: "```mermaid\nflowchart\n```", tags: [] },
    });
    expect(computeFlowCoverage(makeCache([ex]))).toEqual([]);
  });

  it("skips non-behavioral exports entirely", () => {
    const ex = makeExport({
      kind: ReflectionKind.Class,
      name: "MyClass",
      comment: null,
    });
    expect(computeFlowCoverage(makeCache([ex]))).toEqual([]);
  });

  it("detects mermaid in @example tags", () => {
    const ex = makeExport({
      kind: ReflectionKind.Function,
      name: "viaExample",
      comment: {
        summary: "Has prose",
        tags: [{ tag: "@example", content: "```mermaid\nflowchart\n```" }],
      },
    });
    expect(computeFlowCoverage(makeCache([ex]))).toEqual([]);
  });

  it("sorts gaps by file then line", () => {
    const exports: TypeDocExport[] = [
      makeExport({
        kind: ReflectionKind.Function,
        name: "b",
        sources: [{ fileName: "src/b.ts", line: 5, character: 0 }],
      }),
      makeExport({
        kind: ReflectionKind.Function,
        name: "a2",
        sources: [{ fileName: "src/a.ts", line: 20, character: 0 }],
      }),
      makeExport({
        kind: ReflectionKind.Function,
        name: "a1",
        sources: [{ fileName: "src/a.ts", line: 5, character: 0 }],
      }),
    ];
    const gaps = computeFlowCoverage(makeCache(exports));
    expect(gaps.map((g) => g.symbol)).toEqual(["a1", "a2", "b"]);
  });
});
