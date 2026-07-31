import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "@effect/platform";
import {
  AgentId,
  AgentName,
  AgentSigningAuthority,
  PrincipalId,
} from "../../index.js";
import {
  OperationId,
  Registry,
  RegistryRegisterRequest,
} from "../../registry.js";
import { AgentCardIssuedAt, issueAgentCard } from "../../agent-card.js";
import { encodeCanonicalJson } from "../../canonical-json.js";
import { UnavailableError } from "../../http-errors.js";
import { loadRegistryConfiguration } from "../configuration.js";
import { lookupResponseSchema, registerResponseSchema } from "../contract.js";
import {
  makeRegistryRpcClient,
  makeRegistryRpcHandlersLayer,
  registryAdmissionLayer,
  withBootstrapAdmission,
} from "../rpc.js";
import { layer as registryServerLayer, StartupError } from "../server.js";
import type { RegistryStorage } from "../storage.js";
import { generateKeyPairSync } from "node:crypto";
import {
  ConfigProvider,
  Duration,
  Effect,
  Either,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";

const CONFIGURATION_PHASE = "configuration";
const AUTHENTICATION_FAILED_TAG = "AuthenticationFailedError";
const UNAVAILABLE_TAG = "UnavailableError";
const NAME_TAKEN_KIND = "name_taken";
const NOT_FOUND_KIND = "not_found";
const PAGE_KIND = "page";
const FOUND_KIND = "found";
const INVALID_RESPONSE_TAG = "RegistryInvalidResponseError";
const CONNECTION_ERROR_TAG = "RegistryConnectionError";
const TIMEOUT_ERROR_TAG = "RegistryRequestTimeoutError";
const SIGNING_ERROR_TAG = "AgentSigningError";
const CLIENT_ORIGIN = new URL("http://registry.example:3011");
const CLIENT_TIMEOUT = Duration.seconds(5);
const SHORT_CLIENT_TIMEOUT = Duration.millis(5);

const requiredConfiguration = new Map([
  ["MOLTZAP_REGISTRY_PORT", "4317"],
  [
    "MOLTZAP_REGISTRY_POSTGRESQL_URL",
    "postgresql://registry:secret@127.0.0.1:5432/registry?sslmode=disable",
  ],
  ["MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL", "admission-token="],
  [
    "MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH",
    "/run/secrets/registry-key.pem",
  ],
]);
const noConfigurationOverrides = new Map<string, string>();

const loadConfiguration = (
  overrides: ReadonlyMap<string, string> = noConfigurationOverrides,
) =>
  loadRegistryConfiguration.pipe(
    Effect.withConfigProvider(
      ConfigProvider.fromMap(
        new Map([
          ...requiredConfiguration,
          ["UNRELATED_DEPLOYMENT_VALUE", "ignored"],
          ...overrides,
        ]),
      ),
    ),
  );

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

const invalidConfigurationOverrides = [
  new Map([["MOLTZAP_REGISTRY_PORT", "0"]]),
  new Map([["MOLTZAP_REGISTRY_PORT", "01"]]),
  new Map([["MOLTZAP_REGISTRY_PORT", "65536"]]),
  // eslint-disable-next-line sonarjs/no-clear-text-protocols -- The configuration boundary must reject this intentionally wrong scheme.
  new Map([["MOLTZAP_REGISTRY_POSTGRESQL_URL", "http://db/registry"]]),
  new Map([["MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL", "short"]]),
  new Map([["MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL", "invalid!token"]]),
  new Map([["MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH", "relative.pem"]]),
  new Map([["MOLTZAP_REGISTRY_LIST_PAGE_SIZE", "0"]]),
  new Map([["MOLTZAP_REGISTRY_REQUEST_CONCURRENCY_LIMIT", "+2"]]),
  new Map([["MOLTZAP_REGISTRY_LIVE_NONCE_CAPACITY", "1.5"]]),
  new Map([["MOLTZAP_REGISTRY_SQL_POOL_SIZE", "0"]]),
  new Map([["MOLTZAP_REGISTRY_SQL_OPERATION_TIMEOUT_MS", "1e3"]]),
];

const makePrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" });
};

const makeRequest = (name: string) =>
  Schema.decodeUnknownSync(RegistryRegisterRequest)({
    operationId: Schema.decodeUnknownSync(OperationId)(
      "opn_AAAAAAAAAAAAAAAAAAAAAA",
    ),
    principalId: Schema.decodeUnknownSync(PrincipalId)(
      "prn_AAAAAAAAAAAAAAAAAAAAAA",
    ),
    agentName: Schema.decodeUnknownSync(AgentName)(name),
    publicKey: {
      crv: "Ed25519",
      kty: "OKP",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    },
  });

