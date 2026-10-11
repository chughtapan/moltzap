/** @file Validates a management-owned socket path without replacing existing filesystem objects. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Data, Effect, Option, type Scope } from "effect";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Closed local listener failure; paths and filesystem diagnostics stay private. */
export class ManagementSocketError extends Data.TaggedError(
  "ManagementSocketError",
)<{
  readonly reason: "path" | "permissions" | "occupied" | "filesystem";
}> {}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_SOCKET_MODE = 0o600;
const PERMISSION_BITS = 0o7777;
const MAXIMUM_SOCKET_PATH_BYTES = 103;

const isPrivateDirectory = (info: FileSystem.File.Info): boolean => {
  const uid = process.geteuid?.();
  return (
    uid !== undefined &&
    Option.contains(info.uid, uid) &&
    info.type === "Directory" &&
    (info.mode & PERMISSION_BITS) === PRIVATE_DIRECTORY_MODE
  );
};

const isSocketPath = (path: string): boolean =>
  isAbsolute(path) &&
  Buffer.byteLength(path, "utf8") <= MAXIMUM_SOCKET_PATH_BYTES &&
  ![".", ".."].includes(basename(path));

/**
 * Resolves the existing private parent before binding. The process account is
 * the management account. Same-account or root tampering is outside
 * this filesystem isolation boundary. An existing socket is never unlinked,
 * including a stale socket whose daemon ownership cannot be established.
 */
export const prepareManagementSocket = (path: string) =>
  Effect.gen(function* () {
    if (!isSocketPath(path)) {
      return yield* Effect.fail(new ManagementSocketError({ reason: "path" }));
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const parent = yield* fileSystem.realPath(dirname(path));
    const info = yield* fileSystem.stat(parent);
    if (!isPrivateDirectory(info)) {
      return yield* Effect.fail(
        new ManagementSocketError({ reason: "permissions" }),
      );
    }
    const socket = join(parent, basename(path));
    if (yield* fileSystem.exists(socket)) {
      return yield* Effect.fail(
        new ManagementSocketError({ reason: "occupied" }),
      );
    }
    return socket;
  }).pipe(
    Effect.catchTags({
      SystemError: () =>
        Effect.fail(new ManagementSocketError({ reason: "filesystem" })),
      BadArgument: () =>
        Effect.fail(new ManagementSocketError({ reason: "filesystem" })),
    }),
    Effect.provide(NodeFileSystem.layer),
    Effect.withSpan("prepareManagementSocket"),
  );

/**
 * Node unlinks its bound pathname on close. An unpublished, scoped directory
 * keeps that automatic cleanup away from an operator-replaceable configured
 * path. Both names reach one socket inode, not another listener or store.
 */
export const acquireManagementBindPath = (
  socket: string,
): Effect.Effect<string, ManagementSocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      directory: dirname(socket),
      prefix: ".mcp-",
    });
    const bound = join(directory, "mcp");
    if (!isSocketPath(bound)) {
      return yield* Effect.fail(new ManagementSocketError({ reason: "path" }));
    }
    return bound;
  }).pipe(
    Effect.catchTags({
      SystemError: () =>
        Effect.fail(new ManagementSocketError({ reason: "filesystem" })),
      BadArgument: () =>
        Effect.fail(new ManagementSocketError({ reason: "filesystem" })),
    }),
    Effect.provide(NodeFileSystem.layer),
    Effect.withSpan("acquireManagementBindPath"),
  );

interface PublishedSocket {
  readonly path: string;
  readonly info: FileSystem.File.Info;
}

const sameInode = (
  actual: FileSystem.File.Info,
  expected: FileSystem.File.Info,
): boolean =>
  actual.dev === expected.dev &&
  Option.isSome(expected.ino) &&
  Option.contains(actual.ino, expected.ino.value);
const removePublishedSocket = (published: PublishedSocket) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const current = yield* fileSystem.stat(published.path);
    if (sameInode(current, published.info)) {
      yield* fileSystem.remove(published.path);
    }
  }).pipe(
    Effect.catchTags({
      SystemError: (error) =>
        error.reason === "NotFound"
          ? Effect.void
          : Effect.logWarning(
              "Private MCP socket cleanup needs operator inspection",
            ),
      BadArgument: () =>
        Effect.logWarning(
          "Private MCP socket cleanup needs operator inspection",
        ),
    }),
  );

/**
 * Publishes an already-private bound socket without overwriting an existing
 * path. Teardown removes that link only while its retained inode matches;
 * replacing the configured path never delegates unlink authority to Node.
 */
export const publishManagementSocket = (
  bound: string,
  socket: string,
): Effect.Effect<void, ManagementSocketError, Scope.Scope> =>
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned Scope owns only this published link; the listener separately owns its private bound path.
  Effect.acquireRelease(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.chmod(bound, PRIVATE_SOCKET_MODE);
      const info = yield* fileSystem.stat(bound);
      if (info.type !== "Socket" || Option.isNone(info.ino)) {
        return yield* Effect.fail(
          new ManagementSocketError({ reason: "filesystem" }),
        );
      }
      yield* fileSystem.link(bound, socket);
      return { path: socket, info };
    }),
    removePublishedSocket,
  ).pipe(
    Effect.asVoid,
    Effect.catchTags({
      SystemError: (error) =>
        Effect.fail(
          new ManagementSocketError({
            reason:
              error.reason === "AlreadyExists" ? "occupied" : "filesystem",
          }),
        ),
      BadArgument: () =>
        Effect.fail(new ManagementSocketError({ reason: "filesystem" })),
    }),
    Effect.provide(NodeFileSystem.layer),
    Effect.withSpan("publishManagementSocket"),
  );
