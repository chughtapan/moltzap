/** @file Pins native OpenClaw MCP transport configuration rendering. */

import { assert, describe, it } from "@effect/vitest";
import { agentName } from "@moltzap/protocol/testing";
import { Redacted } from "effect";

import { buildOpenClawConfig } from "./configuration.js";

const CALENDAR_URL = "https://calendar.test/mcp/opaque-token";

function mcpSection(
  mcpServers: Parameters<typeof buildOpenClawConfig>[0]["mcpServers"],
) {
  const config = buildOpenClawConfig(
    {
      agentName: agentName("alice"),
      gatewayToken: Redacted.make("token"),
      mcpServers,
    },
    "/var/run/moltzap/bootstrap/workspace",
  );
  return config.mcp?.servers;
}

describe("buildOpenClawConfig MCP servers", () => {
  it("renders a command definition as a stdio transport", () => {
    assert.deepStrictEqual(
      mcpSection([
        {
          name: "files",
          command: "files-mcp",
          args: ["--root", "."],
          env: { A: "1" },
        },
      ]),
      {
        files: {
          transport: "stdio",
          command: "files-mcp",
          args: ["--root", "."],
          env: { A: "1" },
        },
      },
    );
  });

  it("renders a URL definition as a streamable-http transport", () => {
    assert.deepStrictEqual(
      mcpSection([{ name: "calendar", url: CALENDAR_URL }]),
      {
        calendar: { transport: "streamable-http", url: CALENDAR_URL },
      },
    );
  });

  it("omits the MCP section without servers", () => {
    assert.isUndefined(mcpSection(undefined));
  });
});