const makeRpcStorage = (calls: Ref.Ref<number>): RegistryStorage => ({
  checkReadiness: () => Effect.void,
  claimRegistrationNonce: () => Effect.succeed("claimed"),
  register: ({ request }) =>
    Ref.updateAndGet(calls, (current) => current + 1).pipe(
      Effect.flatMap(() =>
        request.agentName === "rpc-failure"
          ? Effect.fail(new UnavailableError())
          : Effect.succeed(Object.freeze({ kind: NAME_TAKEN_KIND })),
      ),
    ),
  lookup: () => Effect.succeed(Object.freeze({ kind: NOT_FOUND_KIND })),
  list: () =>
    Effect.succeed(
      Object.freeze({
        kind: PAGE_KIND,
        agentCards: Object.freeze([]),
        hasMore: false,
      }),
    ),
});

const assertDefaultConfiguration = Effect.gen(function* () {
  const configuration = yield* loadConfiguration();
  expect(configuration).toMatchObject({
    host: "127.0.0.1",
    port: 4317,
    listPageSize: 100,
    requestConcurrencyLimit: 256,
    liveNonceCapacity: 10_000,
    sqlPoolSize: 10,
    sqlOperationTimeoutMs: 5_000,
  });
  expect(Redacted.isRedacted(configuration.postgresqlUrl)).toBe(true);
  expect(Redacted.isRedacted(configuration.admissionCredential)).toBe(true);
  expect(Redacted.isRedacted(configuration.signingPrivateKeyPath)).toBe(true);
  expect(Redacted.value(configuration.postgresqlUrl)).toBe(
    requiredConfiguration.get("MOLTZAP_REGISTRY_POSTGRESQL_URL"),
  );

  const overridden = yield* loadConfiguration(
    new Map([
      ["MOLTZAP_REGISTRY_HOST", "::"],
      ["MOLTZAP_REGISTRY_LIST_PAGE_SIZE", "7"],
      ["MOLTZAP_REGISTRY_REQUEST_CONCURRENCY_LIMIT", "8"],
      ["MOLTZAP_REGISTRY_LIVE_NONCE_CAPACITY", "9"],
      ["MOLTZAP_REGISTRY_SQL_POOL_SIZE", "3"],
      ["MOLTZAP_REGISTRY_SQL_OPERATION_TIMEOUT_MS", "250"],
    ]),
  );
  expect(overridden).toMatchObject({
    host: "::",
    listPageSize: 7,
    requestConcurrencyLimit: 8,
    liveNonceCapacity: 9,
    sqlPoolSize: 3,
    sqlOperationTimeoutMs: 250,
  });
});

const assertInvalidConfigurations = Effect.gen(function* () {
  for (const overrides of invalidConfigurationOverrides) {
    expect(yield* effectFails(loadConfiguration(overrides))).toBe(true);
  }
});

const assertTypedStartupFailure = Effect.gen(function* () {
  const provider = ConfigProvider.fromMap(
    new Map([...requiredConfiguration, ["MOLTZAP_REGISTRY_PORT", "0"]]),
  );
  const startupFailure = yield* Layer.build(registryServerLayer).pipe(
    Effect.scoped,
    Effect.flip,
    Effect.withConfigProvider(provider),
  );
  expect(startupFailure).toBeInstanceOf(StartupError);
  expect(startupFailure.phase).toBe(CONFIGURATION_PHASE);
});

const configurationBehavior = Effect.gen(function* () {
  yield* assertDefaultConfiguration;
  yield* assertInvalidConfigurations;
  yield* assertTypedStartupFailure;
});

const failureTag = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const rpcBehavior = Effect.gen(function* () {
  const calls = yield* Ref.make(0);
  const storage = makeRpcStorage(calls);
  const registrySigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(makePrivateKeyPem()),
  );
  const handlers = makeRegistryRpcHandlersLayer({
    storage,
    registrySigningAuthority,
  });
  const client = yield* makeRegistryRpcClient.pipe(
    Effect.provide(handlers),
    Effect.provide(registryAdmissionLayer),
  );

  const unauthenticatedTag = yield* failureTag(
    client.register(makeRequest("rpc-refusal")),
  );
  expect(unauthenticatedTag).toBe(AUTHENTICATION_FAILED_TAG);
  expect(yield* Ref.get(calls)).toBe(0);

  const refusal = yield* withBootstrapAdmission(
    client.register(makeRequest("rpc-refusal")),
  );
  expect(refusal.kind).toBe(NAME_TAKEN_KIND);

  const unavailableTag = yield* failureTag(
    withBootstrapAdmission(client.register(makeRequest("rpc-failure"))),
  );
  expect(unavailableTag).toBe(UNAVAILABLE_TAG);
  expect(yield* Ref.get(calls)).toBe(2);

  const lookup = yield* client.lookup({
    agentName: Schema.decodeUnknownSync(AgentName)("rpc-lookup"),
  });
  expect(lookup.kind).toBe(NOT_FOUND_KIND);
  expect((yield* client.list({})).kind).toBe(PAGE_KIND);
});

