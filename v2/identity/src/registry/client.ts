import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform";
import { Duration, Effect, Either, Encoding, Redacted, Schema } from "effect";
import { AgentCard, type VerifiedAgentCard } from "../agent-card.js";
import { AgentSigningAuthority, type Ed25519PublicKey } from "../agent-key.js";
import {
  AuthenticationFailedError,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
  type HttpEnvelopeError,
} from "../http-errors.js";
import { AgentSigningError, signHttpRequest } from "../http-signature.js";
import { decodeCanonicalJson, encodeCanonicalJson } from "../canonical-json.js";
import type { AgentId } from "../identifiers.js";
import { MOLTZAP_VERSION } from "../version.js";
import {
  LIST_PATH,
  listResponseSchema,
  LOOKUP_PATH,
  lookupResponseSchema,
  registrationBody,
  REGISTER_PATH,
  RegistryConnectionError,
  RegistryInvalidResponseError,
  RegistryListRequest,
  type RegistryListResult,
  RegistryLookupRequest,
  type RegistryLookupResult,
  type RegistryRegisterResult,
  RegistryRequestTimeoutError,
  registerResponseSchema,
  type RegistryClientService,
  type RegistryPublicReadError,
  type RegistryRegisterCall,
} from "./contract.js";

/**
 * Builds the service installed behind the public Registry capability.
 *
 * @param input Immutable Registry client configuration.
 * @param input.origin Registry HTTP origin.
 * @param input.registrySignerPublicKey Pinned Registry verification key.
 * @param input.requestTimeout Complete per-call deadline.
 * @returns The configured service, requiring an Effect HTTP client.
 */
export function makeRegistryService(input: {
  readonly origin: URL;
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly requestTimeout: Duration.Duration;
}): Effect.Effect<RegistryClientService, never, HttpClient.HttpClient> {
  const origin = new URL(input.origin.href);
  const requestTimeout = Duration.millis(
    Duration.toMillis(input.requestTimeout),
  );
  return Effect.map(
    HttpClient.HttpClient,
    (client): RegistryClientService => ({
      register: makeRegister({
        client,
        origin,
        registrySignerPublicKey: input.registrySignerPublicKey,
        requestTimeout,
      }),
      lookup: makeLookup({
        client,
        origin,
        registrySignerPublicKey: input.registrySignerPublicKey,
        requestTimeout,
      }),
      list: makeList({
        client,
        origin,
        registrySignerPublicKey: input.registrySignerPublicKey,
        requestTimeout,
      }),
    }),
  );
}

type ErrorEnvelope = Readonly<{
  body: string;
  make: () => HttpEnvelopeError;
}>;

const errorEnvelope = new Map<number, ErrorEnvelope>([
  [
    400,
    { body: '{"error":"malformed"}', make: () => new MalformedRequestError() },
  ],
  [
    401,
    {
      body: '{"error":"authentication_failed"}',
      make: () => new AuthenticationFailedError(),
    },
  ],
  [
    404,
    { body: '{"error":"not_found"}', make: () => new RouteNotFoundError() },
  ],
  [
    405,
    {
      body: '{"error":"method_not_allowed"}',
      make: () => new MethodNotAllowedError(),
    },
  ],
  [
    412,
    {
      body: '{"error":"version_mismatch"}',
      make: () => new VersionMismatchError(),
    },
  ],
  [
    413,
    {
      body: '{"error":"payload_too_large"}',
      make: () => new PayloadTooLargeError(),
    },
  ],
  [
    415,
    {
      body: '{"error":"unsupported_media_type"}',
      make: () => new UnsupportedMediaTypeError(),
    },
  ],
  [429, { body: '{"error":"overloaded"}', make: () => new OverloadedError() }],
  [
    503,
    { body: '{"error":"unavailable"}', make: () => new UnavailableError() },
  ],
  [
    500,
    { body: '{"error":"internal"}', make: () => new InternalServerError() },
  ],
]);

const invalidResponse = (): RegistryInvalidResponseError =>
  new RegistryInvalidResponseError();

const textDecoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

const exactText = (bytes: Uint8Array): string | undefined => {
  try {
    return textDecoder.decode(bytes);
    // eslint-disable-next-line agent-code-guard/bare-catch -- Invalid UTF-8 is an ordinary closed-response validation failure.
  } catch {
    return undefined;
  }
};

type ClientOperation = "register" | "lookup" | "list";
type RegistryClientInput = Readonly<{
  client: HttpClient.HttpClient;
  origin: URL;
  registrySignerPublicKey: Ed25519PublicKey;
  requestTimeout: Duration.Duration;
}>;

const operationDeclares = (
  operation: ClientOperation,
  error: HttpEnvelopeError,
): boolean =>
  operation === "register" || error._tag !== "AuthenticationFailedError";

