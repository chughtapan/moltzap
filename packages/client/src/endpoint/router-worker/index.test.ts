/** @file Scripted Router worker ordering, cursor, replay, and recovery laws. */

import {
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import {
  Router,
  RouterConnectionError,
  type RouterSendRequest,
  type RouterSendResult,
  SignedMessageDigest,
} from "@moltzap/router";
import { Deferred, Effect, Encoding, Fiber, Layer, Ref, Schema } from "effect";
import { createHash } from "node:crypto";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests own isolated real-SQLite directories around scoped store acquisition.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  batch,
  emptyBatch,
  type Fixture,
  makeFixture,
  makeIdentityFixture,
  makeScriptedRouter,
  messageId,
  pollCursor,
  registryLayer,
  routerInstanceId,
  signMessage,
  type TestPayload,
  unavailableRegistryLayer,
  unreachableOutbox,
} from "../../__tests__/router-worker-fixtures.js";
import { encodeCanonical } from "../representation.js";
import {
  type ConversationFoundation,
  type EndpointStore,
  openEndpointStore,
  type StoredOutboundMessage,
} from "../store.js";
import {
  makeRouterWorker,
  RouterWorkerAuthenticationError,
  type RouterWorkerCallbacks,
  RouterWorkerDiscontinuityError,
  type RouterWorkerInput,
  RouterWorkerPayloadInvalidError,
  RouterWorkerPersistenceError,
  RouterWorkerProtocolError,
  type RouterWorkerRecovery,
  type RouterWorkerRecoveryError,
  type RouterWorkerSendError,
  RouterWorkerUnavailableError,
} from "./index.js";

/* eslint-disable max-lines, max-lines-per-function, sonarjs/max-lines-per-function, sonarjs/no-nested-functions, agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The scripted scenarios keep each Router trace and its exact ordering assertions together and use Vitest's Promise-native contract. */

const retryMode: RouterSendRequest["mode"] = "retry";

type Expect<Condition extends true> = Condition;
type DecoderIsRequired = Expect<
  Record<never, never> extends Pick<
    RouterWorkerCallbacks<TestPayload>,
    "decodePayload"
  >
    ? false
    : true
>;
type DecoderProducesTestPayload = Expect<
  Effect.Effect.Success<
    ReturnType<RouterWorkerCallbacks<TestPayload>["decodePayload"]>
  > extends TestPayload
    ? true
    : false
>;

// The worker's declared payload and its required decoder remain one contract.
const decoderContract = [true, true] satisfies readonly [
  DecoderIsRequired,
  DecoderProducesTestPayload,
];

const callbacks = (input?: {
  readonly accepted?: Ref.Ref<string[]>;
  readonly acceptedRouterInstances?: Ref.Ref<string[]>;
  readonly recoveryAccepted?: Ref.Ref<string[]>;
  readonly events?: Ref.Ref<string[]>;
  readonly invalidText?: string;
  readonly failAcceptText?: string;
  readonly recover?: (
    input: RouterWorkerRecovery,
  ) => Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError>;
}): RouterWorkerCallbacks<TestPayload> => ({
  pinSenderCard: () => Effect.void,
  decodePayload: (message) => {
    const text = new TextDecoder().decode(message.body);
    return text === input?.invalidText
      ? Effect.fail(new RouterWorkerPayloadInvalidError())
      : Effect.succeed({ text });
  },
  acceptPayload: (acceptedInput) =>
    acceptedInput.payload.text === input?.failAcceptText
      ? Effect.fail(new RouterWorkerPersistenceError())
      : Effect.gen(function* () {
          if (input?.accepted !== undefined) {
            yield* Ref.update(input.accepted, (values) => [
              ...values,
              acceptedInput.payload.text,
            ]);
          }
          if (input?.acceptedRouterInstances !== undefined) {
            yield* Ref.update(input.acceptedRouterInstances, (values) => [
              ...values,
              acceptedInput.routerInstanceId,
            ]);
          }
          return "accepted" as const;
        }),
  acceptRecoveryPayload: ({ payload }) =>
    input?.recoveryAccepted === undefined
      ? Effect.succeed("ignored" as const)
      : Ref.update(input.recoveryAccepted, (values) => [
          ...values,
          payload.text,
        ]).pipe(Effect.as("accepted" as const)),
  abandonVolatileFolds: (reason) =>
    input?.events === undefined
      ? Effect.void
      : Ref.update(input.events, (events) => [...events, `abandon:${reason}`]),
  recoverCertifiedHistory: (recoveryInput) => {
    const record =
      input?.events === undefined
        ? Effect.void
        : Ref.update(input.events, (events) => [
            ...events,
            `recover:${recoveryInput.reason}`,
          ]);
    return record.pipe(
      Effect.zipRight(
        input?.recover === undefined
          ? Effect.void
          : input.recover(recoveryInput),
      ),
    );
  },
});

