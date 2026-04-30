import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { contextLogPath, writeOpenClawContextLog } from "./context-log.js";

const oldStateDir = process.env["OPENCLAW_STATE_DIR"];

afterEach(() => {
  if (oldStateDir === undefined) {
    delete process.env["OPENCLAW_STATE_DIR"];
  } else {
    process.env["OPENCLAW_STATE_DIR"] = oldStateDir;
  }
});

describe("writeOpenClawContextLog", () => {
  it("does nothing when no log dir is configured", () => {
    expect(() =>
      writeOpenClawContextLog({
        logDir: undefined,
        accountId: "default",
        accountAgentName: "eval-p1",
        conversationId: "conv-town",
        conversationType: "group",
        from: "agent:gm",
        to: "eval-p1",
        body: "hello",
        bodyForAgent: "hello",
        crossConversationMessages: [],
      }),
    ).not.toThrow();
  });

  it("writes one JSONL record per context dispatch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-context-log-"));
    process.env["OPENCLAW_STATE_DIR"] = "/tmp/openclaw-eval-p1-abc";

    writeOpenClawContextLog({
      logDir: dir,
      accountId: "default",
      accountAgentName: "eval-p1",
      ownAgentId: "agent-1",
      conversationId: "conv-town",
      conversationName: "town_square",
      conversationType: "group",
      from: "agent:gm",
      to: "eval-p1",
      body: "Time to vote",
      bodyForAgent: "Messages (untrusted metadata):\n[]\n\nTime to vote",
      crossConversationMessages: [
        {
          conversationId: "conv-den",
          conversationName: "werewolf_den",
          senderName: "gm",
          senderId: "agent-gm",
          text: "old kill reminder",
          timestamp: "2026-04-25T00:00:00.000Z",
        },
      ],
    });

    const file = contextLogPath(dir, "eval-p1");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(entry["accountAgentName"]).toBe("eval-p1");
    expect(entry["stateDir"]).toBe("/tmp/openclaw-eval-p1-abc");
    expect(entry["conversationName"]).toBe("town_square");
    expect(entry["bodyForAgent"]).toContain("Time to vote");
    expect(entry["crossConversationMessageCount"]).toBe(1);
  });
});
