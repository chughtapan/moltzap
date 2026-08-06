import { assert, describe, it } from "@effect/vitest";
import {
  mcpConfiguration,
  snapshotMcpServers,
  type McpServer,
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
    assert.isTrue(Object.isFrozen(snapshot?.[0]));
    assert.isTrue(Object.isFrozen(snapshot?.[1]));
  });

  it("refuses an unparseable remote url at definition time", () => {
    assert.throws(() =>
      snapshotMcpServers([{ name: "calendar", url: "not a url" }]),
    );
  });
});

describe("mcpConfiguration", () => {
  it("redacts the url on remote servers", () => {
    const [record] = mcpConfiguration([HTTP]);
    assert.deepStrictEqual(record?.redacted, ["url"]);
    assert.notInclude(JSON.stringify(record), URL_A);
  });

  it("keeps the stdio redaction shape", () => {
    const [record] = mcpConfiguration([STDIO]);
    assert.deepStrictEqual(record?.redacted, [
      "command",
      "args",
      "environmentValues",
    ]);
    assert.notInclude(JSON.stringify(record), "secret-value");
  });

  it("digests remote servers by origin only, never the token path", () => {
    const [alpha] = mcpConfiguration([{ name: "calendar", url: URL_A }]);
    const [beta] = mcpConfiguration([{ name: "calendar", url: URL_B }]);
    assert.strictEqual(alpha?.definitionDigest, beta?.definitionDigest);
    const [other] = mcpConfiguration([{ name: "notes", url: URL_A }]);
    assert.notStrictEqual(alpha?.definitionDigest, other?.definitionDigest);
  });
});