const makeInput = (
  fixture: Fixture,
  workerCallbacks: RouterWorkerCallbacks<TestPayload>,
  overrides?: RouterWorkerInput<TestPayload>["overrides"],
  outbox: RouterWorkerInput<TestPayload>["outbox"] = unreachableOutbox,
): RouterWorkerInput<TestPayload> => ({
  callerAgentId: fixture.localCard.agentId,
  callerAgentCard: fixture.localCard,
  pinnedSenderCards: [fixture.localCard],
  signingAuthority: fixture.localAuthority,
  outbox,
  callbacks: workerCallbacks,
  overrides,
});

const makeActiveRouterWorker = (input: RouterWorkerInput<TestPayload>) =>
  Effect.gen(function* () {
    const router = yield* Router;
    let activating = true;
    const configured = input.callbacks;
    const worker = yield* makeRouterWorker({
      ...input,
      callbacks: {
        ...configured,
        abandonVolatileFolds: (reason) =>
          activating ? Effect.void : configured.abandonVolatileFolds(reason),
        recoverCertifiedHistory: (recovery) =>
          activating
            ? Effect.void
            : configured.recoverCertifiedHistory(recovery),
      },
    }).pipe(
      Effect.provideService(Router, {
        ...router,
        poll: (request) =>
          activating && request.request.pollCursor !== undefined
            ? Effect.never
            : router.poll(request),
      }),
    );
    yield* worker.pollOnce;
    activating = false;
    return worker;
  });

const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  routerLayer: Layer.Layer<Router>,
  fixture: Fixture,
) =>
  effect.pipe(
    Effect.provide(routerLayer),
    Effect.provide(registryLayer([fixture.localCard])),
  );

const withOutbox = <Value, Failure, Requirements>(
  use: (store: EndpointStore) => Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "moltzap-router-worker-"))),
      (directory) =>
        Effect.sync(() => {
          rmSync(directory, { recursive: true, force: true });
        }),
    ).pipe(Effect.flatMap(openEndpointStore), Effect.flatMap(use)),
  );

function prepareOutbound(
  store: EndpointStore,
  conversationId: string,
  message: SignedMessageValue,
): Effect.Effect<StoredOutboundMessage> {
  return store.putConversationFoundation(routerFoundation(conversationId)).pipe(
    Effect.orDie,
    Effect.zipRight(encodeCanonical(SignedMessage, message).pipe(Effect.orDie)),
    Effect.flatMap((canonicalSignedMessage) =>
      store
        .enqueueOutbound({
          conversationId,
          messageId: message.messageId,
          canonicalSignedMessage,
        })
        .pipe(Effect.orDie),
    ),
  );
}

function routerFoundation(conversationId: string): ConversationFoundation {
  return {
    conversationId,
    membershipHash: `mbr_${conversationId}`,
    canonicalMembership: new TextEncoder().encode(
      `membership:${conversationId}`,
    ),
    anchorHash: `anc_${conversationId}`,
    canonicalAnchor: new TextEncoder().encode(`anchor:${conversationId}`),
  };
}

function acceptedResult(
  instance: ReturnType<typeof routerInstanceId>,
  message: SignedMessageValue,
): Effect.Effect<RouterSendResult> {
  return encodeCanonical(SignedMessage, message).pipe(
    Effect.orDie,
    Effect.map((canonicalSignedMessage) =>
      createHash("sha256").update(canonicalSignedMessage).digest(),
    ),
    Effect.map((digest) =>
      Schema.decodeUnknownSync(SignedMessageDigest)(
        `smd_${Encoding.encodeBase64Url(digest)}`,
      ),
    ),
    Effect.map((signedMessageDigest) => ({
      kind: "accepted" as const,
      routerInstanceId: instance,
      signedMessageDigest,
    })),
  );
}

