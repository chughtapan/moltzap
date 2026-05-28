import { describe, expect, it } from "vitest";
import { parseFailureTag, readLeadingJsDoc } from "../modules.js";

describe("parseFailureTag", () => {
  it("splits on the first ' when '", () => {
    expect(parseFailureTag("NotFoundError when the row is absent")).toEqual({
      errorName: "NotFoundError",
      when: "the row is absent",
    });
  });

  it("falls back to first-token split when 'when' is absent", () => {
    expect(parseFailureTag("ForbiddenError caller is wrong")).toEqual({
      errorName: "ForbiddenError",
      when: "caller is wrong",
    });
  });

  it("returns null `when` for a bare type name", () => {
    expect(parseFailureTag("ForbiddenError")).toEqual({
      errorName: "ForbiddenError",
      when: null,
    });
  });

  it("preserves prose that itself contains ' when '", () => {
    expect(
      parseFailureTag("InvariantError when X when Y also happens"),
    ).toEqual({
      errorName: "InvariantError",
      when: "X when Y also happens",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseFailureTag("  AbortError when interrupted  ")).toEqual({
      errorName: "AbortError",
      when: "interrupted",
    });
  });
});

describe("readLeadingJsDoc", () => {
  it("returns null when source has no leading JSDoc", () => {
    expect(readLeadingJsDoc("export const x = 1;\n")).toBeNull();
    expect(readLeadingJsDoc("\n\nexport const x = 1;\n")).toBeNull();
  });

  it("returns null when the block is unterminated", () => {
    expect(readLeadingJsDoc("/** unterminated")).toBeNull();
  });

  it("lifts @file body as the summary", () => {
    const source = `/**
 * @file This is the purpose.
 *
 * Body prose continues.
 */
export {};
`;
    expect(readLeadingJsDoc(source)).toBe(
      "This is the purpose.\n\nBody prose continues.",
    );
  });

  it("returns the whole block body when no @file tag", () => {
    const source = `/**
 * Plain purpose statement.
 * Second line.
 */
export {};
`;
    expect(readLeadingJsDoc(source)).toBe(
      "Plain purpose statement.\nSecond line.",
    );
  });

  it("strips leading asterisk markup", () => {
    const source = `/**
 * Line one.
 *   Line two indented.
 */
`;
    expect(readLeadingJsDoc(source)).toBe("Line one.\n  Line two indented.");
  });
});
