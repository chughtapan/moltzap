/** @file Public Router capability tests across HTTP success and typed failure paths. */
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "@effect/platform";
import { it as effectIt } from "@effect/vitest";
import {
  AgentCard,
  AgentId,
  type AgentId as AgentIdValue,
  AgentName,
  AgentSigningAuthority,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  AgentSigningError,
  AuthenticationFailedError,
  InternalServerError,
  MessageId,
  type MessageId as MessageIdValue,
  MOLTZAP_VERSION,
  OverloadedError,
  PrincipalId,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
  type VerifiedAgentCard,
  type VerifiedAgentRequest,
} from "@moltzap/identity";
import canonicalize from "canonicalize";
import {
  Brand,
  ConfigProvider,
  Data,
  Duration,
  Effect,
  Either,
  Encoding,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { calculateJwkThumbprintUri, GeneralSign, importPKCS8 } from "jose";
import { generateKeyPairSync } from "node:crypto";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { describe, expect, it } from "vitest";
import { loadRouterConfiguration, Router } from "../../router.js";
import { RouterServer } from "../../server.js";
import {
  calculateRouterRepresentationLimits,
  type PollCursor as PollCursorValue,
  RouterConnectionError,
  RouterInstanceId,
  type RouterInstanceId as RouterInstanceIdValue,
  RouterInvalidResponseError,
  routerRepresentationLimits,
  RouterRequestTimeoutError,
} from "../contract.js";
import { makeRouterFeedAtOrder, maximumPrivateOrder } from "../feed.js";
import { makePollWaiters } from "../poll-waiters.js";
import { makeRouterRpcClient, withVerifiedRouterRequest } from "../rpc.js";
import { makeRouterSend } from "../send.js";

/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, agent-code-guard/no-hardcoded-assertion-literals -- Each scenario observes the deep capability at its public or private call boundary. */
const utf8Encoder = new TextEncoder();

const identifierPayload = (seed: number): string =>
  Encoding.encodeBase64Url(new Uint8Array(16).fill(seed));

const makeAgentId = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(`agt_${identifierPayload(seed)}`);

const makeMessageId = (seed: number): MessageIdValue =>
  Schema.decodeUnknownSync(MessageId)(`msg_${identifierPayload(seed)}`);

const makeRouterInstanceId = (seed: number): RouterInstanceIdValue =>
  Schema.decodeUnknownSync(RouterInstanceId)(`rti_${identifierPayload(seed)}`);

const canonicalText = (value: unknown): string => {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new Error("test fixture is not canonical JSON");
  }
  return text;
};

const withUtf8Bom = (text: string): Uint8Array => {
  const bytes = utf8Encoder.encode(text);
  const marked = new Uint8Array(bytes.byteLength + 3);
  marked.set([0xef, 0xbb, 0xbf]);
  marked.set(bytes, 3);
  return marked;
};

const withMalformedUtf8Suffix = (text: string): Uint8Array => {
  const bytes = utf8Encoder.encode(text);
  const malformed = new Uint8Array(bytes.byteLength + 1);
  malformed.set(bytes);
  malformed[bytes.byteLength] = 0xff;
  return malformed;
};

const encodedCanonicalJson = (value: unknown): string =>
  Encoding.encodeBase64Url(utf8Encoder.encode(canonicalText(value)));

const makeSignedMessage = (input: {
  readonly senderAgentId: AgentIdValue;
  readonly recipientAgentIds: readonly AgentIdValue[];
  readonly messageId: MessageIdValue;
  readonly body: string;
}): SignedMessageValue =>
  Schema.decodeUnknownSync(SignedMessage)({
    payload: encodedCanonicalJson({
      kind: "signedMessage",
      moltzapVersion: MOLTZAP_VERSION,
      senderAgentId: input.senderAgentId,
      agentCardDigest: `acd_${Encoding.encodeBase64Url(new Uint8Array(32).fill(9))}`,
      recipientAgentIds: input.recipientAgentIds,
      messageId: input.messageId,
      body: Encoding.encodeBase64Url(utf8Encoder.encode(input.body)),
    }),
    signatures: [
      {
        protected: encodedCanonicalJson({
          alg: "Ed25519",
          kid: "urn:test:sender",
          typ: "application/vnd.moltzap.signed-message+jws",
        }),
        signature:
          "KDxTl7gpBIOcp3KzWrPaXGOI8uSNov6xWPXKa421caAinNAc-_pYc_kzBuUde6eY0Ayp21se-jZdCvMGLlbYDg",
      },
    ],
  });