const batchVerificationIsAtomic = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const valid = yield* signMessage({
        card: fixture.localCard,
        authority: fixture.localAuthority,
        recipient: fixture.localCard.agentId,
        id: 10,
        body: "valid",
      });
      const invalid = yield* signMessage({
        card: fixture.localCard,
        authority: fixture.localAuthority,
        recipient: fixture.localCard.agentId,
        id: 11,
        body: "invalid-signature",
      });
      const accepted = yield* Ref.make<string[]>([]);
      const firstInstance = routerInstanceId(10);
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(firstInstance, pollCursor(1)),
          batch(firstInstance, pollCursor(2), [valid, invalid]),
        ],
      });
      const worker = yield* provide(
        makeActiveRouterWorker(
          makeInput(fixture, callbacks({ accepted }), {
            verifyOuter: ({ signedMessage, agentCard }) =>
              signedMessage.messageId === messageId(11)
                ? Effect.fail(new RouterWorkerAuthenticationError())
                : SignedMessage.verify({ signedMessage, agentCard }).pipe(
                    Effect.catchTag("SignedMessageVerificationError", () =>
                      Effect.fail(new RouterWorkerAuthenticationError()),
                    ),
                  ),
          }),
        ),
        router.layer,
        fixture,
      );
      const error = yield* provide(
        worker.pollOnce.pipe(Effect.flip),
        router.layer,
        fixture,
      );
      expect(error).toStrictEqual(new RouterWorkerAuthenticationError());
      expect(yield* Ref.get(accepted)).toEqual([]);
      expect((yield* worker.currentAnchor).pollCursor).toBe(pollCursor(1));
    }),
  );
};

const orderedCursorCommit = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const accepted = yield* Ref.make<string[]>([]);
      const acceptedRouterInstances = yield* Ref.make<string[]>([]);
      const messages = yield* Effect.forEach(
        ["one", "invalid", "two"],
        (text, index) =>
          signMessage({
            card: fixture.localCard,
            authority: fixture.localAuthority,
            recipient: fixture.localCard.agentId,
            id: 20 + index,
            body: text,
          }),
        { concurrency: 1 },
      );
      const instance = routerInstanceId(20);
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(instance, pollCursor(3)),
          batch(instance, pollCursor(4), messages),
        ],
      });
      const worker = yield* provide(
        makeActiveRouterWorker(
          makeInput(
            fixture,
            callbacks({
              accepted,
              acceptedRouterInstances,
              invalidText: "invalid",
            }),
          ),
        ),
        router.layer,
        fixture,
      );
      yield* provide(worker.pollOnce, router.layer, fixture);
      expect(yield* Ref.get(accepted)).toEqual(["one", "two"]);
      expect(yield* Ref.get(acceptedRouterInstances)).toEqual([
        instance,
        instance,
      ]);
      expect((yield* worker.currentAnchor).pollCursor).toBe(pollCursor(4));
    }),
  );
};

const persistenceRetainsCursor = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const message = yield* signMessage({
        card: fixture.localCard,
        authority: fixture.localAuthority,
        recipient: fixture.localCard.agentId,
        id: 30,
        body: "persist-fails",
      });
      const instance = routerInstanceId(30);
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(instance, pollCursor(5)),
          batch(instance, pollCursor(6), [message]),
        ],
      });
      const worker = yield* provide(
        makeActiveRouterWorker(
          makeInput(fixture, callbacks({ failAcceptText: "persist-fails" })),
        ),
        router.layer,
        fixture,
      );
      const error = yield* provide(
        worker.pollOnce.pipe(Effect.flip),
        router.layer,
        fixture,
      );
      expect(error).toStrictEqual(new RouterWorkerPersistenceError());
      expect((yield* worker.currentAnchor).pollCursor).toBe(pollCursor(5));
    }),
  );
};

const ambiguousSendRetriesSameBytes = async (): Promise<void> => {
  await Effect.runPromise(
    withOutbox((store) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const outgoing = yield* signMessage({
          card: fixture.localCard,
          authority: fixture.localAuthority,
          recipient: fixture.localCard.agentId,
          id: 40,
          body: "outgoing",
        });
        const outbound = yield* prepareOutbound(
          store,
          "conversation:ambiguous-send",
          outgoing,
        );
        const instance = routerInstanceId(40);
        let calls = 0;
        const requests = yield* Ref.make<RouterSendRequest[]>([]);
        const failingLayer = Layer.succeed(Router, {
          poll: () => Effect.succeed(emptyBatch(instance, pollCursor(7))),
          send: (call) => {
            calls += 1;
            return Ref.update(requests, (values) => [
              ...values,
              call.request,
            ]).pipe(
              Effect.zipRight(
                calls === 1
                  ? Effect.fail(new RouterConnectionError())
                  : acceptedResult(instance, call.request.signedMessage),
              ),
            );
          },
        });
        const worker = yield* provide(
          makeActiveRouterWorker(
            makeInput(fixture, callbacks(), undefined, store),
          ),
          failingLayer,
          fixture,
        );
        yield* provide(worker.send(outbound.outboundId), failingLayer, fixture);
        expect(calls).toBe(2);
        const callsMade = yield* Ref.get(requests);
        expect(callsMade.map((request) => request.mode)).toEqual([
          "initial",
          "retry",
        ]);
        expect(callsMade[1]?.signedMessage).toBe(callsMade[0]?.signedMessage);
        expect((yield* store.recover()).outboundMessages).toEqual([]);
      }),
    ),
  );
};

