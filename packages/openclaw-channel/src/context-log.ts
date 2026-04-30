import fs from "node:fs";
import path from "node:path";

import type { CrossConvMessage } from "@moltzap/client";

export interface OpenClawContextLogEntry {
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  readonly pid: number;
  readonly cwd: string;
  readonly stateDir?: string;
  readonly accountId: string;
  readonly accountAgentName?: string;
  readonly ownAgentId?: string;
  readonly conversationId: string;
  readonly conversationName?: string;
  readonly conversationType: "direct" | "group";
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly bodyForAgent: string;
  readonly crossConversationMessageCount: number;
  readonly crossConversationMessages: readonly CrossConvMessage[];
}

export interface OpenClawContextLogInput {
  readonly logDir: string | undefined;
  readonly accountId: string;
  readonly accountAgentName?: string;
  readonly ownAgentId?: string;
  readonly conversationId: string;
  readonly conversationName?: string;
  readonly conversationType: "direct" | "group";
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly bodyForAgent: string;
  readonly crossConversationMessages: readonly CrossConvMessage[];
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.length > 0 ? sanitized : "unknown";
}

export function contextLogPath(
  logDir: string,
  accountAgentName: string | undefined,
): string {
  const stateDir = process.env["OPENCLAW_STATE_DIR"];
  const stateName = stateDir ? path.basename(stateDir) : `pid-${process.pid}`;
  const agentName = accountAgentName ?? "agent";
  return path.join(
    logDir,
    `${sanitizePathPart(agentName)}.${sanitizePathPart(stateName)}.${process.pid}.contexts.jsonl`,
  );
}

export function writeOpenClawContextLog(input: OpenClawContextLogInput): void {
  if (!input.logDir) return;

  const entry: OpenClawContextLogEntry = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    pid: process.pid,
    cwd: process.cwd(),
    ...(process.env["OPENCLAW_STATE_DIR"] !== undefined
      ? { stateDir: process.env["OPENCLAW_STATE_DIR"] }
      : {}),
    accountId: input.accountId,
    ...(input.accountAgentName !== undefined
      ? { accountAgentName: input.accountAgentName }
      : {}),
    ...(input.ownAgentId !== undefined ? { ownAgentId: input.ownAgentId } : {}),
    conversationId: input.conversationId,
    ...(input.conversationName !== undefined
      ? { conversationName: input.conversationName }
      : {}),
    conversationType: input.conversationType,
    from: input.from,
    to: input.to,
    body: input.body,
    bodyForAgent: input.bodyForAgent,
    crossConversationMessageCount: input.crossConversationMessages.length,
    crossConversationMessages: input.crossConversationMessages,
  };

  fs.mkdirSync(input.logDir, { recursive: true });
  fs.appendFileSync(
    contextLogPath(input.logDir, input.accountAgentName),
    `${JSON.stringify(entry)}\n`,
    "utf8",
  );
}
