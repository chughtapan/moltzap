import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { makeMoltZapChannelConfigJsonSchema } from "./openclaw-entry.js";

const DRAFT_07_SCHEMA = "http://json-schema.org/draft-07/schema#";
const EMPTY_REQUIRED_COUNT = 0;

function makeManifestChannelSchema() {
  const { $schema, ...generated } = makeMoltZapChannelConfigJsonSchema();
  expect($schema).toBe(DRAFT_07_SCHEMA);

  if (!("required" in generated)) {
    throw new Error("expected an object schema");
  }
  expect(generated.required).toHaveLength(EMPTY_REQUIRED_COUNT);

  const { required, ...embeddedSchema } = generated;
  return embeddedSchema;
}

describe("openclaw.plugin.json channel config", () => {
  it("matches the schema derived from MoltZapAccount", () => {
    expect(manifest.channelConfigs.moltzap.schema).toEqual(
      makeManifestChannelSchema(),
    );
  });
});