const sender = makeAgentId(1);
const recipient = makeAgentId(2);
const registrySignerPublicKey =
  '{"crv":"Ed25519","kty":"OKP","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}';
const requiredConfiguration = new Map([
  ["MOLTZAP_ROUTER_PORT", "3000"],
  ["MOLTZAP_ROUTER_REGISTRY_ORIGIN", "http://127.0.0.1:3001"],
  ["MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY", registrySignerPublicKey],
]);
const LOOPBACK_HOST = "127.0.0.1";

interface OccupiedListener {
  readonly server: NetServer;
  readonly port: number;
}

class RouterTestFixtureError extends Data.TaggedError(
  "RouterTestFixtureError",
) {}

const effectFails = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<boolean, never, R> =>
  effect.pipe(
    Effect.either,
    Effect.map(
      Either.match({
        onLeft: () => true,
        onRight: () => false,
      }),
    ),
  );

const loadConfigurationFrom = (values: ReadonlyMap<string, string>) =>
  loadRouterConfiguration.pipe(
    Effect.withConfigProvider(ConfigProvider.fromMap(new Map(values))),
  );

const loadConfiguration = (overrides?: ReadonlyMap<string, string>) =>
  loadConfigurationFrom(
    new Map([...requiredConfiguration, ...(overrides ?? [])]),
  );

const makePrivateKeyPem = (): string =>
  generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8",
  });

const makeSigningAuthority = () => {
  return AgentSigningAuthority.fromPkcs8(Redacted.make(makePrivateKeyPem()));
};

const makeRegisteredSenderFixture = () =>
  Effect.gen(function* () {
    const agentSigningAuthority = yield* makeSigningAuthority();
    const registryPrivateKey = makePrivateKeyPem();
    const registrySigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(registryPrivateKey),
    );
    const registrySignerPublicKey = AgentSigningAuthority.publicKey(
      registrySigningAuthority,
    );
    const registryPrivateCryptoKey = yield* Effect.tryPromise({
      try: () => importPKCS8(registryPrivateKey, "Ed25519"),
      catch: () => new RouterTestFixtureError(),
    });
    const registryKeyId = yield* Effect.tryPromise({
      try: () => calculateJwkThumbprintUri(registrySignerPublicKey, "sha256"),
      catch: () => new RouterTestFixtureError(),
    });
    const payload = utf8Encoder.encode(
      canonicalText({
        kind: "agentCard",
        moltzapVersion: MOLTZAP_VERSION,
        agentId: sender,
        principalId: Schema.decodeUnknownSync(PrincipalId)(
          `prn_${identifierPayload(6)}`,
        ),
        agentName: Schema.decodeUnknownSync(AgentName)("registered-sender"),
        publicKey: AgentSigningAuthority.publicKey(agentSigningAuthority),
        issuedAt: "2026-07-30T12:00:00Z",
      }),
    );
    const representation = yield* Effect.tryPromise({
      try: () =>
        new GeneralSign(payload)
          .addSignature(registryPrivateCryptoKey)
          .setProtectedHeader({
            alg: "Ed25519",
            kid: registryKeyId,
            typ: "application/vnd.moltzap.agent-card+jws",
          })
          .sign(),
      catch: () => new RouterTestFixtureError(),
    });
    const parsedCard = yield* Schema.decodeUnknown(AgentCard)(representation);
    const agentCard = yield* AgentCard.verify({
      agentCard: parsedCard,
      registrySignerPublicKey,
    });
    return {
      signingAuthority: agentSigningAuthority,
      verifiedRequest: Brand.nominal<VerifiedAgentRequest>()(
        Object.freeze({
          callerAgentId: sender,
          agentCard,
          request: Object.freeze({}),
        }),
      ),
    };
  });

const acquireOccupiedListener = Effect.async<
  OccupiedListener,
  RouterTestFixtureError