const retryUnknownRewrapsBody = async (): Promise<void> => {
  await Effect.runPromise(
    withOutbox((store) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const outgoing = yield* signMessage({
          card: fixture.localCard,
          authority: fixture.localAuthority,
          recipient: fixture.localCard.agentId,
          id: 50,
          body: "stable-inner",
        });
        const outbound = yield* prepareOutbound(
          store,
          "conversation:retry-unknown",
          outgoing,
        );
        const instance = routerInstanceId(50);
        const sendCalls = yield* Ref.make<RouterSendRequest[]>([]);
        const callCount = yield* Ref.make(0);
        const layer = Layer.succeed(Router, {
          poll: () => Effect.succeed(emptyBatch(instance, pollCursor(8))),
          send: (call) =>
            Ref.getAndUpdate(callCount, (count) => count + 1).pipe(
              Effect.tap(() =>
                Ref.update(sendCalls, (calls) => [...calls, call.request]),
              ),
              Effect.flatMap(
                (
                  count,
                ): Effect.Effect<RouterSendResult, RouterConnectionError> => {
                  if (count === 0) {
                    return Effect.fail(new RouterConnectionError());
                  }
                  if (count === 1) {
                    return Effect.succeed({
                      kind: "retry_identity_unknown" as const,
                    });
                  }
                  return store.recover().pipe(
                    Effect.orDie,
                    Effect.tap((recovery) => {
                      expect(recovery.outboundMessages).toHaveLength(1);
                      expect(recovery.outboundMessages[0]?.messageId).toBe(
                        messageId(51),
                      );
                      return Effect.void;
                    }),
                    Effect.zipRight(
                      acceptedResult(instance, call.request.signedMessage),
                    ),
                  );
                },
              ),
            ),
        });
        const worker = yield* provide(
          makeActiveRouterWorker(
            makeInput(
              fixture,
              callbacks(),
              { makeMessageId: () => Effect.succeed(messageId(51)) },
              store,
            ),
          ),
          layer,
          fixture,
        );
        yield* provide(worker.send(outbound.outboundId), layer, fixture);
        const calls = yield* Ref.get(sendCalls);
        expect(calls.map((call) => call.mode)).toEqual([
          "initial",
          "retry",
          "initial",
        ]);
        expect(calls[0]?.signedMessage.messageId).toBe(messageId(50));
        expect(calls[2]?.signedMessage.messageId).toBe(messageId(51));
        expect(calls[2]?.signedMessage.body).toEqual(
          calls[0]?.signedMessage.body,
        );
        expect((yield* store.recover()).outboundMessages).toEqual([]);
      }),
    ),
  );
};

const mismatchedAcceptedDigestRetainsOutbound = async (): Promise<void> => {
  await Effect.runPromise(
    withOutbox((store) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const outgoing = yield* signMessage({
          card: fixture.localCard,
          authority: fixture.localAuthority,
          recipient: fixture.localCard.agentId,
          id: 52,
          body: "digest-bound",
        });
        const outbound = yield* prepareOutbound(
          store,
          "conversation:digest-mismatch",
          outgoing,
        );
        const instance = routerInstanceId(52);
        const wrongDigest = Schema.decodeUnknownSync(SignedMessageDigest)(
          `smd_${createHash("sha256").update("different bytes").digest("base64url")}`,
        );
        const layer = Layer.succeed(Router, {
          poll: () => Effect.succeed(emptyBatch(instance, pollCursor(20))),
          send: () =>
            Effect.succeed({
              kind: "accepted" as const,
              routerInstanceId: instance,
              signedMessageDigest: wrongDigest,
            }),
        });
        const worker = yield* provide(
          makeActiveRouterWorker(
            makeInput(fixture, callbacks(), undefined, store),
          ),
          layer,
          fixture,
        );
        const error = yield* provide(
          worker.send(outbound.outboundId).pipe(Effect.flip),
          layer,
          fixture,
        );
        expect(error).toStrictEqual(new RouterWorkerProtocolError());
        expect((yield* store.recover()).outboundMessages).toEqual([outbound]);
      }),
    ),
  );
};

