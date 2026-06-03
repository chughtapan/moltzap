import { describe, expect, it } from "vitest";
import * as flatBarrel from "./index.js";

// Negative barrel canary: `AuthenticatedIdentity` is a type-only
// network-internal export and MUST NOT surface as a runtime key on the
// `@moltzap/protocol` flat barrel. Lives at the package root (not inside a leaf
// folder) so importing the barrel is a sibling reference, not a folder→root
// cycle — the barrel surface IS what this canary tests. The type-level half (a
// `@ts-expect-error` import) lives in `barrel-encapsulation.types-check.ts`.
// The network-internal type-only export that must never surface as a runtime
// key. Named so the assertion reads a symbol, not a bare literal.
const NETWORK_INTERNAL_TYPE = "AuthenticatedIdentity";

describe("flat-barrel runtime encapsulation canary", () => {
  it(`@moltzap/protocol does not re-export ${NETWORK_INTERNAL_TYPE}`, () => {
    expect(Object.keys(flatBarrel)).not.toContain(NETWORK_INTERNAL_TYPE);
  });
});