const encodeResponse = <A, I>(schema: Schema.Schema<A, I>, value: A) =>
  Schema.encode(schema)(value).pipe(
    Effect.flatMap(encodeCanonicalJson),
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
  );

const responseClient = (
  body: string,
  status = 200,
  contentType = "application/json",
) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status,
          headers: { "content-type": contentType },
        }),
      ),
    ),
  );

const byteResponseClient = (body: Uint8Array, status: number) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(Uint8Array.from(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );

const runLookup = (
  client: HttpClient.HttpClient,
  registrySignerPublicKey: ReturnType<typeof AgentSigningAuthority.publicKey>,
  request: Parameters<typeof Registry.lookup>[0],
  requestTimeout?: Duration.Duration,
) =>
  Registry.lookup(request).pipe(
    Effect.provide(
      Registry.layer({
        origin: CLIENT_ORIGIN,
        registrySignerPublicKey,
        requestTimeout: requestTimeout ?? CLIENT_TIMEOUT,
      }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
    ),
    Effect.either,
  );

const outcomeName = <
  A extends { readonly kind: string },
  E extends {
    readonly _tag: string;
  },
>(
  outcome: Either.Either<A, E>,
): string =>
  Either.match(outcome, {
    onLeft: (error) => error._tag,
    onRight: (result) => result.kind,
  });

const makeClientCard = (
  registrySigningAuthority: AgentSigningAuthority,
  input: {
    readonly agentId: string;
    readonly agentName: string;
    readonly principalId?: string;
    readonly publicKey?: ReturnType<typeof AgentSigningAuthority.publicKey>;
  },
) =>
  issueAgentCard({
    agentId: Schema.decodeUnknownSync(AgentId)(input.agentId),
    principalId: Schema.decodeUnknownSync(PrincipalId)(
      input.principalId ?? "prn_AAAAAAAAAAAAAAAAAAAAAA",
    ),
    agentName: Schema.decodeUnknownSync(AgentName)(input.agentName),
    publicKey: input.publicKey ?? makeRequest(input.agentName).publicKey,
    issuedAt: Schema.decodeUnknownSync(AgentCardIssuedAt)(
      "2026-07-30T00:00:00Z",
    ),
    registrySigningAuthority,
  });

const makeClientFixture = Effect.gen(function* () {
  const registrySigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(makePrivateKeyPem()),
  );
  const wrongRegistrySigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(makePrivateKeyPem()),
  );
  const registrySignerPublicKey = AgentSigningAuthority.publicKey(
    registrySigningAuthority,
  );
  const card = yield* makeClientCard(registrySigningAuthority, {
    agentId: "agt_AAAAAAAAAAAAAAAAAAAAAA",
    agentName: "client-card",
  });
  const wrongSignerCard = yield* makeClientCard(wrongRegistrySigningAuthority, {
    agentId: card.agentId,
    agentName: card.agentName,
  });
  const [foundBody, wrongSignerBody] = yield* Effect.all(
    [
      encodeResponse(lookupResponseSchema, {
        kind: "found",
        agentCard: card,
      }),
      encodeResponse(lookupResponseSchema, {
        kind: "found",
        agentCard: wrongSignerCard,
      }),
    ] as const,
    { concurrency: 2 },
  );
  return {
    card,
    foundBody,
    registrySignerPublicKey,
    registrySigningAuthority,
    wrongSignerBody,
  };
});

type ClientFixture = Effect.Effect.Success<typeof makeClientFixture>;
type LookupScenario = Readonly<{
  name: string;
  client: (fixture: ClientFixture) => HttpClient.HttpClient;
  request: (fixture: ClientFixture) => Parameters<typeof Registry.lookup>[0];
  expected: string;
  timeout?: Duration.Duration;
}>;

const matchingLookup = (fixture: ClientFixture) => ({
  agentName: fixture.card.agentName,
});
const fixedResponse =
  (selectBody: (fixture: ClientFixture) => string, status = 200) =>
  (fixture: ClientFixture) =>
    responseClient(selectBody(fixture), status);
