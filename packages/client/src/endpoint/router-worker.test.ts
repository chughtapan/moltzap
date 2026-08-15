/** @file Scripted Router worker ordering, cursor, replay, and recovery laws. */

import {
  AgentCard,
  AgentId,
  type AgentId as AgentIdValue,
  AgentName,
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  Ed25519PublicKey,
  MessageId,
  MOLTZAP_VERSION,
  PrincipalId,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import {
  Registry,
  type RegistryLookupResult,
} from "@moltzap/identity/registry";
import {
  PollCursor,
  Router,
  RouterConnectionError,
  RouterInstanceId,
  type RouterPollResult,
  type RouterSendRequest,
  type RouterSendResult,
} from "@moltzap/router";
import canonicalize from "canonicalize";
import {
  type Context,
  Deferred,
  Effect,
  Encoding,
  Fiber,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  makeRouterWorker,
  type RouterDiscontinuityReason,
  type RouterTailAnchor,
  RouterWorkerAuthenticationError,
  type RouterWorkerCallbacks,
  RouterWorkerDiscontinuityError,
  type RouterWorkerInput,
  RouterWorkerPayloadInvalidError,
  RouterWorkerPersistenceError,
  type RouterWorkerRecoveryError,
  type RouterWorkerSendError,
  RouterWorkerUnavailableError,
} from "./router-worker.js";

/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, sonarjs/no-nested-functions, agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- The scripted scenarios keep each Router trace and its exact ordering assertions together and use Vitest's Promise-native contract. */

interface TestPayload {
  readonly text: string;
}

interface PollCall {
  readonly hasCursor: boolean;
}

interface SendCall {
  readonly request: RouterSendRequest;
}

interface ScriptedRouter {
  readonly polls: Ref.Ref<RouterPollResult[]>;
  readonly sends: Ref.Ref<RouterSendResult[]>;
  readonly pollCalls: Ref.Ref<PollCall[]>;
  readonly sendCalls: Ref.Ref<SendCall[]>;
  readonly fallbackPoll?: Effect.Effect<RouterPollResult>;
}

interface Fixture {
  readonly localCard: VerifiedAgentCard;
  readonly localAuthority: AgentSigningAuthorityValue;
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const agentId = (byte: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(identifier("agt_", byte));

const messageId = (byte: number) =>
  Schema.decodeUnknownSync(MessageId)(identifier("msg_", byte));

const routerInstanceId = (byte: number) =>
  Schema.decodeUnknownSync(RouterInstanceId)(identifier("rti_", byte));

const pollCursor = (byte: number) =>
  Schema.decodeUnknownSync(PollCursor)(
    `plc_eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiYXBwbGljYXRpb24vdm5kLm1vbHR6YXAucG9sbC1jdXJzb3IrandlIn0..${Encoding.encodeBase64Url(new Uint8Array(12).fill(byte))}.${Encoding.encodeBase64Url(new Uint8Array(120).fill(byte))}.${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`,
  );

const makeIdentityFixture = (byte: number, name: string) =>
  Effect.gen(function* () {
    const localKeys = generateKeyPairSync("ed25519");
    const registryKeys = generateKeyPairSync("ed25519");
    const localPrivateKey = localKeys.privateKey.export({
      format: "pem",
      type: "pkcs8",
    });
    const localAuthority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(localPrivateKey),
    ).pipe(Effect.orDie);
    const registrySignerPublicKey = yield* Schema.decodeUnknown(
      Ed25519PublicKey,
    )(registryKeys.publicKey.export({ format: "jwk" }));
    const registryThumbprint = createHash("sha256")
      .update(canonicalize(registrySignerPublicKey) ?? "")
      .digest("base64url");
    const protectedText = canonicalize({
      alg: "Ed25519",
      kid: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${registryThumbprint}`,
      typ: "application/vnd.moltzap.agent-card+jws",
    });
    const payloadText = canonicalize({
      agentId: agentId(byte),
      agentName: Schema.decodeUnknownSync(AgentName)(name),
      issuedAt: "2026-08-13T12:00:00Z",
      kind: "agentCard",
      moltzapVersion: MOLTZAP_VERSION,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        identifier("prn_", byte),
      ),
      publicKey: AgentSigningAuthority.publicKey(localAuthority),
    });
    if (protectedText === undefined || payloadText === undefined) {
      return yield* Effect.die("canonical test card encoding failed");
    }
    const protectedValue = Buffer.from(protectedText).toString("base64url");
    const payload = Buffer.from(payloadText).toString("base64url");
    const signature = signBytes(
      null,
      Buffer.from(`${protectedValue}.${payload}`),
      registryKeys.privateKey,
    ).toString("base64url");
    const parsedLocal = yield* Schema.decodeUnknown(AgentCard)({
      payload,
      signatures: [{ protected: protectedValue, signature }],
    });
    const localCard = yield* AgentCard.verify({
      agentCard: parsedLocal,
      registrySignerPublicKey,
    });
    return {
      localCard,
      localAuthority,
    } satisfies Fixture;
  });

const makeFixture = makeIdentityFixture(1, "worker-local");

const signMessage = (input: {
  readonly card: VerifiedAgentCard;
  readonly authority: AgentSigningAuthorityValue;
  readonly recipient: AgentIdValue;
  readonly id: number;
  readonly body: string;
}): Effect.Effect<SignedMessageValue> =>
  SignedMessage.sign({
    agentCard: input.card,
    signingAuthority: input.authority,
    recipientAgentIds: new Set([input.recipient]),
    messageId: messageId(input.id),
    body: new TextEncoder().encode(input.body),
  }).pipe(Effect.orDie);

const makeScriptedRouter = (input: {
  readonly polls: readonly RouterPollResult[];
  readonly sends?: readonly RouterSendResult[];
  readonly fallbackPoll?: Effect.Effect<RouterPollResult>;
}) =>
  Effect.gen(function* () {
    const scripted: ScriptedRouter = {
      polls: yield* Ref.make([...input.polls]),
      sends: yield* Ref.make([...(input.sends ?? [])]),
      pollCalls: yield* Ref.make<PollCall[]>([]),
      sendCalls: yield* Ref.make<SendCall[]>([]),
      fallbackPoll: input.fallbackPoll,
    };
    const service: Context.Tag.Service<typeof Router> = {
      poll: (call) =>
        Effect.gen(function* () {
          yield* Ref.update(scripted.pollCalls, (calls) => [
            ...calls,
            { hasCursor: call.request.pollCursor !== undefined },
          ]);
          const result = yield* Ref.modify(scripted.polls, (results) => {
            const [head, ...tail] = results;
            return [head, tail] as const;
          });
          return (
            result ??
            (scripted.fallbackPoll === undefined
              ? yield* Effect.die("poll script exhausted")
              : yield* scripted.fallbackPoll)
          );
        }),
      send: (call) =>
        Effect.gen(function* () {
          yield* Ref.update(scripted.sendCalls, (calls) => [
            ...calls,
            { request: call.request },
          ]);
          const result = yield* Ref.modify(scripted.sends, (results) => {
            const [head, ...tail] = results;
            return [head, tail] as const;
          });
          return result ?? (yield* Effect.die("send script exhausted"));
        }),
    };
    return { scripted, layer: Layer.succeed(Router, service) };
  });

const registryLayer = (cards: readonly VerifiedAgentCard[]) =>
  Layer.succeed(Registry, {
    lookup: (request): Effect.Effect<RegistryLookupResult> => {
      const found = cards.find((card) =>
        "agentId" in request
          ? card.agentId === request.agentId
          : card.agentName === request.agentName,
      );
      return Effect.succeed(
        found === undefined
          ? { kind: "not_found" as const }
          : { kind: "found" as const, agentCard: found },
      );
    },
    list: () =>
      Effect.succeed({ kind: "page", agentCards: cards, hasMore: false }),
    register: () => Effect.succeed({ kind: "idempotency_conflict" }),
  });

const unavailableRegistryLayer = Layer.succeed(Registry, {
  lookup: () => Effect.die("Registry must not be queried for a pinned sender"),
  list: () => Effect.die("Registry unavailable"),
  register: () => Effect.die("Registry unavailable"),
});

const emptyBatch = (
  instance: ReturnType<typeof routerInstanceId>,
  cursor: ReturnType<typeof pollCursor>,
): RouterPollResult => ({
  kind: "batch",
  routerInstanceId: instance,
  signedMessages: [],
  pollCursor: cursor,
});

const batch = (
  instance: ReturnType<typeof routerInstanceId>,
  cursor: ReturnType<typeof pollCursor>,
  signedMessages: readonly SignedMessageValue[],
): RouterPollResult => ({
  kind: "batch",
  routerInstanceId: instance,
  signedMessages,
  pollCursor: cursor,
});

const callbacks = (input?: {
  readonly accepted?: Ref.Ref<string[]>;
  readonly recoveryAccepted?: Ref.Ref<string[]>;
  readonly events?: Ref.Ref<string[]>;
  readonly invalidText?: string;
  readonly failAcceptText?: string;
  readonly recover?: (input: {
    readonly reason: RouterDiscontinuityReason;
    readonly anchor: RouterTailAnchor;
    readonly send: (
      message: SignedMessageValue,
    ) => Effect.Effect<void, RouterWorkerSendError>;
  }) => Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError>;
}): RouterWorkerCallbacks<TestPayload> => ({
  pinSenderCard: () => Effect.void,
  decodePayload: (message) => {
    const text = new TextDecoder().decode(message.body);
    return text === input?.invalidText
      ? Effect.fail(new RouterWorkerPayloadInvalidError())
      : Effect.succeed({ text });
  },
  acceptPayload: ({ payload }) =>
    payload.text === input?.failAcceptText
      ? Effect.fail(new RouterWorkerPersistenceError())
      : Effect.gen(function* () {
          if (input?.accepted !== undefined) {
            yield* Ref.update(input.accepted, (values) => [
              ...values,
              payload.text,
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
): RouterWorkerInput<TestPayload> => ({
  callerAgentId: fixture.localCard.agentId,
  callerAgentCard: fixture.localCard,
  pinnedSenderCards: [fixture.localCard],
  signingAuthority: fixture.localAuthority,
  callbacks: workerCallbacks,
  overrides,
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
        makeRouterWorker(
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
        makeRouterWorker(
          makeInput(fixture, callbacks({ accepted, invalidText: "invalid" })),
        ),
        router.layer,
        fixture,
      );
      yield* provide(worker.pollOnce, router.layer, fixture);
      expect(yield* Ref.get(accepted)).toEqual(["one", "two"]);
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
        makeRouterWorker(
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
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const outgoing = yield* signMessage({
        card: fixture.localCard,
        authority: fixture.localAuthority,
        recipient: fixture.localCard.agentId,
        id: 40,
        body: "outgoing",
      });
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
                ? Effect.fail(
                    // The scripted Router service erases public transport errors
                    // so the worker observes one ambiguous Effect failure.
                    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- The test intentionally injects an impossible Router service error.
                    new RouterWorkerAuthenticationError() as never,
                  )
                : Effect.succeed({
                    kind: "accepted" as const,
                    routerInstanceId: instance,
                    // The worker does not inspect the digest receipt.
                    // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- This private scripted boundary does not encode Router wire values.
                    signedMessageDigest: "smd_test" as never,
                  }),
            ),
          );
        },
      });
      const worker = yield* provide(
        makeRouterWorker(makeInput(fixture, callbacks())),
        failingLayer,
        fixture,
      );
      yield* provide(worker.send(outgoing), failingLayer, fixture);
      expect(calls).toBe(2);
      const callsMade = yield* Ref.get(requests);
      expect(callsMade.map((request) => request.mode)).toEqual([
        "initial",
        "retry",
      ]);
      expect(callsMade[1]?.signedMessage).toBe(callsMade[0]?.signedMessage);
    }),
  );
};

const retryUnknownRewrapsBody = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const outgoing = yield* signMessage({
        card: fixture.localCard,
        authority: fixture.localAuthority,
        recipient: fixture.localCard.agentId,
        id: 50,
        body: "stable-inner",
      });
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
                return Effect.succeed({
                  kind: "accepted" as const,
                  routerInstanceId: instance,
                  // The worker does not inspect the digest receipt.
                  // eslint-disable-next-line agent-code-guard/require-assertion-rationale -- This private scripted boundary does not encode Router wire values.
                  signedMessageDigest: "smd_test" as never,
                });
              },
            ),
          ),
      });
      const worker = yield* provide(
        makeRouterWorker(
          makeInput(fixture, callbacks(), {
            makeMessageId: () => Effect.succeed(messageId(51)),
          }),
        ),
        layer,
        fixture,
      );
      yield* provide(worker.send(outgoing), layer, fixture);
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
    }),
  );
};

const restartedSendRecoversBeforeReturning = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const outgoing = yield* signMessage({
        card: fixture.localCard,
        authority: fixture.localAuthority,
        recipient: fixture.localCard.agentId,
        id: 55,
        body: "restart-fenced",
      });
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
        makeRouterWorker(makeInput(fixture, callbacks({ events }))),
        router.layer,
        fixture,
      );
      const error = yield* provide(
        worker.send(outgoing).pipe(Effect.flip),
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
    }),
  );
};

const restartOrdersTailBeforeRecovery = async (): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const events = yield* Ref.make<string[]>([]);
      const oldInstance = routerInstanceId(60);
      const newInstance = routerInstanceId(61);
      const router = yield* makeScriptedRouter({
        polls: [
          emptyBatch(oldInstance, pollCursor(9)),
          { kind: "cursor_invalid" },
          emptyBatch(newInstance, pollCursor(10)),
        ],
      });
      const worker = yield* provide(
        makeRouterWorker(makeInput(fixture, callbacks({ events }))),
        router.layer,
        fixture,
      );
      yield* provide(worker.pollOnce, router.layer, fixture);
      expect(yield* Ref.get(events)).toEqual([
        "abandon:cursor_invalid",
        "recover:cursor_invalid",
      ]);
      expect(yield* Ref.get(router.scripted.pollCalls)).toEqual([
        { hasCursor: false },
        { hasCursor: true },
        { hasCursor: false },
        { hasCursor: true },
      ]);
      expect(yield* worker.currentAnchor).toEqual({
        routerInstanceId: newInstance,
        pollCursor: pollCursor(10),
      });
    }),
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
        makeRouterWorker(
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
        makeRouterWorker(
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
      const worker = yield* makeRouterWorker({
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

// @agent-code-guard/regression-only: these scenarios pin the endpoint cursor and recovery safety boundary.
describe("private Router worker", () => {
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
    "recovers a fresh tail before returning a Router-restarted send",
    restartedSendRecoversBeforeReturning,
  );
  it(
    "abandons folds and anchors with omitted cursor before recovery",
    restartOrdersTailBeforeRecovery,
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

/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function, sonarjs/no-nested-functions, agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type -- Restore repository defaults. */
