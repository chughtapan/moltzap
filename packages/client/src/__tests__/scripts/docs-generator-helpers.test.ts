import { describe, expect, it } from "vitest";
import {
  readPackageVersion,
  readTopLevelStringConst,
} from "../../../scripts/docs-generator.helpers.js";

const SAMPLE_VERSION = "2026.524.1";
const SAMPLE_VERSION_SRC = `export const PROTOCOL_VERSION = "${SAMPLE_VERSION}";`;
const VERSION_IDENTIFIER = "PROTOCOL_VERSION";

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
