/** @file Pins MCP transport snapshots and secret-free run projections. */

import { assert, describe, it } from "@effect/vitest";
import {
  mcpConfiguration,
  type McpServer,
  snapshotMcpServers,
} from "./workspace.js";

const STDIO: McpServer = {
  name: "files",
  command: "files-mcp",
  args: ["--root", "."],
  env: { PRIVATE_TOKEN: "secret-value" },
};
const URL_A = "https://calendar.test/mcp/token-alpha";
const URL_B = "https://calendar.test/mcp/token-beta";
const HTTP: McpServer = { name: "calendar", url: URL_A };

describe("snapshotMcpServers", () => {
  it("passes both server shapes through frozen and intact", () => {
    const snapshot = snapshotMcpServers([STDIO, HTTP]);

    assert.deepStrictEqual(snapshot, [STDIO, HTTP]);
    assert.isTrue(Object.isFrozen(snapshot));
    assert.isTrue(Object.isFrozen(snapshot?.[0]));
    assert.isTrue(Object.isFrozen(snapshot?.[1]));
  });

  it("refuses an unparseable remote URL at definition time", () => {
    assert.throws(() =>
      snapshotMcpServers([{ name: "calendar", url: "not a url" }]),
    );
  });
});

describe("mcpConfiguration", () => {
  it("redacts the complete URL from remote-server evidence", () => {
    const [record] = mcpConfiguration([HTTP]);

    assert.deepStrictEqual(record?.redacted, ["url"]);
    assert.notInclude(JSON.stringify(record), URL_A);
  });

  it("keeps the existing stdio redaction shape", () => {
    const [record] = mcpConfiguration([STDIO]);

    assert.deepStrictEqual(record?.redacted, [
      "command",
      "args",
      "environmentValues",
    ]);
    assert.notInclude(JSON.stringify(record), "secret-value");
  });

  it("digests remote servers by origin and name, never token path", () => {
    const [alpha] = mcpConfiguration([{ name: "calendar", url: URL_A }]);
    const [beta] = mcpConfiguration([{ name: "calendar", url: URL_B }]);
    const [other] = mcpConfiguration([{ name: "notes", url: URL_A }]);

    assert.strictEqual(alpha?.definitionDigest, beta?.definitionDigest);
    assert.notStrictEqual(alpha?.definitionDigest, other?.definitionDigest);
  });
});