const restartedSendRecoversBeforeReturning = async (): Promise<void> => {
  await Effect.runPromise(
    withOutbox((store) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const outgoing = yield* signMessage({
          card: fixture.localCard,
          authority: fixture.localAuthority,
          recipient: fixture.localCard.agentId,
          id: 55,
          body: "restart-fenced",
        });
        const outbound = yield* prepareOutbound(
          store,
          "conversation:restart-send",
          outgoing,
        );
        const events = yield* Ref.make<string[]>([]);
        const oldInstance = routerInstanceId(55);
        const newInstance = routerInstanceId(56);
        const router = yield* makeScriptedRouter({
          polls: [
            emptyBatch(oldInstance, pollCursor(18)),
            emptyBatch(newInstance, pollCursor(19)),
          ],
          sends: [{ kind: "router_restarted", routerInstanceId: newInstance }],
        });
        const worker = yield* provide(
          makeActiveRouterWorker(
            makeInput(fixture, callbacks({ events }), undefined, store),
          ),
          router.layer,
          fixture,
        );
        const error = yield* provide(
          worker.send(outbound.outboundId).pipe(Effect.flip),
          router.layer,
          fixture,
        );
        expect(error).toStrictEqual(new RouterWorkerDiscontinuityError());
        expect(yield* Ref.get(events)).toEqual([
          "abandon:router_restarted",
          "recover:router_restarted",
        ]);
        expect(yield* Ref.get(router.scripted.pollCalls)).toEqual([
          { hasCursor: false },
          { hasCursor: false },
          { hasCursor: true },
        ]);
        expect(yield* worker.currentAnchor).toEqual({
          routerInstanceId: newInstance,
          pollCursor: pollCursor(19),
        });
        expect((yield* store.recover()).outboundMessages).toEqual([outbound]);
      }),
    ),
  );
};

const restartOrdersTailBeforeRecovery = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const events = yield* Ref.make<string[]>([]);
      const recoveryStarted = yield* Deferred.make<RouterWorkerRecovery>();
      const releaseRecovery = yield* Deferred.make<void>();
      const oldInstance = routerInstanceId(60);
      const newInstance = routerInstanceId(61);
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(oldInstance, pollCursor(9)),
          { kind: "cursor_invalid" },
          emptyBatch(newInstance, pollCursor(10)),
        ],
        fallbackPoll: Effect.never,
      });
      const worker = yield* provide(
        makeActiveRouterWorker(
          makeInput(
            fixture,
            callbacks({
              events,
              recover: (recovery) =>
                Deferred.succeed(recoveryStarted, recovery).pipe(
                  Effect.zipRight(Deferred.await(releaseRecovery)),
                ),
            }),
          ),
        ),
        router.layer,
        fixture,
      );
      const polling = yield* provide(
        Effect.fork(worker.pollOnce),
        router.layer,
        fixture,
      );
      const recovery = yield* Deferred.await(recoveryStarted);
      const unavailable = yield* worker.currentAnchor.pipe(Effect.flip);
      expect(unavailable).toStrictEqual(new RouterWorkerUnavailableError());
      expect(recovery).toMatchObject({
        reason: "router_restarted",
        anchor: {
          routerInstanceId: newInstance,
          pollCursor: pollCursor(10),
        },
      });
      expect(yield* Ref.get(events)).toEqual([
        "abandon:router_restarted",
        "recover:router_restarted",
      ]);
      expect(yield* Ref.get(router.scripted.pollCalls)).toEqual([
        { hasCursor: false },
        { hasCursor: true },
        { hasCursor: false },
        { hasCursor: true },
      ]);
      yield* Deferred.succeed(releaseRecovery, undefined);
      yield* Fiber.join(polling);
      expect(yield* worker.currentAnchor).toEqual({
        routerInstanceId: newInstance,
        pollCursor: pollCursor(10),
      });
    }),
  );
};

