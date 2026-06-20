import { FileSystem, Path } from "@effect/platform";
import * as SocketServer from "@effect/platform/SocketServer";
import { NodeContext } from "@effect/platform-node";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import { RpcSerialization, RpcServer, type RpcGroup } from "@effect/rpc";
import { Effect, Either, Exit, Layer, Scope } from "effect";
import { LocalDaemonRpcs, toLocalDaemonError } from "./local-daemon-rpc.js";

const SOCKET_FILE_MODE = 0o600;

type LocalSocketServer = SocketServer.SocketServer["Type"];
type LocalDaemonHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof LocalDaemonRpcs>
>;

interface LocalSocketServerOptions<
  Handlers extends LocalDaemonHandlers = LocalDaemonHandlers,
> {
  readonly socketPath: string;
  readonly defaultSocketPath: string;
  readonly handlers: Handlers;
}

export interface RunningLocalSocketServer {
  readonly socketScope: Scope.CloseableScope;
  readonly socketPath: string;
}

interface StopLocalSocketServerOptions {
  readonly socketScope: Scope.CloseableScope | null;
  readonly socketPath: string;
  readonly defaultSocketPath: string;
}

function logFileSystemIssue(
  level: "info" | "warn",
  message: string,
  error: unknown,
): Effect.Effect<void, never> {
  return (level === "warn" ? Effect.logWarning : Effect.logInfo)(
    message,
    error,
  );
}

function closeScope(scope: Scope.CloseableScope): Effect.Effect<void, never> {
  return Scope.close(scope, Exit.succeed(undefined));
}

function prepareSocketPath(socketPath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem
      .remove(socketPath, { force: true })
      .pipe(
        Effect.catchAll((error) =>
          logFileSystemIssue("warn", "unlink existing socket failed", error),
        ),
      );
    yield* fileSystem.makeDirectory(path.dirname(socketPath), {
      recursive: true,
    });
  });
}

function makeSocketServer(
  socketPath: string,
  socketScope: Scope.CloseableScope,
) {
  return NodeSocketServer.make({ path: socketPath }).pipe(
    Scope.extend(socketScope),
    Effect.tapError(() => closeScope(socketScope)),
  );
}

function buildSocketRpcLayer<Handlers extends LocalDaemonHandlers>(
  server: LocalSocketServer,
  socketScope: Scope.CloseableScope,
  options: LocalSocketServerOptions<Handlers>,
) {
  const rpcLayer = RpcServer.layer(LocalDaemonRpcs).pipe(
    Layer.provide(
      LocalDaemonRpcs.toLayer(LocalDaemonRpcs.of(options.handlers)).pipe(
        Layer.mapError(toLocalDaemonError),
      ),
    ),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(Layer.succeed(SocketServer.SocketServer, server)),
  );
  return Layer.build(rpcLayer).pipe(
    Scope.extend(socketScope),
    Effect.tapError(() => closeScope(socketScope)),
  );
}

function chmodSocketPath(socketPath: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.chmod(socketPath, SOCKET_FILE_MODE),
    ),
    Effect.catchAll((error) =>
      logFileSystemIssue("warn", "chmod 0600 on socket failed", error),
    ),
  );
}

function installDefaultSocketSymlink(options: LocalSocketServerOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .remove(options.defaultSocketPath, { force: true })
      .pipe(
        Effect.catchAll((error) =>
          logFileSystemIssue("info", "unlink default socket symlink", error),
        ),
      );
    yield* fileSystem
      .symlink(options.socketPath, options.defaultSocketPath)
      .pipe(
        Effect.catchAll((error) =>
          logFileSystemIssue("warn", "symlink default socket failed", error),
        ),
      );
  });
}

export function startLocalSocketServer<Handlers extends LocalDaemonHandlers>(
  options: LocalSocketServerOptions<Handlers>,
): Effect.Effect<RunningLocalSocketServer, unknown, never> {
  const effect = Effect.gen(function* () {
    yield* prepareSocketPath(options.socketPath);
    const socketScope = yield* Scope.make();
    const server = yield* makeSocketServer(options.socketPath, socketScope);
    yield* buildSocketRpcLayer(server, socketScope, options);
    yield* chmodSocketPath(options.socketPath);
    yield* installDefaultSocketSymlink(options);
    return { socketScope, socketPath: options.socketPath };
  }).pipe(
    Effect.withSpan("startLocalSocketServer"),
    Effect.provide(NodeContext.layer),
  );
  return effect as Effect.Effect<RunningLocalSocketServer, unknown, never>;
}

function removeSocketPath(socketPath: string) {
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.remove(socketPath, { force: true }),
    ),
    Effect.catchAll((error) =>
      logFileSystemIssue("info", "unlink socket path", error),
    ),
  );
}

function removeDefaultSocketSymlinkIfOwned(options: {
  readonly socketPath: string;
  readonly defaultSocketPath: string;
}) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const target = yield* fileSystem
      .readLink(options.defaultSocketPath)
      .pipe(Effect.either);
    const shouldRemoveDefaultSocket = Either.match(target, {
      onLeft: () => false,
      onRight: (value) => value === options.socketPath,
    });
    if (!shouldRemoveDefaultSocket) return;
    yield* fileSystem
      .remove(options.defaultSocketPath, { force: true })
      .pipe(
        Effect.catchAll((error) =>
          logFileSystemIssue("info", "cleanup default symlink", error),
        ),
      );
  });
}

export function stopLocalSocketServer(
  options: StopLocalSocketServerOptions,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (options.socketScope !== null) {
      yield* closeScope(options.socketScope);
    }
    yield* removeSocketPath(options.socketPath);
    yield* removeDefaultSocketSymlinkIfOwned(options);
  }).pipe(
    Effect.withSpan("stopLocalSocketServer"),
    Effect.provide(NodeContext.layer),
    Effect.catchAll((error) =>
      logFileSystemIssue("info", "cleanup default symlink", error),
    ),
  );
}
