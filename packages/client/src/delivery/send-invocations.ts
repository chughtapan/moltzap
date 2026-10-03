/** @file Durable reservation of whole send invocations without protocol replay. */

import { Deferred, Effect, Schema, type Scope } from "effect";
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type EndpointStore,
  EndpointStoreError,
} from "../store/index.js";
import {
  CollectiveError,
  SendInput,
  type SendResult,
} from "../transport/collectives/forms.js";
import {
  SendError,
  sendFailureReasons,
} from "../transport/messaging/errors.js";
import {
  decodeHarnessSendErrorData,
  decodeHarnessSendOutcome,
  decodeHarnessSendRequest,
  type DeliveryOperations,
  type HarnessReadSendRequest,
  type HarnessReadSendResult,
  type HarnessSendOutcome,
  type HarnessSendRequest,
  sendErrorData,
} from "./operations.js";

type SendFailure = SendError | CollectiveError;
type PendingSend = Deferred.Deferred<SendResult, SendFailure>;
const storedInputSchema = Schema.Struct({
  input: SendInput,
  failureDelivery: Schema.Literal("result", "inbound"),
});

const errorOutcome = (error: SendFailure): HarnessSendOutcome => ({
  kind: "failure",
  error: sendErrorData(error),
});

const isSendReason = (reason: string): reason is SendError["reason"] =>
  sendFailureReasons.some((value) => value === reason);

const decodeStoredOutcome = (bytes: Uint8Array) =>
  decodeRuntimeValue(Schema.Unknown, bytes).pipe(
    Effect.flatMap(decodeHarnessSendOutcome),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
    ),
  );
const storedError = (value: unknown): Effect.Effect<never, SendFailure> =>
  decodeHarnessSendErrorData(value).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new SendError({ reason: "persistence-failed" })),
    ),
    Effect.flatMap(
      (error): Effect.Effect<never, SendFailure> =>
        Effect.fail(
          "failure" in error
            ? new CollectiveError({ id: error.id, failure: error.failure })
            : new SendError({
                reason: isSendReason(error.reason)
                  ? error.reason
                  : "outcome-unknown",
                ...(error.detail === undefined ? {} : { detail: error.detail }),
              }),
        ),
    ),
  );

const replayOutcome = (
  bytes: Uint8Array,
): Effect.Effect<SendResult, SendFailure> =>
  decodeStoredOutcome(bytes).pipe(
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(new SendError({ reason: "persistence-failed" })),
    ),
    Effect.flatMap((outcome) =>
      outcome.kind === "success"
        ? Effect.succeed(outcome.result)
        : storedError(outcome.error),
    ),
  );
interface Invocations {
  readonly store: EndpointStore;
  readonly execute: DeliveryOperations["send"];
  readonly scope: Scope.Scope;
  readonly gate: Effect.Semaphore;
  readonly pending: Map<string, PendingSend>;
}
const runReserved = (
  runtime: Invocations,
  key: string,
  request: HarnessSendRequest,
  result: PendingSend,
) =>
  runtime.execute(request).pipe(
    Effect.match({
      onFailure: errorOutcome,
      onSuccess: (value): HarnessSendOutcome => ({
        kind: "success",
        result: value,
      }),
    }),
    Effect.flatMap(encodeRuntimeValue),
    Effect.flatMap((bytes) =>
      runtime.store.finishSendAttempt(key, bytes).pipe(Effect.as(bytes)),
    ),
    Effect.catchTag("EndpointStoreError", () =>
      Effect.fail(new SendError({ reason: "persistence-failed" })),
    ),
    Effect.flatMap(replayOutcome),
    Effect.exit,
    Effect.flatMap((outcome) => Deferred.done(result, outcome)),
    Effect.ensuring(Effect.sync(() => runtime.pending.delete(key))),
  );