const recoveryRetryPromotesChangedTailToRestart = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const events = yield* Ref.make<string[]>([]);
      const recoveryAttempts = yield* Ref.make(0);
      const recoveryStarted = yield* Deferred.make<RouterWorkerRecovery>();
      const releaseRecovery = yield* Deferred.make<void>();
      const oldInstance = routerInstanceId(64);
      const newInstance = routerInstanceId(65);
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(oldInstance, pollCursor(26)),
          { kind: "feed_gap", routerInstanceId: oldInstance },
          emptyBatch(oldInstance, pollCursor(27)),
          emptyBatch(newInstance, pollCursor(28)),
          emptyBatch(newInstance, pollCursor(29)),
        ],
        fallbackPoll: Effect.never,
      });
      const worker = yield* provide(
        makeActiveRouterWorker(
          makeInput(
            fixture,
            callbacks({
              events,
              recover: (recovery) =>
                Ref.getAndUpdate(
                  recoveryAttempts,
                  (attempts) => attempts + 1,
                ).pipe(
                  Effect.flatMap((attempt) =>
                    attempt === 0
                      ? Effect.never
                      : Deferred.succeed(recoveryStarted, recovery).pipe(
                          Effect.zipRight(Deferred.await(releaseRecovery)),
                        ),
                  ),
                ),
            }),
          ),
        ),
        router.layer,
        fixture,
      );

      const firstFailure = yield* provide(
        worker.pollOnce.pipe(Effect.flip),
        router.layer,
        fixture,
      );
      expect(firstFailure).toStrictEqual(new RouterWorkerDiscontinuityError());

      const retry = yield* provide(
        Effect.fork(worker.pollOnce),
        router.layer,
        fixture,
      );
      const recovery = yield* Deferred.await(recoveryStarted);
      const unavailable = yield* worker.currentAnchor.pipe(Effect.flip);
      expect(unavailable).toStrictEqual(new RouterWorkerUnavailableError());
      expect(recovery).toMatchObject({
        reason: "router_restarted",
        anchor: {
          routerInstanceId: newInstance,
          pollCursor: pollCursor(29),
        },
      });
      expect(yield* Ref.get(events)).toEqual([
        "abandon:feed_gap",
        "recover:feed_gap",
        "abandon:router_restarted",
        "recover:router_restarted",
      ]);

      yield* Deferred.succeed(releaseRecovery, undefined);
      yield* Fiber.join(retry);
      expect(yield* worker.currentAnchor).toEqual({
        routerInstanceId: newInstance,
        pollCursor: pollCursor(29),
      });
    }),
  );
};

const recoveryResumesRetainedOutbound = async (): Promise<void> => {
  await Effect.runPromise(
    withOutbox((store) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const outgoing = yield* signMessage({
          card: fixture.localCard,
          authority: fixture.localAuthority,
          recipient: fixture.localCard.agentId,
          id: 62,
          body: "retained-recovery-envelope",
        });
        const outbound = yield* prepareOutbound(
          store,
          "conversation:recovery-resume",
          outgoing,
        );
        yield* store.beginOutbound(outbound.outboundId).pipe(Effect.orDie);
        const instance = routerInstanceId(62);
        const accepted = yield* acceptedResult(instance, outgoing);
        const router = yield* makeScriptedRouter({
          polls: [
            emptyBatch(instance, pollCursor(21)),
            { kind: "cursor_invalid" },
            emptyBatch(instance, pollCursor(22)),
            emptyBatch(instance, pollCursor(23)),
          ],
          sends: [accepted],
        });
        const worker = yield* provide(
          makeActiveRouterWorker(
            makeInput(
              fixture,
              callbacks({
                recover: (recovery) => recovery.resume(outbound.outboundId),
              }),
              undefined,
              store,
            ),
          ),
          router.layer,
          fixture,
        );
        yield* provide(worker.pollOnce, router.layer, fixture);
        const sendCalls = yield* Ref.get(router.scripted.sendCalls);
        expect(sendCalls).toHaveLength(1);
        expect(sendCalls[0]?.request.mode).toBe(retryMode);
        expect(sendCalls[0]?.request.signedMessage).toEqual(outgoing);
        expect((yield* store.recover()).outboundMessages).toEqual([]);
      }),
    ),
  );
};

