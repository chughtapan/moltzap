/**
 * @file The simulator honors per-agent NanoClaw modelId and MCP mounts
 * through the eval agent group's container config; these tests pin the
 * env-to-config wiring against the stubbed container-config module.
 */
// @agent-code-guard/regression-only: the wiring maps two env vars onto two config columns; there is no algebra to property-test
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvalContainerDefaults } from "../channels/moltzap.js";
import {
  recordedContainerConfig,
  resetRecordedContainerConfigs,
} from "../db/container-configs.js";

const GROUP = "eval-agent";
const MODEL = "model-under-test";

afterEach(() => {
  vi.unstubAllEnvs();
  resetRecordedContainerConfigs();
});

describe("applyEvalContainerDefaults", () => {
  it("writes MOLTZAP_AGENT_MODEL into the container config's model column", () => {
    vi.stubEnv("MOLTZAP_AGENT_MODEL", MODEL);
    applyEvalContainerDefaults(GROUP);
    expect(recordedContainerConfig(GROUP).scalars["model"]).toBe(MODEL);
  });

  it("writes MOLTZAP_MCP_SERVERS into the container config's mcp_servers column", () => {
    const servers = {
      notes: { command: "node", args: ["notes.mjs"], env: {} },
    };
    vi.stubEnv("MOLTZAP_MCP_SERVERS", JSON.stringify(servers));
    applyEvalContainerDefaults(GROUP);
    expect(recordedContainerConfig(GROUP).json["mcp_servers"]).toStrictEqual(
      servers,
    );
  });

  it("leaves the config untouched when neither variable is set", () => {
    applyEvalContainerDefaults(GROUP);
    expect(recordedContainerConfig(GROUP).scalars).toStrictEqual({});
    expect(recordedContainerConfig(GROUP).json).toStrictEqual({});
  });
});
