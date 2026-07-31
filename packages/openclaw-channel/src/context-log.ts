import { FileSystem, Path } from "@effect/platform";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Config, ConfigProvider, Effect, Option } from "effect";
import type { CrossConvMessage } from "@moltzap/client/channel-base";

interface OpenClawContextLogEntry {
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

const OpenClawStateDir = Config.option(Config.string("OPENCLAW_STATE_DIR"));

function getOpenClawStateDir(): string | undefined {
  return Option.getOrUndefined(
    Effect.runSync(
      OpenClawStateDir.pipe(
        Effect.withConfigProvider(ConfigProvider.fromEnv()),
      ),
    ),
  );
}

function contextLogPath(
  logDir: string,
  accountAgentName: string | undefined,
): Effect.Effect<string, never, Path.Path> {
  const stateDir = getOpenClawStateDir();
  const agentName = accountAgentName ?? "agent";
  return Path.Path.pipe(
    Effect.map((path) => {
      const stateName = stateDir
        ? path.basename(stateDir)
        : `pid-${process.pid}`;
      return path.join(
        logDir,
        `${sanitizePathPart(agentName)}.${sanitizePathPart(stateName)}.${process.pid}.contexts.jsonl`,
      );
    }),
  );
}

export function writeOpenClawContextLog(
  input: OpenClawContextLogInput,
): Effect.Effect<void, unknown, never> {
  const logDir = input.logDir;
  if (!logDir) return Effect.void;
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = getOpenClawStateDir();

    const entry: OpenClawContextLogEntry = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      pid: process.pid,
      cwd: process.cwd(),
      ...(stateDir !== undefined ? { stateDir } : {}),
      accountId: input.accountId,
      ...(input.accountAgentName !== undefined
        ? { accountAgentName: input.accountAgentName }
        : {}),
      ...(input.ownAgentId !== undefined
        ? { ownAgentId: input.ownAgentId }
        : {}),
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

    yield* fileSystem.makeDirectory(logDir, { recursive: true });
    const file = yield* contextLogPath(logDir, input.accountAgentName);
    yield* fileSystem.writeFileString(file, `${JSON.stringify(entry)}\n`, {
      flag: "a",
    });
  }).pipe(
    Effect.withSpan("writeOpenClawContextLog"),
    Effect.provide(NodePath.layer),
    Effect.provide(NodeFileSystem.layer),
  );
}