const normalSendWaitsForRecovery = async (): Promise<void> => {
  await Effect.runPromise(
    withOutbox((store) =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const outgoing = yield* signMessage({
          card: fixture.localCard,
          authority: fixture.localAuthority,
          recipient: fixture.localCard.agentId,
          id: 63,
          body: "recovery-gated-send",
        });
        const outbound = yield* prepareOutbound(
          store,
          "conversation:recovery-gated-send",
          outgoing,
        );
        const recoveryStarted = yield* Deferred.make<void>();
        const releaseRecovery = yield* Deferred.make<void>();
        const instance = routerInstanceId(63);
        const accepted = yield* acceptedResult(instance, outgoing);
        const router = yield* makeScriptedRouter({
          polls: [
            emptyBatch(instance, pollCursor(24)),
            { kind: "cursor_invalid" },
            emptyBatch(instance, pollCursor(25)),
          ],
          sends: [accepted],
          fallbackPoll: Effect.never,
        });
        const worker = yield* provide(
          makeActiveRouterWorker(
            makeInput(
              fixture,
              callbacks({
                recover: () =>
                  Deferred.succeed(recoveryStarted, undefined).pipe(
                    Effect.zipRight(Deferred.await(releaseRecovery)),
                  ),
              }),
              undefined,
              store,
            ),
          ),
          router.layer,
          fixture,
        );
        const recovering = yield* provide(
          Effect.fork(worker.pollOnce),
          router.layer,
          fixture,
        );
        yield* Deferred.await(recoveryStarted);
        const sending = yield* provide(
          Effect.fork(worker.send(outbound.outboundId)),
          router.layer,
          fixture,
        );
        yield* Effect.yieldNow();
        expect(yield* Ref.get(router.scripted.sendCalls)).toEqual([]);
        yield* Deferred.succeed(releaseRecovery, undefined);
        yield* Fiber.join(recovering);
        yield* Fiber.join(sending);
        expect(yield* Ref.get(router.scripted.sendCalls)).toHaveLength(1);
        expect((yield* store.recover()).outboundMessages).toEqual([]);
      }),
    ),
  );
};

const recoveryPumpsIngressBeforeActivation = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const recoveryMessage = yield* signMessage({
        card: fixture.localCard,
        authority: fixture.localAuthority,
        recipient: fixture.localCard.agentId,
        id: 70,
        body: "recovery-vote",
      });
      const accepted = yield* Ref.make<string[]>([]);
      const callbackStarted = yield* Deferred.make<void>();
      const recoveryDurable = yield* Deferred.make<void>();
      const oldInstance = routerInstanceId(70);
      const newInstance = routerInstanceId(71);
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(oldInstance, pollCursor(11)),
          { kind: "cursor_invalid" },
          emptyBatch(newInstance, pollCursor(12)),
          batch(newInstance, pollCursor(13), [recoveryMessage]),
        ],
        fallbackPoll: Effect.never,
      });
      const worker = yield* provide(
        makeActiveRouterWorker(
          makeInput(
            fixture,
            callbacks({
              recoveryAccepted: accepted,
              recover: () =>
                Deferred.succeed(callbackStarted, undefined).pipe(
                  Effect.zipRight(Deferred.await(recoveryDurable)),
                ),
            }),
          ),
        ),
        router.layer,
        fixture,
      );
      const polling = yield* provide(
        Effect.fork(worker.pollOnce),
        router.layer,
        fixture,
      );
      yield* Deferred.await(callbackStarted);
      yield* Effect.gen(function* () {
        while ((yield* Ref.get(accepted)).length === 0) {
          yield* Effect.yieldNow();
        }
      }).pipe(Effect.timeout("1 second"));
      expect(yield* Ref.get(accepted)).toEqual(["recovery-vote"]);
      const unavailable = yield* worker.currentAnchor.pipe(Effect.flip);
      expect(unavailable).toStrictEqual(new RouterWorkerUnavailableError());
      yield* Deferred.succeed(recoveryDurable, undefined);
      yield* Fiber.join(polling);
      expect(yield* worker.currentAnchor).toEqual({
        routerInstanceId: newInstance,
        pollCursor: pollCursor(13),
      });
    }),
  );
};

const recoveryPumpFailureInterruptsCallback = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const callbackStarted = yield* Deferred.make<void>();
      const callbackInterrupted = yield* Deferred.make<void>();
      const oldInstance = routerInstanceId(80);
      const newInstance = routerInstanceId(81);
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(oldInstance, pollCursor(14)),
          { kind: "cursor_invalid" },
          emptyBatch(newInstance, pollCursor(15)),
          { kind: "feed_gap", routerInstanceId: newInstance },
        ],
      });
      const worker = yield* provide(
        makeActiveRouterWorker(
          makeInput(
            fixture,
            callbacks({
              recover: () =>
                Deferred.succeed(callbackStarted, undefined).pipe(
                  Effect.zipRight(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(callbackInterrupted, undefined).pipe(
                      Effect.asVoid,
                    ),
                  ),
                ),
            }),
          ),
        ),
        router.layer,
        fixture,
      );
      const failure = yield* provide(
        worker.pollOnce.pipe(Effect.flip),
        router.layer,
        fixture,
      );
      yield* Deferred.await(callbackStarted);
      yield* Deferred.await(callbackInterrupted);
      expect(failure).toStrictEqual(new RouterWorkerDiscontinuityError());
    }),
  );
};