const connectionFailure = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, RegistryConnectionError, R> =>
  effect.pipe(
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- The client exposes one transport failure without leaking platform implementation details.
    Effect.mapError(() => new RegistryConnectionError()),
  );

const readResponseBytes = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Uint8Array, RegistryConnectionError> =>
  connectionFailure(response.arrayBuffer).pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
  );

const decodeEnvelope = (
  operation: ClientOperation,
  response: HttpClientResponse.HttpClientResponse,
  bytes: Uint8Array,
): Effect.Effect<never, HttpEnvelopeError | RegistryInvalidResponseError> => {
  if (response.headers["content-type"] !== "application/json") {
    return Effect.fail(invalidResponse());
  }
  const expected = errorEnvelope.get(response.status);
  const actual = exactText(bytes);
  if (expected === undefined || actual !== expected.body) {
    return Effect.fail(invalidResponse());
  }
  const error = expected.make();
  return operationDeclares(operation, error)
    ? Effect.fail(error)
    : Effect.fail(invalidResponse());
};

const execute = (input: {
  readonly client: HttpClient.HttpClient;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly operation: ClientOperation;
}): Effect.Effect<
  readonly [HttpClientResponse.HttpClientResponse, Uint8Array],
  RegistryConnectionError | HttpEnvelopeError | RegistryInvalidResponseError
> =>
  connectionFailure(input.client.execute(input.request)).pipe(
    Effect.flatMap((response) =>
      readResponseBytes(response).pipe(
        Effect.flatMap((bytes) =>
          response.status === 200
            ? Effect.succeed([response, bytes] as const)
            : decodeEnvelope(input.operation, response, bytes),
        ),
      ),
    ),
  );

const executePublicRead = (input: {
  readonly client: HttpClient.HttpClient;
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly operation: "lookup" | "list";
}) =>
  execute(input).pipe(
    Effect.catchTag("AuthenticationFailedError", () =>
      Effect.fail(invalidResponse()),
    ),
  );

const requireJsonSuccess = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<void, RegistryInvalidResponseError> =>
  response.headers["content-type"] === "application/json"
    ? Effect.void
    : Effect.fail(invalidResponse());

const encodeRequest = <A, I>(
  schema: Schema.Schema<A, I>,
  request: A,
): Effect.Effect<Uint8Array, RegistryInvalidResponseError> =>
  Schema.encode(schema)(request).pipe(
    Effect.mapError(invalidResponse),
    Effect.flatMap(encodeCanonicalJson),
    Effect.mapError(invalidResponse),
  );

const verifyCard = (
  agentCard: AgentCard,
  registrySignerPublicKey: Ed25519PublicKey,
): Effect.Effect<VerifiedAgentCard, RegistryInvalidResponseError> =>
  AgentCard.verify({ agentCard, registrySignerPublicKey }).pipe(
    Effect.mapError(invalidResponse),
  );

const decodeAgentIdBytes = (agentId: AgentId): Uint8Array =>
  Either.match(Encoding.decodeBase64Url(agentId.slice(4)), {
    // The AgentId type already proves this branch unreachable.
    onLeft: () => new Uint8Array(),
    onRight: (bytes) => bytes,
  });

const compareAgentIds = (left: AgentId, right: AgentId): number => {
  const leftBytes = decodeAgentIdBytes(left);
  const rightBytes = decodeAgentIdBytes(right);
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const withDeadline = <A, E>(
  effect: Effect.Effect<A, E>,
  timeout: Duration.Duration,
): Effect.Effect<A, E | RegistryRequestTimeoutError> =>
  effect.pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () => new RegistryRequestTimeoutError(),
    }),
  );

