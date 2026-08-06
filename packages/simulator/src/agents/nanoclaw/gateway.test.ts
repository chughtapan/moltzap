import { FileSystem, Path } from "@effect/platform";
import type * as Socket from "@effect/platform/Socket";
import { NodeContext, NodeSocketServer } from "@effect/platform-node";
import { assert, it as effectIt } from "@effect/vitest";
import { Chunk, Deferred, Duration, Effect, Fiber, Stream } from "effect";
import { describe } from "vitest";
import {
  acquireDistributedNanoClawGateway,
  acquireNanoClawGateway,
  NanoClawGatewayInput,
} from "./gateway.js";

const test = effectIt.scoped;
const liveTest = effectIt.scopedLive;
const FIRST_OUTPUT = '{"text":"first"}\n{"te';
const SECOND_OUTPUT = 'xt":"second"}\n';
const EXPECTED_INPUT = '{"text":"hello"}\n';
const GATEWAY_LINE_MAX_BYTES = 64 * 1_024;

type SocketWrite = (
  chunk: Uint8Array | string | Socket.CloseEvent,
) => Effect.Effect<void, Socket.SocketError>;

function makeInputHandler(
  write: SocketWrite,
  request: Deferred.Deferred<string>,
) {
  const decoder = new TextDecoder();
  let received = "";
  let responded = false;
  return (chunk: Uint8Array) => {
    received += decoder.decode(chunk, { stream: true });
    if (responded || !received.includes("\n")) {
      return;
    }
    responded = true;
    return Deferred.succeed(request, received).pipe(
      Effect.zipRight(write(FIRST_OUTPUT)),
      Effect.zipRight(write(SECOND_OUTPUT)),
    );
  };
}

function handleConnection(
  socket: Socket.Socket,
  request: Deferred.Deferred<string>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const write = yield* socket.writer;
      return yield* socket.run(makeInputHandler(write, request));
    }),
  );
}

function startTestServer(
  socketPath: string,
  request: Deferred.Deferred<string>,
) {
  return Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ path: socketPath });
    yield* server
      .run((socket) => handleConnection(socket, request))
      .pipe(Effect.forkScoped);
  });
}

function startTcpTestServer(request: Deferred.Deferred<string>) {
  return Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({
      host: "127.0.0.1",
      port: 0,
    });
    if (server.address._tag !== "TcpAddress") {
      return yield* Effect.dieMessage(
        "TCP gateway fixture returned a Unix address",
      );
    }
    yield* server
      .run((socket) => handleConnection(socket, request))
      .pipe(Effect.forkScoped);
    return server.address;
  });
}

function startOversizedOutputServer(
  socketPath: string,
  atLimit: Deferred.Deferred<undefined>,
  releaseOverflow: Deferred.Deferred<undefined>,
) {
  const fragment = "x".repeat(GATEWAY_LINE_MAX_BYTES / 2);
  return Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ path: socketPath });
    yield* server
      .run((socket) =>
        serveOversizedOutput(socket, fragment, atLimit, releaseOverflow),
      )
      .pipe(Effect.forkScoped);
  });
}

function ignoreSocketInput(): void {}

function serveOversizedOutput(
  socket: Socket.Socket,
  fragment: string,
  atLimit: Deferred.Deferred<undefined>,
  releaseOverflow: Deferred.Deferred<undefined>,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const write = yield* socket.writer;
      yield* socket.run(ignoreSocketInput).pipe(Effect.forkScoped);
      yield* write(fragment);
      yield* write(fragment);
      yield* Deferred.succeed(atLimit, undefined);
      yield* Deferred.await(releaseOverflow);
      yield* write("x");
      return yield* Effect.never;
    }),
  );
}

function nativeFramesTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-nanoclaw-gateway-",
    });
    const socketPath = path.join(directory, "cli.sock");
    const request = yield* Deferred.make<string>();
    yield* startTestServer(socketPath, request);

    const session = yield* acquireNanoClawGateway(
      socketPath,
      Duration.seconds(2),
    );
    const collecting = yield* session.gateway.outputs.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* session.gateway.submit(NanoClawGatewayInput.make({ text: "hello" }));

    assert.strictEqual(yield* Deferred.await(request), EXPECTED_INPUT);
    assert.deepStrictEqual(
      Chunk.toReadonlyArray(yield* Fiber.join(collecting)).map(
        (frame) => frame.text,
      ),
      ["first", "second"],
    );
  }).pipe(Effect.provide(NodeContext.layer));
}

function oversizedFragmentedLineTest() {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moltzap-nanoclaw-gateway-",
    });
    const socketPath = path.join(directory, "cli.sock");
    const atLimit = yield* Deferred.make<undefined>();
    const releaseOverflow = yield* Deferred.make<undefined>();
    yield* startOversizedOutputServer(socketPath, atLimit, releaseOverflow);

    const session = yield* acquireNanoClawGateway(
      socketPath,
      Duration.seconds(2),
    );
    yield* Deferred.await(atLimit).pipe(
      Effect.timeoutFail({
        duration: Duration.seconds(2),
        onTimeout: () =>
          new Error("gateway fixture did not reach the line byte limit"),
      }),
    );
    yield* Deferred.succeed(releaseOverflow, undefined);
    const failure = yield* session.failure.pipe(
      Effect.flip,
      Effect.timeoutFail({
        duration: Duration.seconds(2),
        onTimeout: () => new Error("gateway did not reject oversized output"),
      }),
    );

    assert.include(
      failure.detail,
      `exceeded ${String(GATEWAY_LINE_MAX_BYTES)} bytes`,
    );
  }).pipe(Effect.provide(NodeContext.layer));
}

function distributedNativeFramesTest() {
  return Effect.gen(function* () {
    const request = yield* Deferred.make<string>();
    const address = yield* startTcpTestServer(request);
    const session = yield* acquireDistributedNanoClawGateway(
      address.hostname,
      address.port,
      Duration.seconds(2),
    );
    const collecting = yield* session.gateway.outputs.pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* session.gateway.submit(NanoClawGatewayInput.make({ text: "hello" }));

    assert.strictEqual(yield* Deferred.await(request), EXPECTED_INPUT);
    assert.deepStrictEqual(
      Chunk.toReadonlyArray(yield* Fiber.join(collecting)).map(
        (frame) => frame.text,
      ),
      ["first", "second"],
    );
  }).pipe(Effect.provide(NodeContext.layer));
}

describe("NanoClaw principal gateway", () => {
  test(
    "submits native NDJSON and preserves each streamed output frame",
    nativeFramesTest,
  );
  test(
    "preserves the same native gateway over the application bridge",
    distributedNativeFramesTest,
  );
  liveTest(
    "rejects a fragmented native output line before it can grow without bound",
    oversizedFragmentedLineTest,
  );
});