>((resume) => {
  const server = createNetServer();
  const onError = (): void => {
    resume(Effect.fail(new RouterTestFixtureError()));
  };
  server.once("error", onError);
  server.listen(0, LOOPBACK_HOST, () => {
    server.removeListener("error", onError);
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      resume(Effect.fail(new RouterTestFixtureError()));
      return;
    }
    resume(Effect.succeed({ server, port: address.port }));
  });
  return Effect.sync(() => {
    server.close();
  });
});

const releaseOccupiedListener = (
  occupied: OccupiedListener,
): Effect.Effect<undefined> =>
  Effect.async<undefined>((resume) => {
    occupied.server.close(() => {
      resume(Effect.succeed(undefined));
    });
  });

const makeVerifiedRequestFixture = (
  signingAuthority: AgentSigningAuthorityValue,
): VerifiedAgentRequest => {
  const verifiedCard = Brand.nominal<VerifiedAgentCard>()(
    Object.freeze({
      agentId: sender,
      principalId: Schema.decodeUnknownSync(PrincipalId)(
        `prn_${identifierPayload(6)}`,
      ),
      agentName: Schema.decodeUnknownSync(AgentName)("rpc-context"),
      publicKey: AgentSigningAuthority.publicKey(signingAuthority),
      issuedAt: "2026-07-30T12:00:00Z",
    }),
  );
  return Brand.nominal<VerifiedAgentRequest>()(
    Object.freeze({
      callerAgentId: sender,
      agentCard: verifiedCard,
      request: Object.freeze({}),
    }),
  );
};

const runPollWithClient = (
  httpClient: HttpClient.HttpClient,
  signingAuthority: AgentSigningAuthorityValue,
  pollTimeout: Duration.Duration,
) =>
  Router.poll({
    request: {},
    callerAgentId: recipient,
    signingAuthority,
  }).pipe(
    Effect.provide(
      Router.layer({
        origin: new URL("http://router.example:3010"),
        sendTimeout: Duration.seconds(5),
        pollTimeout,
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient))),
    ),
    Effect.either,
  );

describe("private RPC behavior", () => {
  effectIt.scoped(
    "requires proof and preserves context and typed failures",
    () =>
      Effect.gen(function* () {
        const pollCallers = yield* Ref.make<readonly AgentIdValue[]>([]);
        const sendRequests = yield* Ref.make<readonly VerifiedAgentRequest[]>(
          [],
        );
        const client = yield* makeRouterRpcClient({
          send: {
            handle: (request, verifiedRequest) =>
              Effect.sync(() => {
                expect(request.expectedRouterInstanceId).toBe(
                  makeRouterInstanceId(1),
                );
                expect(verifiedRequest.callerAgentId).toBe(sender);
              }).pipe(
                Effect.zipRight(
                  Ref.update(sendRequests, (requests) => [
                    ...requests,
                    verifiedRequest,
                  ]),
                ),
                Effect.zipRight(Effect.fail(new InternalServerError())),
              ),
          },
          poll: {
            handle: (request, verifiedRequest) =>
              Effect.sync(() => {
                expect(request).toEqual({});
              }).pipe(
                Effect.zipRight(
                  Ref.update(pollCallers, (callers) => [
                    ...callers,
                    verifiedRequest.callerAgentId,
                  ]),
                ),
                Effect.as({ kind: "cursor_invalid" } as const),
              ),
          },
        });
        const rpcSendRequest = {
          expectedRouterInstanceId: makeRouterInstanceId(1),
          mode: "initial",
          signedMessage: makeSignedMessage({
            senderAgentId: sender,
            recipientAgentIds: [recipient],
            messageId: makeMessageId(1),
            body: "rpc-context",
          }),
        } as const;
        const missingSendProof = yield* client
          .send({ request: rpcSendRequest })
          .pipe(Effect.either);
        const missingPollProof = yield* client
          .poll({ request: {} })
          .pipe(Effect.either);
        Either.match(missingSendProof, {
          onLeft: (error) => {
            expect(error).toBeInstanceOf(AuthenticationFailedError);
          },
          onRight: () => {
            expect.fail("send RPC ran without registered-agent proof");
          },
        });
        Either.match(missingPollProof, {
          onLeft: (error) => {
            expect(error).toBeInstanceOf(AuthenticationFailedError);
          },
          onRight: () => {
            expect.fail("poll RPC ran without registered-agent proof");
          },
        });
        expect(yield* Ref.get(sendRequests)).toEqual([]);
        expect(yield* Ref.get(pollCallers)).toEqual([]);

        const signingAuthority = yield* makeSigningAuthority();
        const verifiedRequest = makeVerifiedRequestFixture(signingAuthority);
        expect(
          yield* withVerifiedRouterRequest(
            verifiedRequest,
            client.poll({ request: {} }),
          ),
        ).toEqual({ kind: "cursor_invalid" });
        expect(yield* Ref.get(pollCallers)).toEqual([sender]);

        const handlerFailure = yield* withVerifiedRouterRequest(
          verifiedRequest,
          client.send({ request: rpcSendRequest }),
        ).pipe(Effect.either);
        Either.match(handlerFailure, {
          onLeft: (error) => {
            expect(error).toBeInstanceOf(InternalServerError);
          },
          onRight: () => {
            expect.fail("handler failure was converted into success");
          },
        });
        expect(yield* Ref.get(sendRequests)).toEqual([verifiedRequest]);
      }),
  );
});