const existingInvocation = (runtime: Invocations, key: string) =>
  Effect.gen(function* () {
    const live = runtime.pending.get(key);
    if (live !== undefined) {
      return Deferred.await(live);
    }
    const retained = yield* runtime.store.readSendAttempt(key);
    return retained?.canonicalOutcome === undefined
      ? Effect.fail(new SendError({ reason: "outcome-unknown" }))
      : replayOutcome(retained.canonicalOutcome);
  });
const reserve = (
  runtime: Invocations,
  key: string,
  request: HarnessSendRequest,
) =>
  Effect.gen(function* () {
    const canonicalInput = yield* encodeRuntimeValue({
      input: request.input,
      failureDelivery: request.failureDelivery ?? "result",
    });
    const inserted = yield* runtime.store.beginSendAttempt(key, canonicalInput);
    if (inserted === "existing") {
      return yield* existingInvocation(runtime, key);
    }
    const result = yield* Deferred.make<SendResult, SendFailure>();
    runtime.pending.set(key, result);
    yield* Effect.forkIn(
      runReserved(runtime, key, request, result).pipe(Effect.interruptible),
      runtime.scope,
    );
    return Deferred.await(result);
  });
const keyedSend = (
  runtime: Invocations,
  key: string,
  request: HarnessSendRequest,
): Effect.Effect<SendResult, SendFailure> =>
  runtime.gate
    .withPermits(1)(reserve(runtime, key, request))
    .pipe(
      Effect.catchTag("EndpointStoreError", (error) =>
        Effect.fail(
          new SendError({
            reason:
              error.reason === "conflict"
                ? "idempotency-conflict"
                : "persistence-failed",
          }),
        ),
      ),
      Effect.uninterruptible,
      Effect.flatten,
    );
const readSend = (
  runtime: Invocations,
  request: HarnessReadSendRequest,
): Effect.Effect<HarnessReadSendResult, { readonly reason: string }> =>
  Effect.gen(function* () {
    const retained = yield* runtime.store.readSendAttempt(
      request.idempotencyKey,
    );
    if (retained === undefined) {
      return { state: "absent" };
    }
    const { input } = yield* decodeRuntimeValue(
      storedInputSchema,
      retained.canonicalInput,
    );
    if (retained.canonicalOutcome === undefined) {
      return {
        state: runtime.pending.has(request.idempotencyKey)
          ? "pending"
          : "indeterminate",
        input,
      };
    }
    const outcome = yield* decodeStoredOutcome(retained.canonicalOutcome);
    return { state: "returned", input, outcome };
  });
const send = (runtime: Invocations, request: HarnessSendRequest) =>
  decodeHarnessSendRequest(request).pipe(
    Effect.catchTag("ParseError", () =>
      Effect.fail(new SendError({ reason: "content-invalid" })),
    ),
    Effect.flatMap((decoded) =>
      decoded.idempotencyKey === undefined
        ? runtime.execute(decoded)
        : keyedSend(runtime, decoded.idempotencyKey, decoded),
    ),
  );

/**
 * Bind invocation keys before execution and retain observed outcomes, including
 * failures. Restarted reservations remain indeterminate because this boundary
 * does not replay the collective state machine, nonce or deadline.
 * @param store Daemon-owned endpoint persistence.
 * @param execute The underlying send operation, without retry behavior.
 * @param scope Daemon lifetime, independent of the HTTP request.
 * @returns Send and lookup operations sharing live invocation reservations.
 */
export const makeSendInvocations = (
  store: EndpointStore,
  execute: DeliveryOperations["send"],
  scope: Scope.Scope,
) =>
  Effect.gen(function* () {
    const gate = yield* Effect.makeSemaphore(1);
    const runtime: Invocations = {
      store,
      execute,
      scope,
      gate,
      pending: new Map(),
    };
    return {
      send: (request: HarnessSendRequest) => send(runtime, request),
      readSend: (request: HarnessReadSendRequest) => readSend(runtime, request),
    };
  }).pipe(Effect.withSpan("makeSendInvocations"));
