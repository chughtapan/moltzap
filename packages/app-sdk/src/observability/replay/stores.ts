import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Cause, Data, Effect, type Brand } from "effect";
import type {
  HookMethod,
  ReplayEvent,
  SessionId,
  VerdictTag,
} from "../types.js";

export type PositiveInt = number & Brand.Brand<"PositiveInt">;
export type BufferLimit = PositiveInt | "unbounded";

export interface ReplayStoreRead {
  readonly events: readonly ReplayEvent[];
  readonly truncated: boolean;
}

export interface ReplayStore {
  readonly put: (
    sessionId: SessionId,
    event: ReplayEvent,
  ) => Effect.Effect<void, ReplayStoreIoError>;
  readonly readAll: (
    sessionId: SessionId,
  ) => Effect.Effect<ReplayStoreRead | null, ReplayStoreIoError>;
  readonly clearSession: (
    sessionId: SessionId,
  ) => Effect.Effect<void, ReplayStoreIoError>;
  readonly clearAll: Effect.Effect<void, ReplayStoreIoError>;
  readonly evict: Effect.Effect<void, ReplayStoreIoError>;
}

export class ReplayStorePathError extends Data.TaggedError(
  "ReplayStorePathError",
)<{
  readonly reason: "InvalidPath" | "MkdirFailed" | "NotWritable";
  readonly path: string;
  readonly message: string;
  readonly cause?: Cause.Cause<unknown>;
}> {}

export class ReplayStoreIoError extends Data.TaggedError("ReplayStoreIoError")<{
  readonly reason: "WriteFailed" | "ReadFailed" | "RotateFailed";
  readonly path: string;
  readonly message: string;
  readonly cause?: Cause.Cause<unknown>;
}> {}

interface StoreLimits {
  readonly bufferLimit: BufferLimit;
  readonly maxSessions: BufferLimit;
  readonly softWarnThreshold: number;
  readonly logger: { readonly warn: (msg: string, ctx?: unknown) => void };
}

interface MemorySession {
  events: ReplayEvent[];
  truncated: boolean;
  warned: boolean;
  lastWrite: number;
}

export function MakeInMemoryStore(options: StoreLimits) {
  return Effect.sync((): ReplayStore => {
    const sessions = new Map<string, MemorySession>();

    const evict = Effect.sync(() => {
      if (options.maxSessions === "unbounded") return;
      while (sessions.size > options.maxSessions) {
        let oldestKey: string | null = null;
        let oldestWrite = Number.POSITIVE_INFINITY;
        for (const [key, session] of sessions.entries()) {
          if (session.lastWrite < oldestWrite) {
            oldestKey = key;
            oldestWrite = session.lastWrite;
          }
        }
        if (oldestKey === null) return;
        sessions.delete(oldestKey);
      }
    });

    return {
      put: (sessionId, event) =>
        Effect.sync(() => {
          const key = sessionId as string;
          const session = sessions.get(key) ?? {
            events: [],
            truncated: false,
            warned: false,
            lastWrite: Date.now(),
          };
          session.events.push(event);
          session.lastWrite = Date.now();
          if (
            !session.warned &&
            session.events.length >= options.softWarnThreshold
          ) {
            session.warned = true;
            options.logger.warn("Replay buffer crossed soft warn threshold", {
              sessionId: key,
              eventCount: session.events.length,
              softWarnThreshold: options.softWarnThreshold,
            });
          }
          if (
            options.bufferLimit !== "unbounded" &&
            session.events.length > options.bufferLimit
          ) {
            session.events = session.events.slice(-options.bufferLimit);
            session.truncated = true;
          }
          sessions.set(key, session);
        }).pipe(Effect.zipRight(evict)),
      readAll: (sessionId) =>
        Effect.sync(() => {
          const session = sessions.get(sessionId as string);
          return session === undefined
            ? null
            : {
                events: [...session.events],
                truncated: session.truncated,
              };
        }),
      clearSession: (sessionId) =>
        Effect.sync(() => {
          sessions.delete(sessionId as string);
        }),
      clearAll: Effect.sync(() => {
        sessions.clear();
      }),
      evict,
    };
  });
}

interface FileSessionMeta {
  count: number;
  truncated: boolean;
  warned: boolean;
  lastWrite: number;
}

