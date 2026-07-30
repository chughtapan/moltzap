import { describe, expect, it } from "vitest";
import { normalizeSourcePath } from "../typedoc-load.js";

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