describe("send exhaustion behavior", () => {
  effectIt.effect(
    "preserves instance, validation, retry, and conflict precedence at the final position",
    () =>
      Effect.gen(function* () {
        const routerInstanceId = makeRouterInstanceId(1);
        const feed = yield* makeRouterFeedAtOrder({
          routerInstanceId,
          retainedMessageCapacity: 2,
          retainedMessageByteCapacity: 2_000_000,
          initialTailOrder: maximumPrivateOrder - 1n,
        });
        const send = makeRouterSend({
          routerInstanceId,
          feed,
          pollWaiters: yield* makePollWaiters(1),
        });
        const senderFixture = yield* makeRegisteredSenderFixture();
        const finalMessage = yield* SignedMessage.sign({
          agentCard: senderFixture.verifiedRequest.agentCard,
          signingAuthority: senderFixture.signingAuthority,
          recipientAgentIds: new Set([recipient]),
          messageId: makeMessageId(1),
          body: utf8Encoder.encode("final-position"),
        });
        const finalRequest = {
          expectedRouterInstanceId: routerInstanceId,
          mode: "initial",
          signedMessage: Schema.encodeSync(SignedMessage)(finalMessage),
        } as const;
        const accepted = yield* send.handle(
          finalRequest,
          senderFixture.verifiedRequest,
        );
        expect(accepted.kind).toBe("accepted");
        expect((yield* feed.snapshot).tailOrder).toBe(maximumPrivateOrder);

        expect(
          yield* send.handle(
            {
              ...finalRequest,
              expectedRouterInstanceId: makeRouterInstanceId(2),
              signedMessage: null,
            },
            senderFixture.verifiedRequest,
          ),
        ).toEqual({
          kind: "router_restarted",
          routerInstanceId,
        });
        expect(
          yield* send.handle(
            {
              ...finalRequest,
              signedMessage: Schema.encodeSync(SignedMessage)(
                makeSignedMessage({
                  senderAgentId: sender,
                  recipientAgentIds: [recipient],
                  messageId: makeMessageId(2),
                  body: "invalid-signature",
                }),
              ),
            },
            senderFixture.verifiedRequest,
          ),
        ).toEqual({ kind: "message_invalid" });
        expect(
          yield* send.handle(finalRequest, senderFixture.verifiedRequest),
        ).toEqual({ kind: "idempotency_conflict" });
        expect(
          yield* send.handle(
            { ...finalRequest, mode: "retry" },
            senderFixture.verifiedRequest,
          ),
        ).toEqual(accepted);

        const nextMessage = yield* SignedMessage.sign({
          agentCard: senderFixture.verifiedRequest.agentCard,
          signingAuthority: senderFixture.signingAuthority,
          recipientAgentIds: new Set([recipient]),
          messageId: makeMessageId(2),
          body: utf8Encoder.encode("past-final-position"),
        });
        const exhausted = yield* send
          .handle(
            {
              expectedRouterInstanceId: routerInstanceId,
              mode: "initial",
              signedMessage: Schema.encodeSync(SignedMessage)(nextMessage),
            },
            senderFixture.verifiedRequest,
          )
          .pipe(Effect.either);
        Either.match(exhausted, {
          onLeft: (error) => {
            expect(error).toBeInstanceOf(OverloadedError);
          },
          onRight: () => {
            expect.fail("fresh append succeeded past the final position");
          },
        });
        expect((yield* feed.snapshot).tailOrder).toBe(maximumPrivateOrder);
      }),
  );
});