export function MakeFileSystemStore(
  options: StoreLimits & { readonly rootDir: string },
): Effect.Effect<ReplayStore, ReplayStorePathError> {
  const rootDir = path.resolve(options.rootDir);
  if (hasParentTraversal(options.rootDir)) {
    return Effect.fail(
      new ReplayStorePathError({
        reason: "InvalidPath",
        path: options.rootDir,
        message: `Replay store path must not contain '..': ${options.rootDir}`,
      }),
    );
  }

  return Effect.tryPromise({
    try: () => fsp.mkdir(rootDir, { recursive: true }),
    catch: (cause) =>
      new ReplayStorePathError({
        reason: "MkdirFailed",
        path: rootDir,
        message: `Failed to create replay store directory ${rootDir}`,
        cause: Cause.die(cause),
      }),
  }).pipe(
    Effect.asVoid,
    Effect.map(() => makeFileStore(rootDir, options)),
  );
}

function makeFileStore(rootDir: string, options: StoreLimits): ReplayStore {
  const sessions = new Map<string, FileSessionMeta>();

  const filePathFor = (sessionId: SessionId): string =>
    path.join(
      rootDir,
      `${encodeURIComponent(sessionId as string)}.events.ndjson`,
    );

  const evict = Effect.gen(function* () {
    if (options.maxSessions === "unbounded") return;
    while (sessions.size > options.maxSessions) {
      let oldestKey: string | null = null;
      let oldestWrite = Number.POSITIVE_INFINITY;
      for (const [key, session] of sessions.entries()) {
        if (session.lastWrite < oldestWrite) {
          oldestKey = key;
          oldestWrite = session.lastWrite;
        }
      }
      if (oldestKey === null) return;
      sessions.delete(oldestKey);
      const filePath = path.join(
        rootDir,
        `${encodeURIComponent(oldestKey)}.events.ndjson`,
      );
      yield* fsVoid("RotateFailed", filePath, () =>
        fsp.rm(filePath, { force: true }),
      );
    }
  });

  return {
    put: (sessionId, event) =>
      Effect.gen(function* () {
        const filePath = filePathFor(sessionId);
        yield* fsVoid("WriteFailed", filePath, () =>
          fsp.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf8"),
        );

        const key = sessionId as string;
        const meta = sessions.get(key) ?? {
          count: 0,
          truncated: false,
          warned: false,
          lastWrite: Date.now(),
        };
        meta.count += 1;
        meta.lastWrite = Date.now();
        if (!meta.warned && meta.count >= options.softWarnThreshold) {
          meta.warned = true;
          options.logger.warn("Replay file crossed soft warn threshold", {
            sessionId: key,
            eventCount: meta.count,
            softWarnThreshold: options.softWarnThreshold,
          });
        }
        if (
          options.bufferLimit !== "unbounded" &&
          meta.count > options.bufferLimit
        ) {
          const read = yield* readEvents(filePath);
          const kept = read.events.slice(-options.bufferLimit);
          yield* fsVoid("RotateFailed", filePath, () =>
            fsp.writeFile(
              filePath,
              kept.map((e) => JSON.stringify(e)).join("\n") + "\n",
              "utf8",
            ),
          );
          meta.count = kept.length;
          meta.truncated = true;
        }
        sessions.set(key, meta);
        yield* evict;
      }),
    readAll: (sessionId) =>
      Effect.gen(function* () {
        const filePath = filePathFor(sessionId);
        const meta = sessions.get(sessionId as string);
        if (meta === undefined) return null;
        const read = yield* readEvents(filePath);
        return { events: read.events, truncated: meta.truncated };
      }),
    clearSession: (sessionId) =>
      Effect.gen(function* () {
        sessions.delete(sessionId as string);
        yield* fsVoid("RotateFailed", filePathFor(sessionId), () =>
          fsp.rm(filePathFor(sessionId), { force: true }),
        );
      }),
    clearAll: Effect.gen(function* () {
      sessions.clear();
      yield* fsVoid("RotateFailed", rootDir, () =>
        fsp.rm(rootDir, { recursive: true, force: true }),
      );
      yield* fsVoid("WriteFailed", rootDir, () =>
        fsp.mkdir(rootDir, { recursive: true }),
      );
    }),
    evict,
  };
}

function hasParentTraversal(input: string): boolean {
  return input.split(/[\\/]+/u).includes("..");
}

function fsVoid(
  reason: ReplayStoreIoError["reason"],
  filePath: string,
  run: () => PromiseLike<unknown>,
): Effect.Effect<void, ReplayStoreIoError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ReplayStoreIoError({
        reason,
        path: filePath,
        message: `${reason} at ${filePath}`,
        cause: Cause.die(cause),
      }),
  }).pipe(Effect.asVoid);
}

function readEvents(
  filePath: string,
): Effect.Effect<
  { readonly events: readonly ReplayEvent[] },
  ReplayStoreIoError
> {
  return Effect.tryPromise({
    try: () => fsp.readFile(filePath, "utf8"),
    catch: (cause) =>
      new ReplayStoreIoError({
        reason: "ReadFailed",
        path: filePath,
        message: `ReadFailed at ${filePath}`,
        cause: Cause.die(cause),
      }),
  }).pipe(Effect.flatMap((raw) => decodeEventLines(filePath, raw)));
}

