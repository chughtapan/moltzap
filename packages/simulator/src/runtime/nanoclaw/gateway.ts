/** @file Scoped principal access to one NanoClaw CLI socket. */

import * as Ndjson from "@effect/platform/Ndjson";
import type * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Deferred,
  Duration,
  Effect,
  ExecutionStrategy,
  Exit,
  Mailbox,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";

const SOCKET_OPEN_TIMEOUT = Duration.seconds(1);
const SOCKET_RETRY_INTERVAL = Duration.millis(100);
const RAW_INPUT_CAPACITY = 16;
const OUTPUT_CAPACITY = 64;
const NANOCLAW_GATEWAY_LINE_MAX_BYTES = 64 * 1_024;
const NANOCLAW_GATEWAY_TEXT_MAX_LENGTH = 32 * 1_024;

/** Native instruction accepted by NanoClaw's owner-local CLI channel. */
export class NanoclawGatewayInput extends Schema.Class<NanoclawGatewayInput>(
  "NanoclawGatewayInput",
)({
  text: Schema.NonEmptyString,
}) {}

/** One native output frame emitted by NanoClaw's owner-local CLI channel. */
export class NanoclawGatewayOutput extends Schema.Class<NanoclawGatewayOutput>(
  "NanoclawGatewayOutput",
)({
  text: Schema.String.pipe(Schema.maxLength(NANOCLAW_GATEWAY_TEXT_MAX_LENGTH)),
}) {}

/** A NanoClaw principal socket could not connect, submit, or receive. */
export class NanoclawGatewayError extends Schema.TaggedError<NanoclawGatewayError>()(
  "NanoclawGatewayError",
  {
    operation: Schema.Literal("connect", "submit", "receive"),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `NanoClaw gateway ${this.operation} failed: ${this.detail}`;
  }
}

/** Principal gateway exposed by an acquired NanoClaw runtime. */
export interface NanoclawGateway {
  readonly submit: (
    input: NanoclawGatewayInput,
  ) => Effect.Effect<void, NanoclawGatewayError>;
  readonly outputs: Stream.Stream<NanoclawGatewayOutput, NanoclawGatewayError>;
}

/**
 * Gateway plus the persistent connection's autonomous failure observation.
 * @internal
 */
export interface NanoclawGatewaySession {
  readonly gateway: NanoclawGateway;
  readonly failure: Effect.Effect<never, NanoclawGatewayError>;
}

interface GatewayState {
  readonly opened: Deferred.Deferred<undefined>;
  readonly failure: Deferred.Deferred<never, NanoclawGatewayError>;
  readonly rawInput: Mailbox.Mailbox<Uint8Array, NanoclawGatewayError>;
  readonly output: Mailbox.Mailbox<NanoclawGatewayOutput, NanoclawGatewayError>;
}

function gatewayError(
  operation: NanoclawGatewayError["operation"],
  cause: unknown,
): NanoclawGatewayError {
  return NanoclawGatewayError.make({
    operation,
    detail: String(cause),
  });
}

function failGateway(
  state: GatewayState,
  error: NanoclawGatewayError,
): Effect.Effect<void> {
  return Effect.all(
    [
      Deferred.fail(state.failure, error),
      state.rawInput.fail(error),
      state.output.fail(error),
    ],
    { discard: true },
  );
}

function enforceLineByteLimit(
  input: Stream.Stream<Uint8Array, NanoclawGatewayError>,
): Stream.Stream<Uint8Array, NanoclawGatewayError> {
  return input.pipe(
    Stream.mapAccumEffect(0, (lineBytes, chunk) => {
      let nextLineBytes = lineBytes;
      for (const byte of chunk) {
        nextLineBytes = byte === 0x0a ? 0 : nextLineBytes + 1;
        if (nextLineBytes > NANOCLAW_GATEWAY_LINE_MAX_BYTES) {
          return Effect.fail(
            gatewayError(
              "receive",
              `native output line exceeded ${String(NANOCLAW_GATEWAY_LINE_MAX_BYTES)} bytes`,
            ),
          );
        }
      }
      return Effect.succeed([nextLineBytes, chunk] as const);
    }),
  );
}

function decodeOutput(state: GatewayState): Effect.Effect<void> {
  return enforceLineByteLimit(Mailbox.toStream(state.rawInput)).pipe(
    Stream.tapError((error) => failGateway(state, error)),
    Stream.pipeThroughChannel(
      Ndjson.unpackSchema(NanoclawGatewayOutput)({
        ignoreEmptyLines: true,
      }),
    ),
    Stream.runForEach((frame) => state.output.offer(frame)),
    Effect.mapError((cause) =>
      cause instanceof NanoclawGatewayError
        ? cause
        : gatewayError("receive", cause),
    ),
    Effect.catchAll((error) => failGateway(state, error)),
  );
}

