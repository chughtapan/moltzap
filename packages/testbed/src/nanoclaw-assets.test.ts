import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TESTBED_PROFILE_NAME } from "./channel-plugin-install.js";

const INJECTED_CHANNEL_TEXT =
  "already injects and starts the `moltzap` channel";
const PROFILE_TEXT = `\`${TESTBED_PROFILE_NAME}\` profile`;
const SEND_MESSAGE_TOOL = "`mcp__nanoclaw__send_message`";
const UNSAFE_SETUP_PATTERN =
  /(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b|@latest|openclaw/i;

const skill = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../nanoclaw-assets/SKILL.md"),
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
