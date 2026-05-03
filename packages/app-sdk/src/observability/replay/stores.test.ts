import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import type { ReplayEvent, SessionId } from "../types.js";
import {
  MakeFileSystemStore,
  MakeInMemoryStore,
  ReplayStoreIoError,
  ReplayStorePathError,
  type ReplayStore,
} from "./stores.js";

const SESSION_ID = "session-store" as SessionId;

const event = (requestId: string, durationMs = 1): ReplayEvent => ({
  sessionId: SESSION_ID,
  method: "apps/onBeforeMessageDelivery",
  requestId,
  startedAt: "2026-05-03T00:00:00.000Z",
  durationMs,
  params: { sessionId: SESSION_ID },
  outcome: {
    kind: "ok",
    verdictTag: "allow",
    verdict: { block: false },
  },
});

const limits = {
  bufferLimit: 2 as const,
  maxSessions: "unbounded" as const,
  softWarnThreshold: 100,
  logger: { warn: () => {} },
};

const makeFileStore = async (): Promise<{
  readonly rootDir: string;
  readonly store: ReplayStore;
}> => {
  const rootDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "moltzap-replay-store-"),
  );
  const store = await Effect.runPromise(
    MakeFileSystemStore({ ...limits, rootDir }),
  );
  return { rootDir, store };
};

describe("ReplayStore implementations", () => {
  it("keeps a bounded replay window in memory", () => {
    const store = Effect.runSync(MakeInMemoryStore(limits));

    Effect.runSync(store.put(SESSION_ID, event("req-1")));
    Effect.runSync(store.put(SESSION_ID, event("req-2")));
    Effect.runSync(store.put(SESSION_ID, event("req-3")));

    const read = Effect.runSync(store.readAll(SESSION_ID));
    expect(read?.truncated).toBe(true);
    expect(read?.events.map((e) => e.requestId)).toEqual(["req-2", "req-3"]);
  });

  it("keeps a bounded replay window on disk", async () => {
    const { store } = await makeFileStore();

    await Effect.runPromise(store.put(SESSION_ID, event("req-1")));
    await Effect.runPromise(store.put(SESSION_ID, event("req-2")));
    await Effect.runPromise(store.put(SESSION_ID, event("req-3")));

    const read = await Effect.runPromise(store.readAll(SESSION_ID));
    expect(read?.truncated).toBe(true);
    expect(read?.events.map((e) => e.requestId)).toEqual(["req-2", "req-3"]);
  });

  it("rejects filesystem roots containing parent traversal", () => {
    const exit = Effect.runSyncExit(
      MakeFileSystemStore({ ...limits, rootDir: "../bad" }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(ReplayStorePathError);
        expect(err.value.reason).toBe("InvalidPath");
      }
    }
  });

  it("validates replay events read back from disk", async () => {
    const { rootDir, store } = await makeFileStore();
    await Effect.runPromise(store.put(SESSION_ID, event("req-1")));
    await fsp.appendFile(
      path.join(rootDir, `${encodeURIComponent(SESSION_ID)}.events.ndjson`),
      JSON.stringify({ ...event("bad"), durationMs: -1 }) + "\n",
      "utf8",
    );

    const exit = await Effect.runPromiseExit(store.readAll(SESSION_ID));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = Cause.failureOption(exit.cause);
      expect(err._tag).toBe("Some");
      if (err._tag === "Some") {
        expect(err.value).toBeInstanceOf(ReplayStoreIoError);
        expect(err.value.reason).toBe("ReadFailed");
      }
    }
  });
});