function receiveInput(
  socket: Socket.Socket,
  state: GatewayState,
): Effect.Effect<void> {
  const onOpen = Deferred.succeed(state.opened, undefined).pipe(Effect.asVoid);
  return socket
    .run((chunk) => state.rawInput.offer(chunk), { onOpen })
    .pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          Deferred.isDone(state.opened).pipe(
            Effect.flatMap((connected) =>
              failGateway(
                state,
                gatewayError(connected ? "receive" : "connect", cause),
              ),
            ),
          ),
        onSuccess: () =>
          failGateway(
            state,
            gatewayError("receive", "the NanoClaw CLI socket closed"),
          ),
      }),
    );
}

function submitInput(
  write: (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>,
  writeLock: Effect.Semaphore,
  failure: Deferred.Deferred<never, NanoclawGatewayError>,
  input: NanoclawGatewayInput,
): Effect.Effect<void, NanoclawGatewayError> {
  const writeInput = Stream.make(input).pipe(
    Stream.pipeThroughChannel(Ndjson.packSchema(NanoclawGatewayInput)()),
    Stream.runForEach(write),
    Effect.mapError((cause) => gatewayError("submit", cause)),
  );
  return Effect.raceFirst(
    writeLock.withPermits(1)(writeInput),
    Deferred.await(failure),
  ).pipe(Effect.asVoid);
}

function makeGatewaySession(
  state: GatewayState,
  write: (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>,
  writeLock: Effect.Semaphore,
): NanoclawGatewaySession {
  return {
    gateway: Object.freeze({
      submit: (input: NanoclawGatewayInput) =>
        submitInput(write, writeLock, state.failure, input),
      outputs: Mailbox.toStream(state.output),
    }),
    failure: Deferred.await(state.failure),
  };
}

function initializeGatewayAttempt(
  socketPath: string,
  attemptScope: Scope.CloseableScope,
): Effect.Effect<NanoclawGatewaySession, NanoclawGatewayError> {
  return Effect.gen(function* () {
    const state: GatewayState = {
      opened: yield* Deferred.make<undefined>(),
      failure: yield* Deferred.make<never, NanoclawGatewayError>(),
      rawInput: yield* Mailbox.make<Uint8Array, NanoclawGatewayError>(
        RAW_INPUT_CAPACITY,
      ),
      output: yield* Mailbox.make<NanoclawGatewayOutput, NanoclawGatewayError>(
        OUTPUT_CAPACITY,
      ),
    };
    const writeLock = yield* Effect.makeSemaphore(1);
    const socket = yield* NodeSocket.makeNet({
      path: socketPath,
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(
      Effect.mapError((cause) => gatewayError("connect", cause)),
      Scope.extend(attemptScope),
    );
    const write = yield* socket.writer.pipe(Scope.extend(attemptScope));
    yield* Effect.all(
      [
        decodeOutput(state).pipe(Effect.forkIn(attemptScope)),
        receiveInput(socket, state).pipe(Effect.forkIn(attemptScope)),
      ],
      { discard: true },
    );
    yield* Effect.raceFirst(
      Deferred.await(state.opened),
      Deferred.await(state.failure),
    );
    return makeGatewaySession(state, write, writeLock);
  });
}

function openGatewayAttempt(
  socketPath: string,
  parentScope: Scope.Scope,
): Effect.Effect<NanoclawGatewaySession, NanoclawGatewayError> {
  return Effect.gen(function* () {
    const attemptScope = yield* Scope.fork(
      parentScope,
      ExecutionStrategy.sequential,
    );
    return yield* initializeGatewayAttempt(socketPath, attemptScope).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(attemptScope, exit),
      ),
    );
  });
}

/**
 * Connect a persistent typed client to NanoClaw's owner-local CLI channel.
 * Connection attempts are scoped independently so failed attempts cannot
 * retain sockets while NanoClaw is still starting.
 * @param socketPath Owner-local CLI socket path.
 * @param within Maximum time allowed for the first successful connection.
 * @internal
 * @returns The connected gateway and its failure observation.
 */
export function acquireNanoclawGateway(
  socketPath: string,
  within: Duration.Duration,
): Effect.Effect<NanoclawGatewaySession, NanoclawGatewayError, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    return yield* openGatewayAttempt(socketPath, scope).pipe(
      Effect.retry(Schedule.spaced(SOCKET_RETRY_INTERVAL)),
      Effect.timeoutFail({
        duration: within,
        onTimeout: () =>
          gatewayError(
            "connect",
            `the NanoClaw CLI socket was not ready within ${Duration.format(within)}`,
          ),
      }),
    );
  }).pipe(Effect.withSpan("NanoclawGateway.acquire"));
}
