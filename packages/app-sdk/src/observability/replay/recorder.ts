import { Effect } from "effect";
import { REPLAY_BUNDLE_SCHEMA_VERSION } from "../types.js";
import type {
  BufferLimitInput,
  ReplayBundle,
  ReplayEvent,
  SessionId,
  SessionSnapshot,
  SnapshotCallback,
} from "../types.js";
import { ConfigValidationError, ObservabilityError } from "../../errors.js";
import {
  type BufferLimit,
  MakeInMemoryStore,
  type PositiveInt,
  type ReplayStore,
  type ReplayStoreIoError,
} from "./stores.js";

const DEFAULT_LIMIT: BufferLimit = "unbounded";
const DEFAULT_SOFT_WARN_THRESHOLD = 100_000;
const MIN_POSITIVE_INT = 1;

export interface ReplayRecorderOptions {
  readonly bufferLimit?: BufferLimitInput;
  readonly maxSessions?: BufferLimitInput;
  readonly softWarnThreshold?: number;
  readonly store?: ReplayStore;
  readonly logger?: { readonly warn: (msg: string, ctx?: unknown) => void };
  readonly emitObservabilityError?: (err: ObservabilityError) => void;
}

export interface ReplayRecorder {
  readonly record: (event: ReplayEvent) => Effect.Effect<void, never>;
  readonly setSnapshotCallback: (
    callback: SnapshotCallback,
  ) => Effect.Effect<void, "DuplicateSnapshotCallback">;
  readonly exportSession: (
    sessionId: SessionId,
    appId: string,
  ) => Effect.Effect<ReplayBundle | null, ReplayStoreIoError>;
  readonly clearSession: (sessionId: SessionId) => Effect.Effect<void, never>;
  readonly clearAll: Effect.Effect<void, never>;
}

export function normalizeBufferLimit(
  input: BufferLimitInput | undefined,
  field: string,
): Effect.Effect<BufferLimit, ConfigValidationError> {
  if (input === undefined || input === "unbounded") {
    return Effect.succeed(DEFAULT_LIMIT);
  }
  return Number.isInteger(input) && input >= MIN_POSITIVE_INT
    ? Effect.succeed(input as PositiveInt)
    : Effect.fail(
        new ConfigValidationError(
          field,
          input,
          `${field} must be a positive integer or "unbounded"`,
        ),
      );
}

export function makeReplayRecorder(
  options: ReplayRecorderOptions,
): Effect.Effect<ReplayRecorder, ConfigValidationError> {
  return Effect.gen(function* () {
    const bufferLimit = yield* normalizeBufferLimit(
      options.bufferLimit,
      "observability.replay.bufferLimit",
    );
    const maxSessions = yield* normalizeBufferLimit(
      options.maxSessions,
      "observability.replay.maxSessions",
    );
    const softWarnThreshold = yield* normalizeSoftWarnThreshold(
      options.softWarnThreshold,
    );
    const logger = options.logger ?? { warn: () => {} };
    const emitObservabilityError =
      options.emitObservabilityError ??
      ((err: ObservabilityError) => logger.warn(err.message, err));
    const store =
      options.store ??
      (yield* MakeInMemoryStore({
        bufferLimit,
        maxSessions,
        softWarnThreshold,
        logger,
      }));

    let snapshotCallback: SnapshotCallback | null = null;

    const emitStoreError = (message: string, err: ReplayStoreIoError): void => {
      emitObservabilityError(new ObservabilityError(message, err));
    };

    return {
      record: (event) =>
        store.put(event.sessionId, event).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              emitStoreError("Replay event persistence failed", err);
            }),
          ),
        ),
      setSnapshotCallback: (callback) =>
        Effect.sync(() => {
          if (snapshotCallback !== null) {
            return "DuplicateSnapshotCallback" as const;
          }
          snapshotCallback = callback;
          return null;
        }).pipe(
          Effect.flatMap((result) =>
            result === null ? Effect.void : Effect.fail(result),
          ),
        ),
      exportSession: (sessionId, appId) =>
        Effect.gen(function* () {
          const read = yield* store.readAll(sessionId);
          if (read === null || read.events.length === 0) {
            return null;
          }
          const appData = yield* readSnapshot(
            snapshotCallback,
            sessionId,
            emitObservabilityError,
          );
          const now = new Date().toISOString();
          return {
            schemaVersion: REPLAY_BUNDLE_SCHEMA_VERSION,
            sessionId,
            appId,
            startedAt: read.events[0]?.startedAt ?? now,
            finishedAt: now,
            traceEvents: read.events,
            truncated: read.truncated,
            appData,
          };
        }),
      clearSession: (sessionId) =>
        store.clearSession(sessionId).pipe(
          Effect.catchAll((err) =>
            Effect.sync(() => {
              emitStoreError("Replay session cleanup failed", err);
            }),
          ),
        ),
      clearAll: store.clearAll.pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            emitStoreError("Replay recorder cleanup failed", err);
          }),
        ),
      ),
    };
  });
}

function normalizeSoftWarnThreshold(
  value: number | undefined,
): Effect.Effect<number, ConfigValidationError> {
  if (value === undefined) return Effect.succeed(DEFAULT_SOFT_WARN_THRESHOLD);
  return Number.isInteger(value) && value >= MIN_POSITIVE_INT
    ? Effect.succeed(value)
    : Effect.fail(
        new ConfigValidationError(
          "observability.replay.softWarnThreshold",
          value,
          "observability.replay.softWarnThreshold must be a positive integer",
        ),
      );
}

function readSnapshot(
  callback: SnapshotCallback | null,
  sessionId: SessionId,
  emitObservabilityError: (err: ObservabilityError) => void,
): Effect.Effect<SessionSnapshot, never> {
  if (callback === null) return Effect.succeed({});
  return Effect.exit(callback(sessionId)).pipe(
    Effect.flatMap((exit) =>
      exit._tag === "Success"
        ? Effect.succeed(exit.value)
        : Effect.sync(() => {
            emitObservabilityError(
              new ObservabilityError(
                "Session snapshot callback failed",
                new Error(String(exit.cause)),
              ),
            );
            return {};
          }),
    ),
  );
}
