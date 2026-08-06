import { Redacted } from "effect";
import { assert, describe, it } from "@effect/vitest";
import { agentName } from "@moltzap/protocol/testing";
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

  it("renders a url definition as a streamable-http transport", () => {
    assert.deepStrictEqual(
      mcpSection([{ name: "calendar", url: CALENDAR_URL }]),
      {
        calendar: { transport: "streamable-http", url: CALENDAR_URL },
      },
    );
  });

  it("omits the mcp section without servers", () => {
    assert.isUndefined(mcpSection(undefined));
  });
});
