/* eslint-disable agent-code-guard/no-example-only-tests -- regression-only suite: each case exercises a distinct HTTP proof, replay-ordering, cache, or cancellation contract. The concurrency timelines are not an input domain to generate over. */
import {
  Headers,
  HttpClientRequest,
  HttpServerRequest,
} from "@effect/platform";
import { httpbis, type VerifyingKey } from "http-message-signatures";
import { generateKeyPairSync, randomBytes, webcrypto } from "node:crypto";
import {
  Deferred,
  Clock,
  Duration,
  Effect,
  Either,
  Encoding,
  Fiber,
  Layer,
  Match,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { importJWK } from "jose";
import { expect, it } from "vitest";
import {
  AgentSigningAuthority,
  agentSigningPrivateKey,
  ed25519PublicKeyThumbprintUri,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
} from "../agent-key.js";
import {
  AgentCardIssuedAt,
  issueAgentCard,
  type VerifiedAgentCard,
} from "../agent-card.js";
import { AuthenticatedHttp } from "../authenticated-http.js";
import {
  AuthenticationFailedError,
  UnavailableError,
  VersionMismatchError,
} from "../http-errors.js";
import {
  contentDigest,
  verifyHttpRequestSignature,
} from "../http-signature.js";
import {
  AgentId,
  AgentName,
  PrincipalId,
  type AgentId as AgentIdValue,
} from "../identifiers.js";
import {
  RegistryConnectionError,
  type RegistryClientService,
} from "../registry/contract.js";
import { Registry } from "../registry.js";

const REQUEST_URL = new URL(
  "http://identity.test/v1/messages:poll?view=current",
);
const NORMAL_FIELDS = Object.freeze([
  "@method",
  "@authority",
  "@path",
  "@query",
  "content-digest",
  "content-type",
  "moltzap-version",
]);
const SIGNATURE_PARAMETERS = Object.freeze([
  "created",
  "expires",
  "keyid",
  "nonce",
  "alg",
  "tag",
]);
const WRONG_VERSION = "wrong-version";
const SIGNATURE_INTERVAL_MILLISECONDS = 300_000;
const CONCURRENT_REQUEST_COUNT = 4;
const REGISTRY_LOOKUP_DEADLINE = Duration.millis(20);
const RESOLVER_REGRESSION_DEADLINE = Duration.seconds(2);
const AUTHENTICATION_FAILED_TAG = "AuthenticationFailedError";
const VERIFIED_PROOF_FIELDS = Object.freeze([
  "agentCard",
  "callerAgentId",
  "request",
]);

interface IdentityFixture {
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthorityValue;
}

interface PreparedRequest {
  readonly bodyBytes: Uint8Array;
  readonly clientRequest: HttpClientRequest.HttpClientRequest;
  readonly serverRequest: HttpServerRequest.HttpServerRequest;
}

interface RequestMutation {
  readonly name: string;
  readonly prepared: PreparedRequest;
}

interface TestSignatureParameters {
  readonly created: Date;
  readonly expires: Date;
  readonly keyid: string;
  readonly nonce: string;
}

interface ResolverRequests {
  readonly cached: PreparedRequest;
  readonly concurrent: readonly PreparedRequest[];
  readonly unseenAfterRefusal: readonly [PreparedRequest, PreparedRequest];
  readonly unseenDuringOutage: PreparedRequest;
}

type LookupMode =
  | Readonly<{ kind: "found"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "unavailable" }>;

interface LookupController {
  readonly count: Ref.Ref<number>;
  readonly mode: Ref.Ref<LookupMode>;
  readonly release: Deferred.Deferred<undefined>;
  readonly started: Deferred.Deferred<undefined>;
}

const identifier = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(16).fill(byte))}`;

const makeAgentId = (byte: number) =>
  Schema.decodeUnknownSync(AgentId)(identifier("agt_", byte));

const makeSigningAuthority = () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey.export({ format: "pem", type: "pkcs8" })),
  );
};

const makeIdentityFixture = Effect.gen(function* () {
  const registryAuthority = yield* makeSigningAuthority();
  const signingAuthority = yield* makeSigningAuthority();
  const agentCard = yield* issueAgentCard({
    agentId: makeAgentId(1),
    principalId: Schema.decodeUnknownSync(PrincipalId)(identifier("prn_", 2)),
    agentName: Schema.decodeUnknownSync(AgentName)("http-signer"),
    publicKey: AgentSigningAuthority.publicKey(signingAuthority),
    issuedAt: Schema.decodeUnknownSync(AgentCardIssuedAt)(
      "2026-07-30T12:00:00Z",
    ),
    registrySigningAuthority: registryAuthority,
  });
  return { agentCard, signingAuthority } satisfies IdentityFixture;
});

const requestBodyBytes = (request: HttpClientRequest.HttpClientRequest) =>
  Match.value(request.body).pipe(
    Match.tag("Uint8Array", (body) =>
      Effect.succeed(Uint8Array.from(body.body)),
    ),
    Match.tag("Empty", "Raw", "FormData", "Stream", () =>
      Effect.dieMessage("signed request did not retain byte body"),
    ),
    Match.exhaustive,
  );

const toServerRequest = (
  request: HttpClientRequest.HttpClientRequest,
): HttpServerRequest.HttpServerRequest => {
  const url = new URL(request.url);
  const webRequest = new Request(url, {
    method: request.method,
    headers: {
      ...request.headers,
      host: url.host,
    },
  });
  return HttpServerRequest.fromWeb(webRequest);
};

const prepareRequest = (input: {
  readonly fixture: IdentityFixture;
  readonly callerAgentId?: AgentIdValue;
  readonly encodedRequest?: unknown;
}) =>
  Effect.gen(function* () {
    const clientRequest = yield* AuthenticatedHttp.signAgentRequest({
      httpRequest: HttpClientRequest.post(REQUEST_URL),
      callerAgentId: input.callerAgentId ?? input.fixture.agentCard.agentId,
      encodedRequest: input.encodedRequest ?? { pollCursor: "cursor" },
      signingAuthority: input.fixture.signingAuthority,
    });
    const bodyBytes = yield* requestBodyBytes(clientRequest);
    return {
      bodyBytes,
      clientRequest,
      serverRequest: toServerRequest(clientRequest),
    } satisfies PreparedRequest;
  });

const verifySignature = (prepared: PreparedRequest, fixture: IdentityFixture) =>
  verifyHttpRequestSignature({
    httpRequest: prepared.serverRequest,
    bodyBytes: prepared.bodyBytes,
    publicKey: AgentSigningAuthority.publicKey(fixture.signingAuthority),
    profile: "normal",
  });

const makeLookupController = (mode: LookupMode) =>
  Effect.gen(function* () {
    const count = yield* Ref.make(0);
    const modeRef = yield* Ref.make(mode);
    const release = yield* Deferred.make<undefined>();
    const started = yield* Deferred.make<undefined>();
    return {
      count,
      mode: modeRef,
      release,
      started,
    } satisfies LookupController;
  });

const makeExpiryBoundaryClock = (expiresAt: number) =>
  Effect.gen(function* () {
    const liveClock = Clock.make();
    const release = yield* Deferred.make<undefined>();
    const sampled = yield* Deferred.make<undefined>();
    const sampleCount = yield* Ref.make(0);
    const expiresAtMilliseconds = expiresAt * 1_000;
    const expiredMilliseconds = expiresAtMilliseconds + 1_000;
    const currentTimeMillis = Ref.updateAndGet(
      sampleCount,
      (count) => count + 1,
    ).pipe(
      Effect.tap((count) =>
        count === 2 ? Deferred.succeed(sampled, undefined) : Effect.void,
      ),
      Effect.flatMap((count) =>
        count <= 2
          ? Deferred.await(release).pipe(Effect.as(expiresAtMilliseconds))
          : Effect.succeed(expiredMilliseconds),
      ),
    );
    const clock = {
      [Clock.ClockTypeId]: Clock.ClockTypeId,
      unsafeCurrentTimeMillis: () => expiredMilliseconds,
      currentTimeMillis,
      unsafeCurrentTimeNanos: () => BigInt(expiredMilliseconds) * 1_000_000n,
      currentTimeNanos: liveClock.currentTimeNanos,
      sleep: (duration: Parameters<Clock.Clock["sleep"]>[0]) =>
        liveClock.sleep(duration),
    } satisfies Clock.Clock;
    return { clock, release, sampled, sampleCount };
  });

const lookupAgentCard = (controller: LookupController, agentId: AgentIdValue) =>
  Effect.gen(function* () {
    yield* Ref.update(controller.count, (count) => count + 1);
    yield* Deferred.succeed(controller.started, undefined);
    yield* Deferred.await(controller.release);
    const mode = yield* Ref.get(controller.mode);
    if (mode.kind === "unavailable") {
      return yield* new RegistryConnectionError();
    }
    if (mode.kind === "not_found" || mode.agentCard.agentId !== agentId) {
      return { kind: "not_found" } as const;
    }
    return { kind: "found", agentCard: mode.agentCard } as const;
  });

const registryService = (
  controller: LookupController,
): RegistryClientService => {
  const lookup: RegistryClientService["lookup"] = (request) =>
    "agentId" in request
      ? lookupAgentCard(controller, request.agentId)
      : Effect.dieMessage("the request under test must select an AgentId");
  return {
    register: () => Effect.dieMessage("registration is outside this test"),
    lookup,
    list: () => Effect.dieMessage("listing is outside this test"),
  };
};

const deadlineRegistryService = (
  controller: LookupController,
): RegistryClientService => ({
  register: () => Effect.dieMessage("registration is outside this test"),
  lookup: (request) =>
    "agentId" in request
      ? Effect.gen(function* () {
          yield* Ref.update(controller.count, (count) => count + 1);
          yield* Deferred.succeed(controller.started, undefined);
          yield* Deferred.await(controller.release);
          return yield* Effect.never.pipe(
            Effect.timeoutFail({
              duration: REGISTRY_LOOKUP_DEADLINE,
              onTimeout: () => new RegistryConnectionError(),
            }),
          );
        })
      : Effect.dieMessage("the request under test must select an AgentId"),
  list: () => Effect.dieMessage("listing is outside this test"),
});

const authenticatedHttpLayerWithRegistry = (
  registry: RegistryClientService,
  registryLookupConcurrencyLimit = 4,
) =>
  AuthenticatedHttp.layer({
    liveNonceCapacity: 64,
    agentCardCacheCapacity: 8,
    registryLookupConcurrencyLimit,
  }).pipe(Layer.provide(Layer.succeed(Registry, registry)));

const authenticatedHttpLayer = (controller: LookupController) =>
  authenticatedHttpLayerWithRegistry(registryService(controller));

const verifyAgentRequest = (prepared: PreparedRequest) =>
  AuthenticatedHttp.verifyAgentRequest({
    httpRequest: prepared.serverRequest,
    bodyBytes: prepared.bodyBytes,
  });

const releaseLookups = (controller: LookupController) =>
  Deferred.succeed(controller.release, undefined).pipe(Effect.asVoid);

const makeOracleKey = (keyid: string, publicKey: CryptoKey): VerifyingKey => ({
  id: keyid,
  algs: ["ed25519"],
  verify: (bytes, signature) =>
    Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          webcrypto.subtle.verify(
            "Ed25519",
            publicKey,
            Uint8Array.from(signature),
            Uint8Array.from(bytes),
          ),
        catch: (cause) =>
          new Error("RFC 9421 oracle verification failed", { cause }),
      }),
    ),
});

const oracleVerifies = (prepared: PreparedRequest, fixture: IdentityFixture) =>
  Effect.gen(function* () {
    const publicJwk = AgentSigningAuthority.publicKey(fixture.signingAuthority);
    const [publicKey, keyid] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () => importJWK(publicJwk, "Ed25519"),
          catch: (cause) =>
            new Error("could not import oracle public key", { cause }),
        }),
        ed25519PublicKeyThumbprintUri(publicJwk),
      ] as const,
      { concurrency: 2 },
    );
    const key = makeOracleKey(keyid, publicKey);
    const verified = yield* Effect.tryPromise({
      try: () =>
        httpbis.verifyMessage(
          {
            all: true,
            requiredFields: [...NORMAL_FIELDS],
            requiredParams: [...SIGNATURE_PARAMETERS],
            keyLookup: () => Effect.runPromise(Effect.succeed(key)),
          },
          {
            method: prepared.clientRequest.method,
            url: new URL(prepared.clientRequest.url),
            headers: { ...prepared.clientRequest.headers },
          },
        ),
      catch: (cause) =>
        new Error("RFC 9421 oracle rejected the request", { cause }),
    });
    return verified === true;
  });

const withServerRequest = (
  prepared: PreparedRequest,
  serverRequest: HttpServerRequest.HttpServerRequest,
): PreparedRequest => ({ ...prepared, serverRequest });

const changeSignature = (value: string): string => {
  const firstByteIndex = value.indexOf(":") + 1;
  if (firstByteIndex <= 0 || firstByteIndex >= value.length) {
    return `${value}:changed`;
  }
  const current = value[firstByteIndex];
  const replacement = current === "A" ? "B" : "A";
  return (
    value.slice(0, firstByteIndex) +
    replacement +
    value.slice(firstByteIndex + 1)
  );
};

const universalSignatureHeader = (): string => {
  const signature = new Uint8Array(64);
  signature[0] = 1;
  return `moltzap=:${Buffer.from(signature).toString("base64")}:`;
};

const signatureMutations = (
  prepared: PreparedRequest,
  headers: Headers.Headers,
): readonly RequestMutation[] => [
  {
    name: "signature bytes",
    prepared: withServerRequest(
      prepared,
      prepared.serverRequest.modify({
        headers: {
          ...headers,
          signature: changeSignature(headers.signature ?? ""),
        },
      }),
    ),
  },
  {
    name: "identity-point signature",
    prepared: withServerRequest(
      prepared,
      prepared.serverRequest.modify({
        headers: {
          ...headers,
          signature: universalSignatureHeader(),
        },
      }),
    ),
  },
];

const withSignatureInput = (
  prepared: PreparedRequest,
  signatureInput: string,
): PreparedRequest =>
  withServerRequest(
    prepared,
    prepared.serverRequest.modify({
      headers: {
        ...prepared.serverRequest.headers,
        "signature-input": signatureInput,
      },
    }),
  );

const withSignature = (
  prepared: PreparedRequest,
  signature: string,
): PreparedRequest =>
  withServerRequest(
    prepared,
    prepared.serverRequest.modify({
      headers: {
        ...prepared.serverRequest.headers,
        signature,
      },
    }),
  );

const requiredHeader = (headers: Headers.Headers, name: string): string => {
  const value = headers[name];
  if (value === undefined) {
    throw new Error(`signed request is missing ${name}`);
  }
  return value;
};

const signatureExpiry = (prepared: PreparedRequest): number => {
  const signatureInput = requiredHeader(
    prepared.serverRequest.headers,
    "signature-input",
  );
  const match = /;expires=(\d+)/u.exec(signatureInput);
  const encodedExpiry = match?.[1];
  if (encodedExpiry === undefined) {
    throw new Error("signed request is missing its expiry");
  }
  const expiry = Schema.NumberFromString.pipe(
    Schema.int(),
    Schema.nonNegative(),
  );
  return Schema.decodeUnknownSync(expiry)(encodedExpiry);
};

const structuredFieldDuplicateMutations = (
  prepared: PreparedRequest,
): readonly RequestMutation[] => {
  const headers = prepared.serverRequest.headers;
  const signatureInput = requiredHeader(headers, "signature-input");
  const signature = requiredHeader(headers, "signature");
  return [
    {
      name: "created parameter",
      prepared: withSignatureInput(
        prepared,
        signatureInput.replace(";created=", ";created=0;created="),
      ),
    },
    {
      name: "nonce parameter",
      prepared: withSignatureInput(
        prepared,
        signatureInput.replace(
          ";nonce=",
          ';nonce="AAAAAAAAAAAAAAAAAAAAAA";nonce=',
        ),
      ),
    },
    {
      name: "Signature-Input moltzap label",
      prepared: withSignatureInput(
        prepared,
        `moltzap=("@method");created=0, ${signatureInput}`,
      ),
    },
    {
      name: "Signature moltzap label",
      prepared: withSignature(
        prepared,
        `${universalSignatureHeader()}, ${signature}`,
      ),
    },
  ];
};

const coveredMutations = (
  prepared: PreparedRequest,
): ReadonlyArray<
  Readonly<{
    name: string;
    prepared: PreparedRequest;
  }>
> => {
  const headers = prepared.serverRequest.headers;
  return [
    {
      name: "covered path",
      prepared: withServerRequest(
        prepared,
        prepared.serverRequest.modify({
          url: "/v1/messages:changed?view=current",
        }),
      ),
    },
    {
      name: "content digest",
      prepared: withServerRequest(
        prepared,
        prepared.serverRequest.modify({
          headers: {
            ...headers,
            "content-digest": contentDigest(Uint8Array.from([9])),
          },
        }),
      ),
    },
    ...signatureMutations(prepared, headers),
  ];
};

const assertCoveredMutationRejected = (
  mutation: RequestMutation,
  fixture: IdentityFixture,
) =>
  Effect.gen(function* () {
    const result = yield* verifySignature(mutation.prepared, fixture).pipe(
      Effect.either,
    );
    const rejected = Either.match(result, {
      onLeft: () => true,
      onRight: () => false,
    });
    expect(rejected, mutation.name).toBe(true);
  });

const assertAuthenticationMutationRejected = (mutation: RequestMutation) =>
  Effect.gen(function* () {
    const failure = yield* verifyAgentRequest(mutation.prepared).pipe(
      Effect.flip,
    );
    expect(failure, mutation.name).toStrictEqual(
      new AuthenticationFailedError(),
    );
  });

const signStandardBytes = (
  authority: AgentSigningAuthorityValue,
  bytes: Buffer,
) =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        webcrypto.subtle.sign(
          "Ed25519",
          agentSigningPrivateKey(authority),
          Uint8Array.from(bytes),
        ),
      catch: (cause) =>
        new Error("could not sign RFC 9421 test request", { cause }),
    }).pipe(Effect.map((signature) => Buffer.from(signature))),
  );

const makeSignatureParameters = (fixture: IdentityFixture) =>
  Effect.gen(function* () {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000) * 1_000;
    const keyid = yield* ed25519PublicKeyThumbprintUri(
      AgentSigningAuthority.publicKey(fixture.signingAuthority),
    );
    const nonce = yield* Effect.try({
      try: () => randomBytes(16).toString("base64url"),
      catch: (cause) =>
        new Error("could not create RFC 9421 test nonce", { cause }),
    });
    return {
      created: new Date(now),
      expires: new Date(now + SIGNATURE_INTERVAL_MILLISECONDS),
      keyid,
      nonce,
    } satisfies TestSignatureParameters;
  });

const signVersionedRequest = (
  request: HttpClientRequest.HttpClientRequest,
  fixture: IdentityFixture,
  parameters: TestSignatureParameters,
) =>
  Effect.tryPromise({
    try: () =>
      httpbis.signMessage(
        {
          name: "moltzap",
          fields: [...NORMAL_FIELDS],
          params: [...SIGNATURE_PARAMETERS],
          paramValues: {
            ...parameters,
            alg: "ed25519",
            tag: "moltzap-request-v1",
          },
          key: {
            id: parameters.keyid,
            alg: "ed25519",
            sign: (bytes) => signStandardBytes(fixture.signingAuthority, bytes),
          },
        },
        {
          method: request.method,
          url: request.url,
          headers: { ...request.headers },
        },
      ),
    catch: (cause) =>
      new Error("could not re-sign version test request", { cause }),
  });

const resignWithVersion = (
  prepared: PreparedRequest,
  fixture: IdentityFixture,
  version: string,
) =>
  Effect.gen(function* () {
    const unsignedHeaders = Headers.remove(prepared.clientRequest.headers, [
      "signature",
      "signature-input",
    ]);
    const request = HttpClientRequest.post(prepared.clientRequest.url, {
      body: prepared.clientRequest.body,
      headers: unsignedHeaders,
    }).pipe(HttpClientRequest.setHeader("moltzap-version", version));
    const parameters = yield* makeSignatureParameters(fixture);
    const signed = yield* signVersionedRequest(request, fixture, parameters);
    const clientRequest = request.pipe(
      HttpClientRequest.setHeader(
        "signature-input",
        String(signed.headers["Signature-Input"]),
      ),
      HttpClientRequest.setHeader(
        "signature",
        String(signed.headers.Signature),
      ),
    );
    return {
      bodyBytes: prepared.bodyBytes,
      clientRequest,
      serverRequest: toServerRequest(clientRequest),
    } satisfies PreparedRequest;
  });

it("produces an RFC 9421 proof and rejects covered-field mutations", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const controller = yield* makeLookupController({
        kind: "found",
        agentCard: fixture.agentCard,
      });
      yield* releaseLookups(controller);
      const encodedRequest = Object.freeze({ pollCursor: "cursor" });
      const prepared = yield* prepareRequest({
        fixture,
        encodedRequest,
      });

      expect(yield* oracleVerifies(prepared, fixture)).toBe(true);
      yield* verifySignature(prepared, fixture);
      yield* Effect.forEach(
        coveredMutations(prepared),
        (mutation) => assertCoveredMutationRejected(mutation, fixture),
        { concurrency: 1, discard: true },
      );

      const proof = yield* verifyAgentRequest(prepared).pipe(
        Effect.provide(authenticatedHttpLayer(controller)),
      );
      expect(new Set(Reflect.ownKeys(proof).map(String))).toStrictEqual(
        new Set(VERIFIED_PROOF_FIELDS),
      );
      expect(Object.isFrozen(proof)).toBe(true);
      expect(proof.callerAgentId).toBe(fixture.agentCard.agentId);
      expect(proof.agentCard).toBe(fixture.agentCard);
      expect(proof.request).toEqual(encodedRequest);
    }),
  ));

it("rejects duplicate structured signature members without claiming the nonce", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const controller = yield* makeLookupController({
        kind: "found",
        agentCard: fixture.agentCard,
      });
      yield* releaseLookups(controller);
      const prepared = yield* prepareRequest({ fixture });
      const verifyDuplicates = Effect.gen(function* () {
        yield* Effect.forEach(
          structuredFieldDuplicateMutations(prepared),
          assertAuthenticationMutationRejected,
          { concurrency: 1, discard: true },
        );
        return yield* verifyAgentRequest(prepared);
      });
      const proof = yield* verifyDuplicates.pipe(
        Effect.provide(authenticatedHttpLayer(controller)),
      );
      expect(proof.callerAgentId).toBe(fixture.agentCard.agentId);
    }),
  ));

it("claims a valid wrong-version nonce before returning version mismatch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const controller = yield* makeLookupController({
        kind: "found",
        agentCard: fixture.agentCard,
      });
      yield* releaseLookups(controller);
      const prepared = yield* prepareRequest({ fixture });
      const wrongVersion = yield* resignWithVersion(
        prepared,
        fixture,
        WRONG_VERSION,
      );
      const verifyTwice = Effect.gen(function* () {
        const first = yield* verifyAgentRequest(wrongVersion).pipe(Effect.flip);
        expect(first).toBeInstanceOf(VersionMismatchError);
        const replay = yield* verifyAgentRequest(wrongVersion).pipe(
          Effect.flip,
        );
        expect(replay).toBeInstanceOf(AuthenticationFailedError);
      });
      yield* verifyTwice.pipe(
        Effect.provide(authenticatedHttpLayer(controller)),
      );
    }),
  ));

it("retains a replay claim when concurrent verification completes at expiry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const controller = yield* makeLookupController({
        kind: "found",
        agentCard: fixture.agentCard,
      });
      yield* releaseLookups(controller);
      const prepared = yield* prepareRequest({ fixture });
      const boundaryClock = yield* makeExpiryBoundaryClock(
        signatureExpiry(prepared),
      );
      const attempts = Effect.all(
        [
          verifyAgentRequest(prepared).pipe(Effect.either),
          verifyAgentRequest(prepared).pipe(Effect.either),
        ] as const,
        { concurrency: 2 },
      ).pipe(
        Effect.provide(authenticatedHttpLayer(controller)),
        Effect.withClock(boundaryClock.clock),
      );
      const fiber = yield* Effect.fork(attempts);
      yield* Deferred.await(boundaryClock.sampled);
      yield* Deferred.succeed(boundaryClock.release, undefined);
      const outcomes = yield* Fiber.join(fiber);
      const outcomeKinds = outcomes.map(
        Either.match({
          onLeft: (failure) => failure._tag,
          onRight: () => "accepted",
        }),
      );
      expect(outcomeKinds.filter((kind) => kind === "accepted")).toHaveLength(
        1,
      );
      expect(
        outcomeKinds.filter((kind) => kind === AUTHENTICATION_FAILED_TAG),
      ).toHaveLength(1);
    }),
  ));

const prepareResolverRequests = (fixture: IdentityFixture) =>
  Effect.gen(function* () {
    const concurrent = yield* Effect.all(
      Array.from({ length: CONCURRENT_REQUEST_COUNT }, () =>
        prepareRequest({ fixture }),
      ),
      { concurrency: CONCURRENT_REQUEST_COUNT },
    );
    const cached = yield* prepareRequest({ fixture });
    const unseenDuringOutage = yield* prepareRequest({
      fixture,
      callerAgentId: makeAgentId(20),
    });
    const unseenAfterRefusal = yield* Effect.all(
      [
        prepareRequest({
          fixture,
          callerAgentId: makeAgentId(21),
        }),
        prepareRequest({
          fixture,
          callerAgentId: makeAgentId(21),
        }),
      ] as const,
      { concurrency: 2 },
    );
    return {
      cached,
      concurrent,
      unseenAfterRefusal,
      unseenDuringOutage,
    } satisfies ResolverRequests;
  });

const assertInitialSingleFlight = (
  controller: LookupController,
  requests: readonly PreparedRequest[],
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(
      Effect.forEach(requests, verifyAgentRequest, {
        concurrency: CONCURRENT_REQUEST_COUNT,
      }),
    );
    yield* Deferred.await(controller.started);
    yield* Effect.yieldNow();
    yield* releaseLookups(controller);
    expect(yield* Fiber.join(fiber)).toHaveLength(requests.length);
    expect(yield* Ref.get(controller.count)).toBe(1);
  });

const assertCacheAndFailureBehavior = (
  controller: LookupController,
  requests: ResolverRequests,
) =>
  Effect.gen(function* () {
    yield* Ref.set(controller.mode, { kind: "unavailable" });
    yield* verifyAgentRequest(requests.cached);
    expect(yield* Ref.get(controller.count)).toBe(1);
    const unavailable = yield* verifyAgentRequest(
      requests.unseenDuringOutage,
    ).pipe(Effect.flip);
    expect(unavailable).toStrictEqual(new UnavailableError());

    yield* Ref.set(controller.mode, { kind: "not_found" });
    const countBeforeRefusals = yield* Ref.get(controller.count);
    for (const request of requests.unseenAfterRefusal) {
      const refused = yield* verifyAgentRequest(request).pipe(Effect.flip);
      expect(refused).toStrictEqual(new AuthenticationFailedError());
    }
    expect(yield* Ref.get(controller.count)).toBe(
      countBeforeRefusals + requests.unseenAfterRefusal.length,
    );
  });

const assertResolverBehavior = (
  controller: LookupController,
  requests: ResolverRequests,
) =>
  Effect.gen(function* () {
    yield* assertInitialSingleFlight(controller, requests.concurrent);
    yield* assertCacheAndFailureBehavior(controller, requests);
  });

const assertLookupDeadlineBehavior = (
  controller: LookupController,
  requests: readonly [PreparedRequest, PreparedRequest, PreparedRequest],
) =>
  Effect.gen(function* () {
    const leadingFiber = yield* Effect.fork(
      verifyAgentRequest(requests[0]).pipe(Effect.flip),
    );
    yield* Deferred.await(controller.started);
    const joiningFiber = yield* Effect.fork(
      verifyAgentRequest(requests[1]).pipe(Effect.flip),
    );
    yield* Effect.yieldNow();
    yield* releaseLookups(controller);

    const [leadingFailure, joiningFailure] = yield* Effect.all(
      [Fiber.join(leadingFiber), Fiber.join(joiningFiber)] as const,
      { concurrency: 2 },
    );
    expect(leadingFailure).toStrictEqual(new UnavailableError());
    expect(joiningFailure).toStrictEqual(new UnavailableError());
    expect(yield* Ref.get(controller.count)).toBe(1);

    const laterFailure = yield* verifyAgentRequest(requests[2]).pipe(
      Effect.flip,
    );
    expect(laterFailure).toStrictEqual(new UnavailableError());
    expect(yield* Ref.get(controller.count)).toBe(2);
  });

it("single-flights positive resolution without caching failures", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const controller = yield* makeLookupController({
        kind: "found",
        agentCard: fixture.agentCard,
      });
      const requests = yield* prepareResolverRequests(fixture);
      yield* assertResolverBehavior(controller, requests).pipe(
        Effect.provide(authenticatedHttpLayer(controller)),
      );
    }),
  ));

it("propagates Registry lookup deadlines and releases resolver state", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const controller = yield* makeLookupController({
        kind: "unavailable",
      });
      const requests = yield* Effect.all(
        [
          prepareRequest({ fixture }),
          prepareRequest({ fixture }),
          prepareRequest({ fixture }),
        ] as const,
        { concurrency: 3 },
      );
      yield* assertLookupDeadlineBehavior(controller, requests).pipe(
        Effect.provide(
          authenticatedHttpLayerWithRegistry(
            deadlineRegistryService(controller),
            1,
          ),
        ),
        Effect.timeoutFail({
          duration: RESOLVER_REGRESSION_DEADLINE,
          onTimeout: () => new Error("Registry lookup deadline did not settle"),
        }),
      );
    }),
  ));

it("keeps a shared card lookup alive when its first waiter is interrupted", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* makeIdentityFixture;
      const controller = yield* makeLookupController({
        kind: "found",
        agentCard: fixture.agentCard,
      });
      const [leadingRequest, joiningRequest, cachedRequest] = yield* Effect.all(
        [
          prepareRequest({ fixture }),
          prepareRequest({ fixture }),
          prepareRequest({ fixture }),
        ] as const,
        { concurrency: 3 },
      );
      const verifyCancellationBehavior = Effect.gen(function* () {
        const leadingFiber = yield* Effect.fork(
          verifyAgentRequest(leadingRequest),
        );
        yield* Deferred.await(controller.started);
        const joiningFiber = yield* Effect.fork(
          verifyAgentRequest(joiningRequest),
        );
        yield* Effect.yieldNow();

        yield* Fiber.interrupt(leadingFiber);
        yield* releaseLookups(controller);

        const joined = yield* Fiber.join(joiningFiber);
        expect(joined.agentCard).toBe(fixture.agentCard);
        const cached = yield* verifyAgentRequest(cachedRequest);
        expect(cached.agentCard).toBe(fixture.agentCard);
        expect(yield* Ref.get(controller.count)).toBe(1);
      });
      yield* verifyCancellationBehavior.pipe(
        Effect.provide(authenticatedHttpLayer(controller)),
      );
    }),
  ));

/* eslint-enable agent-code-guard/no-example-only-tests -- Restore strict defaults after the scoped file-level exception. */
