/**
 * Unit tests for the profile layer. Spec items §5.2 (`--profile`,
 * `--no-persist`), Invariants §4.3 (coexistence), §4.4 (no-disk-write).
 */
import { describe, it } from "vitest";

describe("parseProfileName", () => {
  it.todo("accepts a valid lowercase-alphanumeric name");
  it.todo("rejects an empty string with ProfileInvalidNameError");
  it.todo("rejects a name with uppercase letters");
  it.todo("rejects a name starting or ending with a hyphen");
});

describe("loadLayeredConfig", () => {
  it.todo(
    "missing file resolves with empty view (default undefined, empty profiles)",
  );
  it.todo("legacy top-level { apiKey, agentName } populates `default`");
  it.todo("{ profiles: { alice: ... } } populates the profiles map");
  it.todo(
    "parse error surfaces as ProfileConfigReadError (no silent defaults)",
  );
});

describe("resolveProfileAuth", () => {
  it.todo("undefined name returns the default record");
  it.todo("unknown name returns ProfileNotFoundError (no fallback to default)");
  it.todo("known name returns the named record");
});

describe("writeProfile", () => {
  it.todo(
    "writing under a named profile leaves top-level apiKey untouched (Invariant §4.3)",
  );
  it.todo("writing 'default' updates top-level keys (not under profiles)");
  it.todo("adding a second profile preserves the first");
});

describe("emitNoPersist", () => {
  it.todo("never writes to ~/.moltzap/ (fs diff before/after is empty)");
  it.todo("returns the record unchanged for the caller to print");
});
