import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import type { ReplayBundle, ReplayEvent, SessionId } from "./types.js";
import { makeTranscriptWriter, TranscriptWriterError } from "./writer.js";

const SESSION_ID = "session-writer" as SessionId;

const TRACE_EVENT: ReplayEvent = {
  sessionId: SESSION_ID,
  method: "apps/onClose",
  requestId: "req-close",
  startedAt: "2026-05-03T00:00:00.000Z",
  durationMs: 5,
  params: { sessionId: SESSION_ID },
  outcome: {
    kind: "ok",
    verdictTag: "void",
    verdict: {},
  },
};

const BUNDLE: ReplayBundle = {
  schemaVersion: 1,
  sessionId: SESSION_ID,
  appId: "arena-app",
  startedAt: "2026-05-03T00:00:00.000Z",
  finishedAt: "2026-05-03T00:01:00.000Z",
  traceEvents: [TRACE_EVENT],
  truncated: false,
  appData: {
    winner: "villagers",
    rounds: 3,
    phase: "complete",
  },
};

describe("TranscriptWriter", () => {
  it("writes the arena-live transcript shape used by arena captures", async () => {
    const outDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "moltzap-transcript-"),
    );
    const writer = Effect.runSync(makeTranscriptWriter());

    const outputPath = await Effect.runPromise(
      writer.write(
        BUNDLE,
        {
          kind: "arena-live",
          model: "gpt 5.5",
          playerCount: 7,
          gameNumber: 42,
          status: "complete",
        },
        outDir,
      ),
    );
    const raw = await fsp.readFile(outputPath, "utf8");

    expect(JSON.parse(raw)).toEqual({
      meta: {
        model: "gpt 5.5",
        playerCount: 7,
        gameNumber: 42,
        startedAt: BUNDLE.startedAt,
        finishedAt: BUNDLE.finishedAt,
        winner: "villagers",
        rounds: 3,
        status: "complete",
      },
      gameplay: BUNDLE.appData,
      traceEvents: BUNDLE.traceEvents,
    });
    expect(outputPath).toContain("arena-live-42-gpt-5.5-");
  });

  it("rejects output directories containing parent traversal", () => {
    const writer = Effect.runSync(makeTranscriptWriter());

    const exit = Effect.runSyncExit(
      writer.write(BUNDLE, { kind: "generic", attributes: {} }, "../bad"),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(TranscriptWriterError);
        expect(err.value.reason).toBe("InvalidOutDir");
      }
    }
  });
});
