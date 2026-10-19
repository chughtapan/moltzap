/** @file Tests for the in-place Modules navigation writer. */
import { NodeContext } from "@effect/platform-node";
import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Synchronous filesystem operations create and restore test fixtures outside the Effect under test.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeModulesNav } from "../mintlify-nav.ts";

const write = (path: string, slugs: readonly string[]) =>
  Effect.runPromise(
    writeModulesNav(path, slugs).pipe(Effect.provide(NodeContext.layer)),
  );

const docsJson = (groups: readonly unknown[]): string =>
  `${JSON.stringify(
    {
      $schema: "https://example.invalid/docs.json",
      name: "x",
      navigation: { tabs: [{ tab: "Docs", groups }] },
      footer: { socials: {} },
    },
    null,
    2,
  )}\n`;

const fixture = (groups: readonly unknown[]): string => {
  const path = join(mkdtempSync(join(tmpdir(), "mintlify-nav-")), "docs.json");
  writeFileSync(path, docsJson(groups));
  return path;
};

interface DocsJson {
  readonly navigation: {
    readonly tabs: ReadonlyArray<{
      readonly groups: ReadonlyArray<{
        readonly group: string;
        readonly pages: readonly string[];
      }>;
    }>;
  };
}
const parse = (path: string): DocsJson =>
  /* Safe because The fixture writer emits this shape, and the navigation writer preserves it. */ JSON.parse(
    readFileSync(path, "utf8"),
  ) as DocsJson;

// @agent-code-guard/regression-only: fixed navigation and TypeDoc fixtures exercise distinct formatting and failure regressions.
describe("writeModulesNav", () => {
  // eslint-disable-next-line agent-code-guard/async-keyword -- Vitest awaits this Promise boundary; the implementation under test remains an Effect.
  it("replaces an existing Modules group with the sorted module pages", async () => {
    const path = fixture([{ group: "Modules", pages: ["modules/stale"] }]);
    await write(path, ["router/src", "identity/src"]);
    expect(parse(path).navigation.tabs[0]?.groups).toEqual([
      {
        group: "Modules",
        pages: ["modules/identity/src", "modules/router/src"],
      },
    ]);
  });

  // eslint-disable-next-line agent-code-guard/async-keyword -- Vitest awaits this Promise boundary; the implementation under test remains an Effect.
  it("appends a Modules group after the existing groups when none exists", async () => {
    const path = fixture([{ group: "Guides", pages: ["g"] }]);
    await write(path, ["client/src"]);
    expect(parse(path).navigation.tabs[0]?.groups.map((g) => g.group)).toEqual([
      "Guides",
      "Modules",
    ]);
  });

  // eslint-disable-next-line agent-code-guard/async-keyword -- Vitest awaits this Promise boundary; the implementation under test remains an Effect.
  it("keeps the document's top-level key order and is a no-op when nothing changed", async () => {
    const path = fixture([{ group: "Modules", pages: ["modules/client/src"] }]);
    const before = readFileSync(path, "utf8");
    await write(path, ["client/src"]);
    const after = readFileSync(path, "utf8");
    expect(after).toBe(before);
    expect(Object.keys(parse(path))).toEqual([
      "$schema",
      "name",
      "navigation",
      "footer",
    ]);
  });

  // eslint-disable-next-line agent-code-guard/async-keyword -- Vitest awaits this Promise boundary; the implementation under test remains an Effect.
  it("dies on a document without navigation tabs", async () => {
    const path = join(
      mkdtempSync(join(tmpdir(), "mintlify-nav-")),
      "docs.json",
    );
    writeFileSync(path, '{"name":"x"}\n');
    await expect(write(path, ["client/src"])).rejects.toThrow(/navigation/u);
  });
});