function decodeEventLines(
  filePath: string,
  raw: string,
): Effect.Effect<
  { readonly events: readonly ReplayEvent[] },
  ReplayStoreIoError
> {
  return Effect.gen(function* () {
    const events: ReplayEvent[] = [];
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (line.length === 0) continue;
      const parsed = yield* Effect.try({
        try: () => {
          const value: unknown = JSON.parse(line);
          return value;
        },
        catch: (cause) =>
          new ReplayStoreIoError({
            reason: "ReadFailed",
            path: filePath,
            message: `Replay event line ${index.toString()} is not valid JSON`,
            cause: Cause.die(cause),
          }),
      });
      events.push(yield* decodeReplayEvent(filePath, index, parsed));
    }
    return { events };
  });
}

function decodeReplayEvent(
  filePath: string,
  lineIndex: number,
  input: unknown,
): Effect.Effect<ReplayEvent, ReplayStoreIoError> {
  const sessionId = objectField(input, "sessionId");
  const method = objectField(input, "method");
  const requestId = objectField(input, "requestId");
  const startedAt = objectField(input, "startedAt");
  const durationMs = objectField(input, "durationMs");
  const params = objectField(input, "params");
  const outcome = objectField(input, "outcome");

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return decodeFailed(
      filePath,
      lineIndex,
      "sessionId must be a non-empty string",
    );
  }
  if (!isHookMethod(method)) {
    return decodeFailed(
      filePath,
      lineIndex,
      "method must be a known hook method",
    );
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    return decodeFailed(
      filePath,
      lineIndex,
      "requestId must be a non-empty string",
    );
  }
  if (typeof startedAt !== "string" || startedAt.length === 0) {
    return decodeFailed(
      filePath,
      lineIndex,
      "startedAt must be a non-empty string",
    );
  }
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    return decodeFailed(
      filePath,
      lineIndex,
      "durationMs must be a finite non-negative number",
    );
  }
  if (typeof outcome !== "object" || outcome === null) {
    return decodeFailed(filePath, lineIndex, "outcome must be an object");
  }

  const outcomeKind = objectField(outcome, "kind");
  const verdictTag = objectField(outcome, "verdictTag");
  if (!isVerdictTag(verdictTag)) {
    return decodeFailed(filePath, lineIndex, "outcome.verdictTag is invalid");
  }
  switch (outcomeKind) {
    case "ok":
      return Effect.succeed({
        sessionId: sessionId as SessionId,
        method,
        requestId,
        startedAt,
        durationMs,
        params,
        outcome: {
          kind: "ok",
          verdictTag,
          verdict: objectField(outcome, "verdict"),
        },
      });
    case "fail-closed": {
      const errorMessage = objectField(outcome, "errorMessage");
      const errorTag = objectField(outcome, "errorTag");
      if (typeof errorMessage !== "string" || errorMessage.length === 0) {
        return decodeFailed(
          filePath,
          lineIndex,
          "outcome.errorMessage must be a non-empty string",
        );
      }
      if (errorTag !== undefined && typeof errorTag !== "string") {
        return decodeFailed(
          filePath,
          lineIndex,
          "outcome.errorTag must be a string when present",
        );
      }
      return Effect.succeed({
        sessionId: sessionId as SessionId,
        method,
        requestId,
        startedAt,
        durationMs,
        params,
        outcome: {
          kind: "fail-closed",
          verdictTag,
          errorMessage,
          ...(errorTag !== undefined ? { errorTag } : {}),
        },
      });
    }
    default:
      return decodeFailed(filePath, lineIndex, "outcome.kind is invalid");
  }
}

function decodeFailed(
  filePath: string,
  lineIndex: number,
  message: string,
): Effect.Effect<never, ReplayStoreIoError> {
  return Effect.fail(
    new ReplayStoreIoError({
      reason: "ReadFailed",
      path: filePath,
      message: `Replay event line ${lineIndex.toString()} failed validation: ${message}`,
    }),
  );
}

function isHookMethod(input: unknown): input is HookMethod {
  return (
    input === "apps/onBeforeDispatch" ||
    input === "apps/onBeforeMessageDelivery" ||
    input === "apps/onSessionActive" ||
    input === "apps/onJoin" ||
    input === "apps/onClose"
  );
}

function isVerdictTag(input: unknown): input is VerdictTag {
  return (
    input === "grant" ||
    input === "deny" ||
    input === "hold" ||
    input === "allow" ||
    input === "block" ||
    input === "void"
  );
}

function objectField(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null) return undefined;
  return Object.getOwnPropertyDescriptor(input, key)?.value;
}