describe("configuration behavior", () => {
  effectIt.effect("loads only declared values and owns its defaults", () =>
    Effect.gen(function* () {
      const defaults = yield* loadConfiguration(
        new Map([["MOLTZAP_ROUTER_UNUSED", "ignored"]]),
      );
      expect(defaults).toMatchObject({
        host: "127.0.0.1",
        port: 3000,
        retainedMessageCapacity: 4_096,
        retainedMessageByteCapacity: 67_108_864,
        pollMessageLimit: 128,
        pollResponseByteLimit: 1_048_576,
        requestConcurrencyLimit: 512,
        heldPollCapacity: 256,
        liveNonceCapacity: 100_000,
        agentCardCacheCapacity: 10_000,
        registryLookupConcurrencyLimit: 32,
        registryLookupTimeoutMs: 5_000,
      });
      expect(defaults.registryOrigin.href).toBe("http://127.0.0.1:3001/");
      expect(defaults.registrySignerPublicKey).toEqual({
        crv: "Ed25519",
        kty: "OKP",
        x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
      });

      const configured = yield* loadConfiguration(
        new Map([
          ["MOLTZAP_ROUTER_HOST", "0.0.0.0"],
          ["MOLTZAP_ROUTER_PORT", "3002"],
          ["MOLTZAP_ROUTER_REGISTRY_ORIGIN", "https://registry.example"],
          ["MOLTZAP_ROUTER_RETAINED_MESSAGE_CAPACITY", "2"],
          ["MOLTZAP_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY", "500000"],
          ["MOLTZAP_ROUTER_POLL_MESSAGE_LIMIT", "1"],
          [
            "MOLTZAP_ROUTER_POLL_RESPONSE_BYTE_LIMIT",
            String(routerRepresentationLimits.oneMessageBatchBytes),
          ],
          ["MOLTZAP_ROUTER_REQUEST_CONCURRENCY_LIMIT", "4"],
          ["MOLTZAP_ROUTER_HELD_POLL_CAPACITY", "3"],
          ["MOLTZAP_ROUTER_LIVE_NONCE_CAPACITY", "5"],
          ["MOLTZAP_ROUTER_AGENT_CARD_CACHE_CAPACITY", "6"],
          ["MOLTZAP_ROUTER_REGISTRY_LOOKUP_CONCURRENCY_LIMIT", "2"],
          ["MOLTZAP_ROUTER_REGISTRY_LOOKUP_TIMEOUT_MS", "7"],
        ]),
      );
      expect(configured).toMatchObject({
        host: "0.0.0.0",
        port: 3002,
        retainedMessageCapacity: 2,
        retainedMessageByteCapacity: 500_000,
        pollMessageLimit: 1,
        pollResponseByteLimit: 472_119,
        requestConcurrencyLimit: 4,
        heldPollCapacity: 3,
        liveNonceCapacity: 5,
        agentCardCacheCapacity: 6,
        registryLookupConcurrencyLimit: 2,
        registryLookupTimeoutMs: 7,
      });
      expect(configured.registryOrigin.href).toBe("https://registry.example/");
      expect(
        (yield* loadConfiguration(new Map([["MOLTZAP_ROUTER_HOST", "::"]])))
          .host,
      ).toBe("::");
      expect(routerRepresentationLimits).toEqual({
        sendRequestBodyBytes: 471_819,
        pollRequestBodyBytes: 422,
        oneMessageBatchBytes: 472_119,
      });
      expect(
        yield* effectFails(
          calculateRouterRepresentationLimits(Number.MAX_SAFE_INTEGER),
        ),
      ).toBe(true);
    }),
  );

  effectIt.effect("rejects invalid values and inconsistent bounds", () =>
    Effect.gen(function* () {
      const numericKeys = [
        "MOLTZAP_ROUTER_PORT",
        "MOLTZAP_ROUTER_RETAINED_MESSAGE_CAPACITY",
        "MOLTZAP_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY",
        "MOLTZAP_ROUTER_POLL_MESSAGE_LIMIT",
        "MOLTZAP_ROUTER_POLL_RESPONSE_BYTE_LIMIT",
        "MOLTZAP_ROUTER_REQUEST_CONCURRENCY_LIMIT",
        "MOLTZAP_ROUTER_HELD_POLL_CAPACITY",
        "MOLTZAP_ROUTER_LIVE_NONCE_CAPACITY",
        "MOLTZAP_ROUTER_AGENT_CARD_CACHE_CAPACITY",
        "MOLTZAP_ROUTER_REGISTRY_LOOKUP_CONCURRENCY_LIMIT",
        "MOLTZAP_ROUTER_REGISTRY_LOOKUP_TIMEOUT_MS",
      ] as const;
      const invalidCases = [
        ...numericKeys.map((key) => [key, new Map([[key, "0"]])] as const),
        [
          "noncanonical integer",
          new Map([["MOLTZAP_ROUTER_PORT", "+3000"]]),
        ] as const,
        [
          "fractional integer",
          new Map([["MOLTZAP_ROUTER_PORT", "3000.0"]]),
        ] as const,
        ["negative integer", new Map([["MOLTZAP_ROUTER_PORT", "-1"]])] as const,
        [
          "exponent integer",
          new Map([["MOLTZAP_ROUTER_PORT", "3e3"]]),
        ] as const,
        [
          "whitespace integer",
          new Map([["MOLTZAP_ROUTER_PORT", " 3000"]]),
        ] as const,
        ["empty bind host", new Map([["MOLTZAP_ROUTER_HOST", ""]])] as const,
        [
          "port above range",
          new Map([["MOLTZAP_ROUTER_PORT", "65536"]]),
        ] as const,
        [
          "process integer above range",
          new Map([["MOLTZAP_ROUTER_LIVE_NONCE_CAPACITY", "2147483648"]]),
        ] as const,
        [
          "origin with route path",
          new Map([
            ["MOLTZAP_ROUTER_REGISTRY_ORIGIN", "http://127.0.0.1:3001/path"],
          ]),
        ] as const,
        [
          "origin with user information",
          new Map([
            ["MOLTZAP_ROUTER_REGISTRY_ORIGIN", "http://user@127.0.0.1:3001"],
          ]),
        ] as const,
        [
          "origin with query",
          new Map([
            [
              "MOLTZAP_ROUTER_REGISTRY_ORIGIN",
              "http://127.0.0.1:3001?lookup=1",
            ],
          ]),
        ] as const,
        [
          "origin with fragment",
          new Map([
            ["MOLTZAP_ROUTER_REGISTRY_ORIGIN", "http://127.0.0.1:3001#lookup"],
          ]),
        ] as const,
        [
          "noncanonical signer key",
          new Map([
            [
              "MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY",
              '{"kty":"OKP","crv":"Ed25519","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}',
            ],
          ]),
        ] as const,
        [
          "retention cannot hold one message",
          new Map([
            [
              "MOLTZAP_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY",
              String(SignedMessage.maximumEncodedByteLength - 1),
            ],
          ]),
        ] as const,
        [
          "response cannot hold one message",
          new Map([
            [
              "MOLTZAP_ROUTER_POLL_RESPONSE_BYTE_LIMIT",
              String(routerRepresentationLimits.oneMessageBatchBytes - 1),
            ],
          ]),
        ] as const,
        [
          "held polls consume every request permit",
          new Map([
            ["MOLTZAP_ROUTER_REQUEST_CONCURRENCY_LIMIT", "4"],
            ["MOLTZAP_ROUTER_HELD_POLL_CAPACITY", "4"],
          ]),
        ] as const,
      ];
      yield* Effect.forEach(
        invalidCases,
        ([caseName, overrides]) =>
          effectFails(loadConfiguration(overrides)).pipe(
            Effect.map((failed) => {
              expect(failed, caseName).toBe(true);
              return failed;
            }),
          ),
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(
        [...requiredConfiguration.keys()],
        (missingKey) => {
          const withoutRequiredValue = new Map(requiredConfiguration);
          withoutRequiredValue.delete(missingKey);
          return effectFails(loadConfigurationFrom(withoutRequiredValue)).pipe(
            Effect.map((failed) => {
              expect(failed, missingKey).toBe(true);
              return failed;
            }),
          );
        },
        { concurrency: 1, discard: true },
      );
    }),
  );

  effectIt.scoped("reports configuration and listener startup phases", () =>
    Effect.gen(function* () {
      const configurationOutcome = yield* Layer.build(RouterServer.layer).pipe(
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
        Effect.either,
      );
      Either.match(configurationOutcome, {
        onLeft: (error) => {
          expect(error).toBeInstanceOf(RouterServer.StartupError);
          expect(error.phase).toBe("configuration");
        },
        onRight: () => {
          expect.fail("Router started without required configuration");
        },
      });

      const occupied = yield* Effect.acquireRelease(
        acquireOccupiedListener,
        releaseOccupiedListener,
      );
      const listenerOutcome = yield* Layer.build(RouterServer.layer).pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ...requiredConfiguration,
              ["MOLTZAP_ROUTER_HOST", LOOPBACK_HOST],
              ["MOLTZAP_ROUTER_PORT", String(occupied.port)],
            ]),
          ),
        ),
        Effect.either,
      );
      Either.match(listenerOutcome, {
        onLeft: (error) => {
          expect(error).toBeInstanceOf(RouterServer.StartupError);
          expect(error.phase).toBe("listener");
        },
        onRight: () => {
          expect.fail("Router acquired an occupied listener");
        },
      });
    }),
  );
});