const pinnedCardsSurviveRegistryOutage = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const remote = yield* makeIdentityFixture(2, "worker-remote");
      const accepted = yield* Ref.make<string[]>([]);
      const instance = routerInstanceId(90);
      const message = yield* signMessage({
        card: remote.localCard,
        authority: remote.localAuthority,
        recipient: fixture.localCard.agentId,
        id: 90,
        body: "durable-history",
      });
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(instance, pollCursor(16)),
          batch(instance, pollCursor(17), [message]),
        ],
      });
      const worker = yield* makeActiveRouterWorker({
        ...makeInput(fixture, callbacks({ accepted })),
        pinnedSenderCards: [fixture.localCard, remote.localCard],
      }).pipe(
        Effect.provide(router.layer),
        Effect.provide(unavailableRegistryLayer),
      );
      yield* worker.pollOnce.pipe(
        Effect.provide(router.layer),
        Effect.provide(unavailableRegistryLayer),
      );
      expect(yield* Ref.get(accepted)).toEqual(["durable-history"]);
      expect((yield* worker.currentAnchor).pollCursor).toBe(pollCursor(17));
    }),
  );
};

const coldStartRecoversBeforeActivation = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const events = yield* Ref.make<string[]>([]);
      const instance = routerInstanceId(100);
      const router = yield* makeScriptedRouter({
        polls: [emptyBatch(instance, pollCursor(18))],
        fallbackPoll: Effect.never,
      });
      const worker = yield* provide(
        makeRouterWorker(makeInput(fixture, callbacks({ events }))),
        router.layer,
        fixture,
      );

      const unavailable = yield* worker.currentAnchor.pipe(Effect.flip);
      expect(unavailable).toStrictEqual(new RouterWorkerUnavailableError());

      yield* provide(worker.pollOnce, router.layer, fixture);

      expect(yield* Ref.get(events)).toEqual([
        "abandon:router_restarted",
        "recover:router_restarted",
      ]);
      expect(yield* worker.currentAnchor).toEqual({
        routerInstanceId: instance,
        pollCursor: pollCursor(18),
      });
    }),
  );
};

// @agent-code-guard/regression-only: these scenarios pin the endpoint cursor and recovery safety boundary.
describe("private Router worker", () => {
  it("requires the decoder for the declared payload type", () => {
    expect(decoderContract).toEqual([true, true]);
  });

  it(
    "recovers certified history before activating a cold worker",
    coldStartRecoversBeforeActivation,
  );
  it(
    "verifies a complete batch before dispatching any item",
    batchVerificationIsAtomic,
  );
  it(
    "accepts or ignores in order before advancing the cursor",
    orderedCursorCommit,
  );
  it(
    "retains the prior cursor when durable acceptance fails",
    persistenceRetainsCursor,
  );
  it(
    "retries an ambiguous send with the original envelope",
    ambiguousSendRetriesSameBytes,
  );
  it(
    "re-envelopes only the byte-identical body after retry identity loss",
    retryUnknownRewrapsBody,
  );
  it(
    "retains an envelope when Router acceptance names different bytes",
    mismatchedAcceptedDigestRetainsOutbound,
  );
  it(
    "recovers a fresh tail before returning a Router-restarted send",
    restartedSendRecoversBeforeReturning,
  );
  it(
    "promotes an omitted-tail instance change before recovery",
    restartOrdersTailBeforeRecovery,
  );
  it(
    "promotes a retry-time omitted-tail instance change before recovery",
    recoveryRetryPromotesChangedTailToRestart,
  );
  it(
    "resumes an already-retained envelope during same-instance recovery",
    recoveryResumesRetainedOutbound,
  );
  it(
    "holds normal sends until recovery activates its Router generation",
    normalSendWaitsForRecovery,
  );
  it(
    "pumps recovery ingress before activating the recovered generation",
    recoveryPumpsIngressBeforeActivation,
  );
  it(
    "interrupts pending recovery when its ingress pump loses continuity",
    recoveryPumpFailureInterruptsCallback,
  );
  it(
    "authenticates pinned history senders while Registry is unavailable",
    pinnedCardsSurviveRegistryOutage,
  );
});

/* eslint-enable max-lines, max-lines-per-function, sonarjs/max-lines-per-function, sonarjs/no-nested-functions, agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore repository defaults. */