const makePost = (
  origin: URL,
  path: string,
  bodyBytes: Uint8Array,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.post(new URL(path, origin)).pipe(
    HttpClientRequest.bodyUint8Array(bodyBytes, "application/json"),
    HttpClientRequest.setHeader("moltzap-version", MOLTZAP_VERSION),
  );

const makeSignedRegistrationRequest = (
  input: RegistryClientInput,
  call: RegistryRegisterCall,
) =>
  Effect.gen(function* () {
    if (
      AgentSigningAuthority.publicKey(call.signingAuthority).x !==
      call.request.publicKey.x
    ) {
      return yield* new AgentSigningError();
    }
    const bodyBytes = yield* encodeRequest(registrationBody, {
      request: call.request,
    });
    const httpRequest = makePost(input.origin, REGISTER_PATH, bodyBytes).pipe(
      HttpClientRequest.setHeader(
        "authorization",
        `MoltZap-Admission ${Redacted.value(call.admissionCredential)}`,
      ),
    );
    return yield* signHttpRequest({
      httpRequest,
      bodyBytes,
      signingAuthority: call.signingAuthority,
      profile: "registration",
    });
  });

const registrationMatchesCall = (
  agentCard: VerifiedAgentCard,
  call: RegistryRegisterCall,
): boolean =>
  agentCard.principalId === call.request.principalId &&
  agentCard.agentName === call.request.agentName &&
  agentCard.publicKey.x === call.request.publicKey.x;

const decodeRegistrationResult = (
  input: RegistryClientInput,
  call: RegistryRegisterCall,
  responseBytes: Uint8Array,
): Effect.Effect<RegistryRegisterResult, RegistryInvalidResponseError> =>
  Effect.gen(function* () {
    const result = yield* decodeCanonicalJson(
      registerResponseSchema,
      responseBytes,
    ).pipe(Effect.mapError(invalidResponse));
    if (result.kind !== "registered") {
      return Object.freeze({ kind: result.kind });
    }
    const agentCard = yield* verifyCard(
      result.agentCard,
      input.registrySignerPublicKey,
    );
    if (!registrationMatchesCall(agentCard, call)) {
      return yield* invalidResponse();
    }
    return Object.freeze({ kind: "registered", agentCard });
  });

function makeRegister(
  input: RegistryClientInput,
): (
  call: RegistryRegisterCall,
) => Effect.Effect<
  RegistryRegisterResult,
  | HttpEnvelopeError
  | RegistryConnectionError
  | RegistryRequestTimeoutError
  | RegistryInvalidResponseError
  | AgentSigningError
> {
  return (call) =>
    Effect.gen(function* () {
      const request = yield* makeSignedRegistrationRequest(input, call);
      const [response, responseBytes] = yield* execute({
        client: input.client,
        request,
        operation: "register",
      });
      yield* requireJsonSuccess(response);
      return yield* decodeRegistrationResult(input, call, responseBytes);
    }).pipe((effect) => withDeadline(effect, input.requestTimeout));
}

function makeLookup(
  input: RegistryClientInput,
): (
  call: typeof RegistryLookupRequest.Type,
) => Effect.Effect<
  RegistryLookupResult,
  | RegistryPublicReadError
  | RegistryConnectionError
  | RegistryRequestTimeoutError
  | RegistryInvalidResponseError
> {
  return (call) =>
    Effect.gen(function* () {
      const bodyBytes = yield* encodeRequest(RegistryLookupRequest, call);
      const [response, responseBytes] = yield* executePublicRead({
        client: input.client,
        request: makePost(input.origin, LOOKUP_PATH, bodyBytes),
        operation: "lookup",
      });
      yield* requireJsonSuccess(response);
      const result = yield* decodeCanonicalJson(
        lookupResponseSchema,
        responseBytes,
      ).pipe(Effect.mapError(invalidResponse));
      if (result.kind === "not_found") {
        return Object.freeze({ kind: "not_found" });
      }
      const agentCard = yield* verifyCard(
        result.agentCard,
        input.registrySignerPublicKey,
      );
      if (
        ("agentId" in call && agentCard.agentId !== call.agentId) ||
        ("agentName" in call && agentCard.agentName !== call.agentName)
      ) {
        return yield* invalidResponse();
      }
      return Object.freeze({ kind: "found", agentCard });
    }).pipe((effect) => withDeadline(effect, input.requestTimeout));
}

function makeList(
  input: RegistryClientInput,
): (
  call: typeof RegistryListRequest.Type,
) => Effect.Effect<
  RegistryListResult,
  | RegistryPublicReadError
  | RegistryConnectionError
  | RegistryRequestTimeoutError
  | RegistryInvalidResponseError
> {
  return (call) =>
    Effect.gen(function* () {
      const bodyBytes = yield* encodeRequest(RegistryListRequest, call);
      const [response, responseBytes] = yield* executePublicRead({
        client: input.client,
        request: makePost(input.origin, LIST_PATH, bodyBytes),
        operation: "list",
      });
      yield* requireJsonSuccess(response);
      const result = yield* decodeCanonicalJson(
        listResponseSchema,
        responseBytes,
      ).pipe(Effect.mapError(invalidResponse));
      const agentCards = yield* Effect.forEach(
        result.agentCards,
        (card) => verifyCard(card, input.registrySignerPublicKey),
        { concurrency: 1 },
      );
      let previous = call.afterAgentId;
      for (const card of agentCards) {
        if (
          previous !== undefined &&
          compareAgentIds(previous, card.agentId) >= 0
        ) {
          return yield* invalidResponse();
        }
        previous = card.agentId;
      }
      return Object.freeze({
        kind: "page",
        agentCards: Object.freeze([...agentCards]),
        hasMore: result.hasMore,
      });
    }).pipe((effect) => withDeadline(effect, input.requestTimeout));
}