const lookupScenarios: readonly LookupScenario[] = [
  {
    name: "verified response card",
    client: fixedResponse((fixture) => fixture.foundBody),
    request: matchingLookup,
    expected: FOUND_KIND,
  },
  {
    name: "request binding",
    client: fixedResponse((fixture) => fixture.foundBody),
    request: () => ({
      agentName: Schema.decodeUnknownSync(AgentName)("other-card"),
    }),
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "response-card signature",
    client: fixedResponse((fixture) => fixture.wrongSignerBody),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "declared server envelope",
    client: fixedResponse(() => '{"error":"unavailable"}', 503),
    request: matchingLookup,
    expected: UNAVAILABLE_TAG,
  },
  {
    name: "BOM-prefixed server envelope",
    client: () =>
      byteResponseClient(
        Uint8Array.from([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode('{"error":"unavailable"}'),
        ]),
        503,
      ),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "invalid response",
    client: fixedResponse(() => '{ "kind":"not_found" }'),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "public read excludes authentication failures",
    client: fixedResponse(() => '{"error":"authentication_failed"}', 401),
    request: matchingLookup,
    expected: INVALID_RESPONSE_TAG,
  },
  {
    name: "connection failure",
    client: () =>
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.RequestError({
            request,
            reason: "Transport",
          }),
        ),
      ),
    request: matchingLookup,
    expected: CONNECTION_ERROR_TAG,
  },
  {
    name: "complete deadline",
    client: () => HttpClient.make(() => Effect.never),
    request: matchingLookup,
    expected: TIMEOUT_ERROR_TAG,
    timeout: SHORT_CLIENT_TIMEOUT,
  },
];

const assertLookupScenarios = (fixture: ClientFixture) =>
  Effect.forEach(
    lookupScenarios,
    (scenario) =>
      runLookup(
        scenario.client(fixture),
        fixture.registrySignerPublicKey,
        scenario.request(fixture),
        scenario.timeout,
      ).pipe(
        Effect.map((outcome) => {
          expect(outcomeName(outcome), scenario.name).toBe(scenario.expected);
          return outcome;
        }),
      ),
    { concurrency: 1, discard: true },
  );

const assertRegistrationClientBehavior = (fixture: ClientFixture) =>
  Effect.gen(function* () {
    const agentSigningAuthority = yield* AgentSigningAuthority.fromPkcs8(
      Redacted.make(makePrivateKeyPem()),
    );
    const registrationRequest = {
      ...makeRequest("registration-binding"),
      publicKey: AgentSigningAuthority.publicKey(agentSigningAuthority),
    };
    const mismatchedCard = yield* makeClientCard(
      fixture.registrySigningAuthority,
      {
        agentId: "agt_AQAAAAAAAAAAAAAAAAAAAA",
        agentName: "other-registration",
        principalId: registrationRequest.principalId,
        publicKey: registrationRequest.publicKey,
      },
    );
    const mismatchedRegistrationBody = yield* encodeResponse(
      registerResponseSchema,
      { kind: "registered", agentCard: mismatchedCard },
    );
    const registrationLayer = Registry.layer({
      origin: CLIENT_ORIGIN,
      registrySignerPublicKey: fixture.registrySignerPublicKey,
      requestTimeout: CLIENT_TIMEOUT,
    }).pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          responseClient(mismatchedRegistrationBody),
        ),
      ),
    );
    const mismatchedRegistration = yield* Registry.register({
      request: registrationRequest,
      admissionCredential: Redacted.make("admission-token="),
      signingAuthority: agentSigningAuthority,
    }).pipe(Effect.provide(registrationLayer), Effect.either);
    expect(outcomeName(mismatchedRegistration)).toBe(INVALID_RESPONSE_TAG);

    const signingFailure = yield* Registry.register({
      request: makeRequest("signing-failure"),
      admissionCredential: Redacted.make("admission-token="),
      signingAuthority: agentSigningAuthority,
    }).pipe(Effect.provide(registrationLayer), Effect.either);
    expect(outcomeName(signingFailure)).toBe(SIGNING_ERROR_TAG);
  });

const clientBehavior = Effect.gen(function* () {
  const fixture = yield* makeClientFixture;
  yield* assertLookupScenarios(fixture);
  yield* assertRegistrationClientBehavior(fixture);
});

describe("Registry private contracts", () => {
  it("loads exact refined redacted configuration from an isolated provider", () => {
    expect.hasAssertions();
    return Effect.runPromise(configurationBehavior);
  });

  it("enforces private RPC admission and preserves typed channels", () => {
    expect.hasAssertions();
    return Effect.runPromise(rpcBehavior.pipe(Effect.scoped));
  });

  it("classifies public client outcomes without weakening card checks", () => {
    expect.hasAssertions();
    return Effect.runPromise(clientBehavior);
  });
});
