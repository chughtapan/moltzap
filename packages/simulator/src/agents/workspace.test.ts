/** @file Pins MCP transport snapshots and secret-free run projections. */

import { assert, describe, it } from "@effect/vitest";
import {
  harvestTargets,
  MAX_HARVESTED_FILE_BYTES,
  mcpConfiguration,
  type McpServer,
  snapshotHarvestPaths,
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

describe("snapshotHarvestPaths", () => {
  it("normalizes each path and freezes the snapshot", () => {
    const snapshot = snapshotHarvestPaths(["./CALENDAR.md", "notes//log.md"]);

    assert.deepStrictEqual([...snapshot], ["CALENDAR.md", "notes/log.md"]);
    assert.isTrue(Object.isFrozen(snapshot));
  });

  it("is empty when the experiment names nothing", () => {
    assert.deepStrictEqual([...snapshotHarvestPaths()], []);
  });

  it("refuses paths that leave the workspace at definition time", () => {
    for (const relativePath of [
      "",
      "..",
      "../escape.md",
      "/etc/passwd",
      "a\\b",
    ]) {
      assert.throws(() => snapshotHarvestPaths([relativePath]));
    }
  });

  it("refuses two spellings of one file", () => {
    assert.throws(() => snapshotHarvestPaths(["CALENDAR.md", "./CALENDAR.md"]));
  });

  it("refuses the daemon transcript's own label", () => {
    assert.throws(
      () => snapshotHarvestPaths(["moltzap-history.ndjson"]),
      /daemon transcript/u,
    );
  });
});

describe("harvestTargets", () => {
  it("places each checked path under the runtime's effective workspace with the bound", () => {
    const targets = harvestTargets(
      "/var/lib/moltzap/nanoclaw/groups/agent",
      snapshotHarvestPaths(["CALENDAR.md", "notes/log.md"]),
    );

    assert.deepStrictEqual(targets, [
      {
        relativePath: "CALENDAR.md",
        path: "/var/lib/moltzap/nanoclaw/groups/agent/CALENDAR.md",
        limitBytes: MAX_HARVESTED_FILE_BYTES,
      },
      {
        relativePath: "notes/log.md",
        path: "/var/lib/moltzap/nanoclaw/groups/agent/notes/log.md",
        limitBytes: MAX_HARVESTED_FILE_BYTES,
      },
    ]);
    assert.isTrue(Object.isFrozen(targets));
  });
});
