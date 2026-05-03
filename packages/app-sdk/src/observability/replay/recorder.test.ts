import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { ConfigValidationError, ObservabilityError } from "../../errors.js";
import type { ReplayEvent, SessionId } from "../types.js";
import {
  makeReplayRecorder,
  normalizeBufferLimit,
  ReplayStoreIoError,
  type ReplayStore,
} from "./index.js";

const SESSION_ID = "session-1" as SessionId;

const EVENT: ReplayEvent = {
  sessionId: SESSION_ID,
  method: "apps/onBeforeDispatch",
  requestId: "req-1",
  startedAt: "2026-05-03T00:00:00.000Z",
  durationMs: 12,
  params: { sessionId: SESSION_ID },
  outcome: {
    kind: "ok",
    verdictTag: "grant",
    verdict: { decision: "grant" },
  },
};

describe("ReplayRecorder", () => {
  it("normalizes positive buffer limits into branded values", () => {
    expect(Effect.runSync(normalizeBufferLimit(undefined, "limit"))).toBe(
      "unbounded",
    );
    expect(Effect.runSync(normalizeBufferLimit(3, "limit"))).toBe(3);

    const exit = Effect.runSyncExit(normalizeBufferLimit(0, "limit"));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(ConfigValidationError);
      }
    }
  });

  it("records events and exports a replay bundle with snapshot data", () => {
    const recorder = Effect.runSync(makeReplayRecorder({ bufferLimit: 10 }));

    Effect.runSync(
      recorder.setSnapshotCallback(() =>
        Effect.succeed({ winner: "villagers", rounds: 2 }),
      ),
    );
    Effect.runSync(recorder.record(EVENT));

    const bundle = Effect.runSync(recorder.exportSession(SESSION_ID, "app-1"));

    expect(bundle).toMatchObject({
      schemaVersion: 1,
      sessionId: SESSION_ID,
      appId: "app-1",
      startedAt: EVENT.startedAt,
      truncated: false,
      appData: { winner: "villagers", rounds: 2 },
    });
    expect(bundle?.traceEvents).toEqual([EVENT]);
  });

  it("surfaces store write failures through the observability callback", () => {
    const emitted: ObservabilityError[] = [];
    const storeError = new ReplayStoreIoError({
      reason: "WriteFailed",
      path: "/tmp/replay",
      message: "write failed",
    });
    const store: ReplayStore = {
      put: () => Effect.fail(storeError),
      readAll: () => Effect.succeed(null),
      clearSession: () => Effect.void,
      clearAll: Effect.void,
      evict: Effect.void,
    };
    const recorder = Effect.runSync(
      makeReplayRecorder({
        store,
        emitObservabilityError: (err) => {
          emitted.push(err);
        },
      }),
    );

    const exit = Effect.runSyncExit(recorder.record(EVENT));

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBeInstanceOf(ObservabilityError);
  });

  it("rejects duplicate snapshot callbacks", () => {
    const recorder = Effect.runSync(makeReplayRecorder({}));

    Effect.runSync(recorder.setSnapshotCallback(() => Effect.succeed({})));
    const exit = Effect.runSyncExit(
      recorder.setSnapshotCallback(() => Effect.succeed({})),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
