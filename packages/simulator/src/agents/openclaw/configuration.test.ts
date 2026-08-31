/** @file Pins the OpenClaw configuration rendered for application containers. */

import { assert, describe, it } from "@effect/vitest";
import { AgentName } from "@moltzap/identity";
import { Redacted, Schema } from "effect";

import { buildOpenClawConfig } from "./configuration.js";

const CALENDAR_URL = "https://calendar.test/mcp/opaque-token";

function stdioMcpServerRenders() {
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
}

function mcpSection(
  mcpServers: Parameters<typeof buildOpenClawConfig>[0]["mcpServers"],
) {
  return openClawConfig(mcpServers).mcp?.servers;
}

function privateSessionsUseOpenClawConfiguration() {
  assert.deepStrictEqual(openClawConfig(undefined, "private").session, {
    dmScope: "per-account-channel-peer",
  });
}

function socialMessagesJoinActiveTurn() {
  assert.deepStrictEqual(openClawConfig(undefined).messages, {
    queue: { mode: "steer", cap: 100, drop: "new" },
    inbound: { debounceMs: 0 },
  });
}

function sharedSessionsUseOpenClawDefaults() {
  assert.notProperty(openClawConfig(undefined, "shared"), "session");
}

function openClawConfig(
  mcpServers: Parameters<typeof buildOpenClawConfig>[0]["mcpServers"],
  messagingMode: "shared" | "private" = "shared",
) {
  return buildOpenClawConfig(
    {
      agentName: Schema.decodeUnknownSync(AgentName)("alice"),
      gatewayToken: Redacted.make("token"),
      messagingMode,
      mcpServers,
    },
    "/var/run/moltzap/bootstrap/workspace",
  );
}

describe("buildOpenClawConfig", () => {
  it(
    "renders a command definition as a stdio transport",
    stdioMcpServerRenders,
  );

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

  it("loads and enables the mounted channel adapter", () => {
    assert.deepStrictEqual(openClawConfig(undefined).plugins, {
      load: {
        paths: ["/var/run/moltzap/bootstrap/openclaw-channel"],
      },
      entries: { "openclaw-channel": { enabled: true } },
    });
  });

  it(
    "leaves the default host session scope unchanged",
    sharedSessionsUseOpenClawDefaults,
  );

  it(
    "configures private sessions through OpenClaw's own setting",
    privateSessionsUseOpenClawConfiguration,
  );

  it(
    "steers new social messages into an active OpenClaw turn",
    socialMessagesJoinActiveTurn,
  );
});
