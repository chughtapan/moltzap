/**
 * @file The `MOLTZAP_EXPERIMENT_GUIDANCE_PARAMETERS` experiment switch: which
 * descriptions the message tool gives its collective parameters, and how an
 * unusable guidance file fails plugin creation.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLLECTIVE_PARAMETER_VISIBILITY,
  createMoltzapChannelPlugin,
} from "./plugin.js";

const GUIDANCE_PARAMETERS = "MOLTZAP_EXPERIMENT_GUIDANCE_PARAMETERS";
const CONFIG: OpenClawConfig = {
  channels: { moltzap: { accounts: [{ id: "primary" }] } },
};
const COLLECTIVE_GUIDANCE =
  "Experimental guidance for the collective operation.";
const RESPONSE_GUIDANCE = "Experimental guidance for answering a request.";

/** One message tool parameter schema as the plugin contributes it. */
interface ParameterSchema {
  readonly description?: string;
}

/** One message tool schema contribution as the plugin describes it. */
interface Contribution {
  readonly visibility?: string;
  readonly properties: Readonly<Record<string, ParameterSchema>>;
}

let directory = "";

describe("OpenClaw guidance-override experiment switch", () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "moltzap-guidance-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it(
    "replaces both collective parameter descriptions and keeps their schemas",
    overrideReplacesBothDescriptions,
  );
  it(
    "keeps the default description for a parameter the file omits",
    overrideKeepsOmittedDescription,
  );
  it(
    "offers the default descriptions when the switch is absent",
    switchAbsentKeepsDefaults,
  );
  it(
    "fails plugin creation naming the switch when the file is missing",
    missingFileFailsCreation,
  );
  it.each([
    ["is not JSON", "{"],
    ["names another parameter", '{"collective_response":"x"}'],
    ["gives a description that is not a string", '{"collective":1}'],
    ["is not an object", '"collective"'],
  ])(
    "fails plugin creation naming the switch when the file %s",
    invalidFileFailsCreation,
  );
});

function overrideReplacesBothDescriptions() {
  vi.stubEnv(GUIDANCE_PARAMETERS, undefined);
  const defaults = contribution();
  stubGuidanceFile(
    JSON.stringify({
      collective: COLLECTIVE_GUIDANCE,
      collectiveResponse: RESPONSE_GUIDANCE,
    }),
  );

  const overridden = contribution();

  expect(overridden.visibility).toBe(COLLECTIVE_PARAMETER_VISIBILITY);
  expect(overridden.properties).toEqual({
    collective: {
      ...defaults.properties.collective,
      description: COLLECTIVE_GUIDANCE,
    },
    collectiveResponse: {
      ...defaults.properties.collectiveResponse,
      description: RESPONSE_GUIDANCE,
    },
  });
}

function overrideKeepsOmittedDescription() {
  vi.stubEnv(GUIDANCE_PARAMETERS, undefined);
  const defaults = contribution();
  stubGuidanceFile(JSON.stringify({ collectiveResponse: RESPONSE_GUIDANCE }));

  const overridden = contribution();

  expect(overridden.properties.collective).toEqual(
    defaults.properties.collective,
  );
  expect(overridden.properties.collectiveResponse?.description).toBe(
    RESPONSE_GUIDANCE,
  );
}

function switchAbsentKeepsDefaults() {
  vi.stubEnv(GUIDANCE_PARAMETERS, undefined);

  const { properties } = contribution();

  expect(properties.collective?.description).toMatch(
    /^The MoltZap collective operation; the moltzap-collectives skill describes each\./u,
  );
  expect(properties.collectiveResponse?.description).toMatch(
    /^Answer a MoltZap collective request turn once with the reply action and this parameter only; the moltzap-collectives skill describes it\./u,
  );
}

function missingFileFailsCreation() {
  vi.stubEnv(GUIDANCE_PARAMETERS, join(directory, "absent.json"));

  expect(() => createMoltzapChannelPlugin()).toThrow(GUIDANCE_PARAMETERS);
}

/**
 * Plugin creation fails naming the switch for one unusable file content.
 * @param fileCase The case name, used only in the test title.
 * @param text The guidance file's content.
 */
function invalidFileFailsCreation(fileCase: string, text: string) {
  stubGuidanceFile(text);

  expect(() => createMoltzapChannelPlugin(), fileCase).toThrow(
    GUIDANCE_PARAMETERS,
  );
}

function stubGuidanceFile(text: string) {
  const path = join(directory, "parameters.json");
  writeFileSync(path, text);
  vi.stubEnv(GUIDANCE_PARAMETERS, path);
}

/**
 * Merges the plugin's message tool schema contributions, one per action, into
 * the parameters the model sees, and the visibility they share.
 */
function contribution(): Contribution {
  const schema = createMoltzapChannelPlugin().actions?.describeMessageTool({
    cfg: CONFIG,
  })?.schema;
  if (!Array.isArray(schema)) {
    throw new Error("expected one message tool schema contribution per action");
  }
  const visibilities = new Set(schema.map(({ visibility }) => visibility));
  expect(visibilities.size).toBe(1);
  return {
    visibility: schema[0]?.visibility,
    properties: Object.fromEntries(
      schema.flatMap(({ properties }) => Object.entries(properties)),
    ),
  };
}
