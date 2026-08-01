import { describe, expect, it } from "vitest";
import {
  escapeMdxProse,
  readPackageVersion,
  readTopLevelStringConst,
} from "../../../scripts/generate-cli-docs.helpers.js";

const SAMPLE_VERSION = "2026.524.1";
const SAMPLE_VERSION_SRC = `export const PROTOCOL_VERSION = "${SAMPLE_VERSION}";`;
const VERSION_IDENTIFIER = "PROTOCOL_VERSION";
const RAW_HELP_PROSE =
  "Use <name> or conv:<conversationId>; keep `profiles.<name>` literal.";
const ESCAPED_HELP_PROSE =
  "Use &lt;name&gt; or conv:&lt;conversationId&gt;; keep `profiles.<name>` literal.";

describe("escapeMdxProse", () => {
  it("escapes placeholders in prose while preserving inline code", () => {
    expect(escapeMdxProse(RAW_HELP_PROSE)).toBe(ESCAPED_HELP_PROSE);
  });

  it("preserves fenced and indented code while escaping MDX expressions", () => {
    expect(
      escapeMdxProse(
        [
          "Outside {value}",
          "```text",
          "<inside>",
          "```",
          "    <indented>",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Outside &#123;value&#125;",
        "```text",
        "<inside>",
        "```",
        "    <indented>",
      ].join("\n"),
    );
  });
});

describe("readPackageVersion", () => {
  it("extracts the canonical package version", () => {
    expect(
      readPackageVersion(JSON.stringify({ version: SAMPLE_VERSION })),
    ).toEqual({ _tag: "ok", value: SAMPLE_VERSION });
  });

  it("rejects malformed JSON and missing version fields", () => {
    expect(readPackageVersion("{")._tag).toBe("err");
    expect(readPackageVersion(JSON.stringify({ name: "example" }))._tag).toBe(
      "err",
    );
  });
});

describe("readTopLevelStringConst", () => {
  it("extracts a string constant declaration", () => {
    const result = readTopLevelStringConst(
      SAMPLE_VERSION_SRC,
      VERSION_IDENTIFIER,
    );
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value).toBe(SAMPLE_VERSION);
    }
  });

  it("returns an err result when the identifier is missing", () => {
    const result = readTopLevelStringConst(
      `const OTHER = "x";`,
      VERSION_IDENTIFIER,
    );
    expect(result._tag).toBe("err");
    if (result._tag === "err") {
      expect(result.reason).toContain(VERSION_IDENTIFIER);
    }
  });

  it("returns an err result when the initializer is not a string literal", () => {
    const result = readTopLevelStringConst(
      `const ${VERSION_IDENTIFIER} = 12345;`,
      VERSION_IDENTIFIER,
    );
    expect(result._tag).toBe("err");
  });
});
