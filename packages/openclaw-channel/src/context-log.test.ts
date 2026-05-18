import { FileSystem, Path } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import { writeOpenClawContextLog } from "./context-log.js";

const it = effectIt.scoped;

const CONTEXT_LOG_DIR_PREFIX = "oc-context-log-";
const CONTEXT_LOG_FILE_ENCODING = "utf8";
const JSON_LINES_SEPARATOR = "\n";
const SINGLE_CONTEXT_LOG_ENTRY_COUNT = 1;

const ACCOUNT_ID = "default";
const ACCOUNT_AGENT_NAME = "eval-p1";
const OWN_AGENT_ID = "agent-1";
const STATE_DIR_BASENAME = "openclaw-eval-p1-abc";
const CONVERSATION_ID = "conv-town";
const CONVERSATION_NAME = "town_square";
const CROSS_CONVERSATION_ID = "conv-den";
const CROSS_CONVERSATION_NAME = "werewolf_den";
const FROM_AGENT = "agent:gm";
const TO_AGENT = "eval-p1";
const CONTEXT_BODY = "Time to vote";
const BODY_FOR_AGENT = "Messages (untrusted metadata):\n[]\n\nTime to vote";
const CROSS_CONVERSATION_TEXT = "old kill reminder";
const CROSS_CONVERSATION_TIMESTAMP = "2026-04-25T00:00:00.000Z";

const ContextLogEntrySchema = Schema.Struct({
  accountAgentName: Schema.String,
  stateDir: Schema.String,
  conversationName: Schema.String,
  bodyForAgent: Schema.String,
  crossConversationMessageCount: Schema.Number,
});
type ContextLogEntry = Schema.Schema.Type<typeof ContextLogEntrySchema>;

class ContextLogTestError extends Error {
  override readonly name = "ContextLogTestError";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

const decodeContextLogEntry = Schema.decodeUnknown(ContextLogEntrySchema);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("writeOpenClawContextLog", () => {
  it("does nothing when no log dir is configured", skipsMissingLogDir);

  it("writes one JSONL record per context dispatch", writesContextRecord);
});

function skipsMissingLogDir() {
  return writeOpenClawContextLog({
    logDir: undefined,
    accountId: ACCOUNT_ID,
    accountAgentName: ACCOUNT_AGENT_NAME,
    conversationId: CONVERSATION_ID,
    conversationType: "group",
    from: FROM_AGENT,
    to: TO_AGENT,
    body: CONTEXT_BODY,
    bodyForAgent: CONTEXT_BODY,
    crossConversationMessages: [],
  });
}

function writesContextRecord() {
  return withNodeContext(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: CONTEXT_LOG_DIR_PREFIX,
      });
      const stateDir = path.join(logDir, STATE_DIR_BASENAME);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

      yield* writeOpenClawContextLog({
        logDir,
        accountId: ACCOUNT_ID,
        accountAgentName: ACCOUNT_AGENT_NAME,
        ownAgentId: OWN_AGENT_ID,
        conversationId: CONVERSATION_ID,
        conversationName: CONVERSATION_NAME,
        conversationType: "group",
        from: FROM_AGENT,
        to: TO_AGENT,
        body: CONTEXT_BODY,
        bodyForAgent: BODY_FOR_AGENT,
        crossConversationMessages: [
          {
            conversationId: CROSS_CONVERSATION_ID,
            conversationName: CROSS_CONVERSATION_NAME,
            senderName: "gm",
            senderId: "agent-gm",
            text: CROSS_CONVERSATION_TEXT,
            timestamp: CROSS_CONVERSATION_TIMESTAMP,
          },
        ],
      });

      const entry = yield* readSingleContextLogEntry(logDir);

      expect(entry.accountAgentName).toBe(ACCOUNT_AGENT_NAME);
      expect(entry.stateDir).toBe(stateDir);
      expect(entry.conversationName).toBe(CONVERSATION_NAME);
      expect(entry.bodyForAgent).toContain(CONTEXT_BODY);
      expect(entry.crossConversationMessageCount).toBe(
        SINGLE_CONTEXT_LOG_ENTRY_COUNT,
      );
    }),
  );
}

function readSingleContextLogEntry(
  logDir: string,
): Effect.Effect<
  ContextLogEntry,
  ContextLogTestError | Schema.Schema.TypeError<typeof ContextLogEntrySchema>,
  FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fileNames = yield* fileSystem.readDirectory(logDir);
    expect(fileNames).toHaveLength(SINGLE_CONTEXT_LOG_ENTRY_COUNT);
    const [fileName] = fileNames;
    if (fileName === undefined) {
      return yield* Effect.fail(
        new ContextLogTestError("Context log file was not written"),
      );
    }
    const text = yield* fileSystem.readFileString(
      path.join(logDir, fileName),
      CONTEXT_LOG_FILE_ENCODING,
    );
    const [line] = text.trim().split(JSON_LINES_SEPARATOR);
    if (line === undefined) {
      return yield* Effect.fail(
        new ContextLogTestError("Context log file did not contain JSONL"),
      );
    }
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(line),
      catch: (cause) =>
        new ContextLogTestError("Context log entry was not valid JSON", cause),
    });
    return yield* decodeContextLogEntry(parsed);
  });
}

function withNodeContext<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, FileSystem.FileSystem | Path.Path>> {
  return effect.pipe(Effect.provide(NodeContext.layer));
}
