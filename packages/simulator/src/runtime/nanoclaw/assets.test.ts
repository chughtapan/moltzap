import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SIMULATOR_PROFILE_NAME } from "../workspace.js";
import { NANOCLAW_EVAL_AGENT_GROUP_ID } from "./process.js";

const INJECTED_CHANNEL_TEXT =
  "already injects and starts the `moltzap` channel";
const PROFILE_TEXT = `\`${SIMULATOR_PROFILE_NAME}\` profile`;
const SEND_MESSAGE_TOOL = "`mcp__nanoclaw__send_message`";
const UNSAFE_SETUP_PATTERN =
  /(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b|@latest|openclaw/i;
const DIRECT_SCHEMA_WRITE_PATTERN = /\b(?:INSERT|CREATE TABLE)\b/i;
const RUN_MIGRATIONS_CALL = "runMigrations(database)";
const INIT_GROUP_FILESYSTEM_CALL = "initGroupFilesystem(agentGroup)";
// NanoClaw inlines this database path in its src/index.ts without exporting
// it, so the provisioner hardcodes the same literal; pinning it makes an
// upstream bump that moves the database fail here instead of silently
// desynchronizing provisioning.
const RUNTIME_DB_INIT_CALL = 'initDb(path.join(DATA_DIR, "v2.db"))';

const skill = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../nanoclaw-assets/SKILL.md",
  ),
  "utf8",
);
const evalProvision = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../nanoclaw-assets/moltzap-eval-provision.ts",
  ),
  "utf8",
);
const channelSource = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../nanoclaw-channel/src/channels/moltzap.ts",
  ),
  "utf8",
);

describe("NanoClaw MoltZap skill", () => {
  it("documents the injected channel and profile without setup commands", () => {
    expect(skill).toContain(INJECTED_CHANNEL_TEXT);
    expect(skill).toContain(PROFILE_TEXT);
    expect(skill).toContain(SEND_MESSAGE_TOOL);
    expect(skill).not.toMatch(UNSAFE_SETUP_PATTERN);
  });
});

describe("NanoClaw eval provisioning asset", () => {
  it("uses NanoClaw's migration and group-init seams", () => {
    expect(evalProvision).toContain(RUNTIME_DB_INIT_CALL);
    expect(evalProvision).toContain(RUN_MIGRATIONS_CALL);
    expect(evalProvision).toContain(INIT_GROUP_FILESYSTEM_CALL);
    expect(evalProvision).not.toMatch(DIRECT_SCHEMA_WRITE_PATTERN);
  });

  it("shares the channel's stable wiring target", () => {
    expect(channelSource).toContain(
      `EVAL_AGENT_GROUP_ID = "${NANOCLAW_EVAL_AGENT_GROUP_ID}"`,
    );
  });
});