describe("public client behavior", () => {
  effectIt.effect(
    "snapshots its origin and rejects the wrong response media type",
    () =>
      Effect.gen(function* () {
        let requestedUrl = "";
        const httpClient = HttpClient.make((request, url) => {
          requestedUrl = url.href;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response('{"kind":"cursor_invalid"}', {
                status: 200,
                headers: { "content-type": "text/plain" },
              }),
            ),
          );
        });
        const origin = new URL("http://router.example:3010");
        const routerLayer = Router.layer({
          origin,
          sendTimeout: Duration.seconds(5),
          pollTimeout: Duration.seconds(5),
        }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
        );
        origin.hostname = "mutated.example";
        const signingAuthority = yield* makeSigningAuthority();
        const outcome = yield* Router.poll({
          request: {},
          callerAgentId: recipient,
          signingAuthority,
        }).pipe(Effect.provide(routerLayer), Effect.either);
        expect(requestedUrl).toBe(
          "http://router.example:3010/v1/messages:poll",
        );
        Either.match(outcome, {
          onLeft: (error) => {
            expect(error).toBeInstanceOf(RouterInvalidResponseError);
          },
          onRight: () => {
            expect.fail("wrong response media type was accepted");
          },
        });
      }),
  );

  it("keeps server, invalid-response, connection, and timeout failures distinct", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const signingAuthority = yield* makeSigningAuthority();
        const responseCases = [
          {
            name: "malformed request",
            status: 400,
            body: '{"error":"malformed"}',
            expectedTag: "MalformedRequestError",
          },
          {
            name: "authentication failure",
            status: 401,
            body: '{"error":"authentication_failed"}',
            expectedTag: "AuthenticationFailedError",
          },
          {
            name: "route not found",
            status: 404,
            body: '{"error":"not_found"}',
            expectedTag: "RouteNotFoundError",
          },
          {
            name: "method not allowed",
            status: 405,
            body: '{"error":"method_not_allowed"}',
            expectedTag: "MethodNotAllowedError",
          },
          {
            name: "version mismatch",
            status: 412,
            body: '{"error":"version_mismatch"}',
            expectedTag: "VersionMismatchError",
          },
          {
            name: "payload too large",
            status: 413,
            body: '{"error":"payload_too_large"}',
            expectedTag: "PayloadTooLargeError",
          },
          {
            name: "unsupported media type",
            status: 415,
            body: '{"error":"unsupported_media_type"}',
            expectedTag: "UnsupportedMediaTypeError",
          },
          {
            name: "overloaded",
            status: 429,
            body: '{"error":"overloaded"}',
            expectedTag: "OverloadedError",
          },
          {
            name: "internal failure",
            status: 500,
            body: '{"error":"internal"}',
            expectedTag: "InternalServerError",
          },
          {
            name: "unavailable",
            status: 503,
            body: '{"error":"unavailable"}',
            expectedTag: "UnavailableError",
          },
          {
            name: "mismatched server envelope",
            status: 503,
            body: '{"error":"internal"}',
            expectedTag: "RouterInvalidResponseError",
          },
          {
            name: "undeclared status",
            status: 418,
            body: '{"error":"unavailable"}',
            expectedTag: "RouterInvalidResponseError",
          },
          {
            name: "noncanonical success",
            status: 200,
            body: '{ "kind":"cursor_invalid" }',
            expectedTag: "RouterInvalidResponseError",
          },
        ] as const;
        for (const scenario of responseCases) {
          const client = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(scenario.body, {
                  status: scenario.status,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          );
          const outcome = yield* runPollWithClient(
            client,
            signingAuthority,
            Duration.seconds(5),
          );
          const tag = Either.match(outcome, {
            onLeft: (error) => error._tag,
            onRight: () => "unexpected_success",
          });
          expect(tag, scenario.name).toBe(scenario.expectedTag);
        }

        const invalidByteResponseCases = [
          {
            name: "success response with a UTF-8 byte-order mark",
            status: 200,
            body: withUtf8Bom('{"kind":"cursor_invalid"}'),
          },
          {
            name: "success response with malformed UTF-8",
            status: 200,
            body: withMalformedUtf8Suffix('{"kind":"cursor_invalid"}'),
          },
          {
            name: "error response with a UTF-8 byte-order mark",
            status: 503,
            body: withUtf8Bom('{"error":"unavailable"}'),
          },
          {
            name: "error response with malformed UTF-8",
            status: 503,
            body: withMalformedUtf8Suffix('{"error":"unavailable"}'),
          },
        ] as const;
        for (const scenario of invalidByteResponseCases) {
          const client = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(scenario.body, {
                  status: scenario.status,
                  headers: { "content-type": "application/json" },
                }),
              ),
            ),
          );
          const outcome = yield* runPollWithClient(
            client,
            signingAuthority,
            Duration.seconds(5),
          );
          const tag = Either.match(outcome, {
            onLeft: (error) => error._tag,
            onRight: () => "unexpected_success",
          });
          expect(tag, scenario.name).toBe("RouterInvalidResponseError");
        }

        const connectionOutcome = yield* runPollWithClient(
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.RequestError({
                request,
                reason: "Transport",
              }),
            ),
          ),
          signingAuthority,
          Duration.seconds(5),
        );
        Either.match(connectionOutcome, {
          onLeft: (error) => {
            expect(error).toBeInstanceOf(RouterConnectionError);
          },
          onRight: () => {
            expect.fail("connection failure produced a result");
          },
        });

        const timeoutOutcome = yield* runPollWithClient(
          HttpClient.make(() => Effect.never),
          signingAuthority,
          Duration.millis(5),
        );
        Either.match(timeoutOutcome, {
          onLeft: (error) => {
            expect(error).toBeInstanceOf(RouterRequestTimeoutError);
          },
          onRight: () => {
            expect.fail("expired call produced a result");
          },
        });

        let requestCount = 0;
        const signingOutcome = yield* Router.poll({
          request: {
            pollCursor: Brand.nominal<PollCursorValue>()("not-a-poll-cursor"),
          },
          callerAgentId: recipient,
          signingAuthority,
        }).pipe(
          Effect.provide(
            Router.layer({
              origin: new URL("http://router.example:3010"),
              sendTimeout: Duration.seconds(5),
              pollTimeout: Duration.seconds(5),
            }).pipe(
              Layer.provide(
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make(() => {
                    requestCount += 1;
                    return Effect.die("invalid request reached HTTP");
                  }),
                ),
              ),
            ),
          ),
          Effect.either,
        );
        Either.match(signingOutcome, {
          onLeft: (error) => {
            expect(error).toBeInstanceOf(AgentSigningError);
          },
          onRight: () => {
            expect.fail("invalid local request was signed");
          },
        });
        expect(requestCount).toBe(0);
      }),
    ));
});
/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, agent-code-guard/no-hardcoded-assertion-literals -- Restore production defaults after the scenario suite. */
