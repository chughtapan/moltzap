/**
 * @file Public Router capability, its authenticated HTTP implementation, and
 * the private process configuration consumed by the Router server.
 */
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform";
import {
  type AgentId,
  type AgentSigningAuthority,
  AgentSigningError,
  AuthenticatedHttp,
  Ed25519PublicKey,
  type Ed25519PublicKey as Ed25519PublicKeyValue,
  SignedMessage,
} from "@moltzap/identity";
import canonicalize from "canonicalize";
import {
  Config,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";
import {
  type RouterClientError,
  RouterConnectionError,
  type RouterHttpEnvelopeError,
  routerHttpErrorFromResponse,
  RouterInvalidResponseError,
  routerJsonContentType,
  routerPollPath,
  RouterPollRequest,
  RouterPollResult,
  RouterRequestTimeoutError,
  routerRepresentationLimits,
  routerSendPath,
  RouterSendRequest,
  RouterSendResult,
} from "./router/contract.js";

interface RouterClientService {
  readonly send: (input: {
    readonly request: RouterSendRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterSendResult, RouterClientError>;
  readonly poll: (input: {
    readonly request: RouterPollRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterPollResult, RouterClientError>;
}

interface RouterClientSettings {
  readonly origin: URL;
  readonly sendTimeout: Duration.Duration;
  readonly pollTimeout: Duration.Duration;
}

/** Opaque message acceptance and endpoint-wide bounded polling. */
export class Router extends Context.Tag("@moltzap/router/Router")<
  Router,
  RouterClientService
>() {
  static readonly send: (input: {
    readonly request: RouterSendRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterSendResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.send);

  static readonly poll: (input: {
    readonly request: RouterPollRequest;
    readonly callerAgentId: AgentId;
    readonly signingAuthority: AgentSigningAuthority;
  }) => Effect.Effect<RouterPollResult, RouterClientError, Router> =
    Effect.serviceFunctionEffect(Router, (service) => service.poll);

  static readonly layer = (input: {
    readonly origin: URL;
    readonly sendTimeout: Duration.Duration;
    readonly pollTimeout: Duration.Duration;
  }): Layer.Layer<Router, never, HttpClient.HttpClient> =>
    Layer.effect(Router, makeRouterClient(input));
}

function makeRouterClient(input: {
  readonly origin: URL;
  readonly sendTimeout: Duration.Duration;
  readonly pollTimeout: Duration.Duration;
}): Effect.Effect<RouterClientService, never, HttpClient.HttpClient> {
  const settings = Object.freeze({
    origin: new URL(input.origin.href),
    sendTimeout: snapshotDuration(input.sendTimeout),
    pollTimeout: snapshotDuration(input.pollTimeout),
  });
  return HttpClient.HttpClient.pipe(
    Effect.map((client) => makeClientService(client, settings)),
    Effect.withSpan("makeRouterClient"),
  );
}

const invalidResponse = () => new RouterInvalidResponseError();
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});
const utf8Encoder = new TextEncoder();

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

const decodeUtf8 = (
  bytes: Uint8Array,
): Effect.Effect<string, RouterInvalidResponseError> =>
  Effect.try({
    try: () => utf8Decoder.decode(bytes),
    catch: invalidResponse,
  });

const decodeCanonicalResult = <A, I>(
  schema: Schema.Schema<A, I>,
  bytes: Uint8Array,
): Effect.Effect<A, RouterInvalidResponseError> =>
  Effect.gen(function* () {
    const text = yield* decodeUtf8(bytes);
    const result = yield* Schema.decodeUnknown(Schema.parseJson(schema))(text, {
      exact: true,
      onExcessProperty: "error",
    }).pipe(Effect.mapError(invalidResponse));
    const encoded = yield* Schema.encode(schema)(result).pipe(
      Effect.mapError(invalidResponse),
    );
    const canonical = canonicalize(encoded);
    if (
      canonical === undefined ||
      !sameBytes(bytes, utf8Encoder.encode(canonical))
    ) {
      return yield* Effect.fail(invalidResponse());
    }
    return result;
  });

const decodeResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  A,
  RouterHttpEnvelopeError | RouterConnectionError | RouterInvalidResponseError
> =>
  Effect.gen(function* () {
    const bytes = yield* response.arrayBuffer.pipe(
      Effect.catchTag("ResponseError", () =>
        Effect.fail(new RouterConnectionError()),
      ),
      Effect.map((buffer) => new Uint8Array(buffer)),
    );
    if (response.headers["content-type"] !== routerJsonContentType) {
      return yield* Effect.fail(invalidResponse());
    }
    if (response.status === 200) {
      return yield* decodeCanonicalResult(schema, bytes);
    }
    const text = yield* decodeUtf8(bytes);
    const recognized = routerHttpErrorFromResponse(response.status, text);
    if (
      Option.isNone(recognized) ||
      !sameBytes(bytes, utf8Encoder.encode(text))
    ) {
      return yield* Effect.fail(invalidResponse());
    }
    return yield* Effect.fail(recognized.value);
  });

const execute = <Request, RequestEncoded, A, I>(input: {
  readonly client: HttpClient.HttpClient;
  readonly origin: URL;
  readonly path: string;
  readonly request: Request;
  readonly requestSchema: Schema.Schema<Request, RequestEncoded>;
  readonly schema: Schema.Schema<A, I>;
  readonly callerAgentId: AgentId;
  readonly signingAuthority: AgentSigningAuthority;
  readonly timeout: Duration.Duration;
}): Effect.Effect<A, RouterClientError> =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(new URL(input.path, input.origin));
    const encodedRequest = yield* Schema.encode(input.requestSchema)(
      input.request,
    ).pipe(
      Effect.catchTag("ParseError", () => Effect.fail(new AgentSigningError())),
    );
    const signedRequest = yield* AuthenticatedHttp.signAgentRequest({
      httpRequest: request,
      callerAgentId: input.callerAgentId,
      encodedRequest,
      signingAuthority: input.signingAuthority,
    });
    const response = yield* input.client.execute(signedRequest).pipe(
      Effect.catchTags({
        RequestError: () => Effect.fail(new RouterConnectionError()),
        ResponseError: () => Effect.fail(new RouterConnectionError()),
      }),
    );
    return yield* decodeResponse(input.schema, response);
  }).pipe(
    Effect.timeoutFail({
      duration: input.timeout,
      onTimeout: () => new RouterRequestTimeoutError(),
    }),
  );

function snapshotDuration(duration: Duration.Duration): Duration.Duration {
  return Duration.match(duration, {
    onMillis: Duration.millis,
    onNanos: Duration.nanos,
  });
}

function makeClientService(
  client: HttpClient.HttpClient,
  settings: RouterClientSettings,
): RouterClientService {
  return {
    send: (call) =>
      execute({
        client,
        origin: settings.origin,
        path: routerSendPath,
        request: call.request,
        requestSchema: RouterSendRequest,
        schema: RouterSendResult,
        callerAgentId: call.callerAgentId,
        signingAuthority: call.signingAuthority,
        timeout: settings.sendTimeout,
      }),
    poll: (call) =>
      execute({
        client,
        origin: settings.origin,
        path: routerPollPath,
        request: call.request,
        requestSchema: RouterPollRequest,
        schema: RouterPollResult,
        callerAgentId: call.callerAgentId,
        signingAuthority: call.signingAuthority,
        timeout: settings.pollTimeout,
      }),
  };
}

const MAXIMUM_PROCESS_INTEGER = 2_147_483_647;
const canonicalUnsignedDecimal = Schema.String.pipe(
  Schema.pattern(/^(?:0|[1-9]\d*)$/),
);
const processInteger = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, MAXIMUM_PROCESS_INTEGER),
);
const port = canonicalUnsignedDecimal.pipe(
  Schema.compose(Schema.NumberFromString),
  Schema.int(),
  Schema.between(1, 65_535),
);
const bindHost = Schema.String.pipe(Schema.minLength(1));

const isSerializedRegistryOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return value === parsed.origin;
};

const registryOriginText = Schema.String.pipe(
  Schema.filter(isSerializedRegistryOrigin),
);
const registryOrigin = registryOriginText.pipe(Schema.compose(Schema.URL));
const compactPublicKeyJson = Schema.String.pipe(
  Schema.pattern(/^\{"crv":"Ed25519","kty":"OKP","x":"[A-Za-z0-9_-]{43}"\}$/),
  Schema.compose(Schema.parseJson(Ed25519PublicKey)),
);

const configuredValues = Config.all({
  host: Schema.Config("MOLTZAP_ROUTER_HOST", bindHost).pipe(
    Config.withDefault("127.0.0.1"),
  ),
  port: Schema.Config("MOLTZAP_ROUTER_PORT", port),
  registryOrigin: Schema.Config(
    "MOLTZAP_ROUTER_REGISTRY_ORIGIN",
    registryOrigin,
  ),
  registrySignerPublicKey: Schema.Config(
    "MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY",
    compactPublicKeyJson,
  ),
  retainedMessageCapacity: Schema.Config(
    "MOLTZAP_ROUTER_RETAINED_MESSAGE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(4_096)),
  retainedMessageByteCapacity: Schema.Config(
    "MOLTZAP_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(67_108_864)),
  pollMessageLimit: Schema.Config(
    "MOLTZAP_ROUTER_POLL_MESSAGE_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(128)),
  pollResponseByteLimit: Schema.Config(
    "MOLTZAP_ROUTER_POLL_RESPONSE_BYTE_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(1_048_576)),
  requestConcurrencyLimit: Schema.Config(
    "MOLTZAP_ROUTER_REQUEST_CONCURRENCY_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(512)),
  heldPollCapacity: Schema.Config(
    "MOLTZAP_ROUTER_HELD_POLL_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(256)),
  liveNonceCapacity: Schema.Config(
    "MOLTZAP_ROUTER_LIVE_NONCE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(100_000)),
  agentCardCacheCapacity: Schema.Config(
    "MOLTZAP_ROUTER_AGENT_CARD_CACHE_CAPACITY",
    processInteger,
  ).pipe(Config.withDefault(10_000)),
  registryLookupConcurrencyLimit: Schema.Config(
    "MOLTZAP_ROUTER_REGISTRY_LOOKUP_CONCURRENCY_LIMIT",
    processInteger,
  ).pipe(Config.withDefault(32)),
  registryLookupTimeoutMs: Schema.Config(
    "MOLTZAP_ROUTER_REGISTRY_LOOKUP_TIMEOUT_MS",
    processInteger,
  ).pipe(Config.withDefault(5_000)),
});

/** Complete validated private process configuration. */
export interface RouterConfiguration {
  readonly host: string;
  readonly port: number;
  readonly registryOrigin: URL;
  readonly registrySignerPublicKey: Ed25519PublicKeyValue;
  readonly retainedMessageCapacity: number;
  readonly retainedMessageByteCapacity: number;
  readonly pollMessageLimit: number;
  readonly pollResponseByteLimit: number;
  readonly requestConcurrencyLimit: number;
  readonly heldPollCapacity: number;
  readonly liveNonceCapacity: number;
  readonly agentCardCacheCapacity: number;
  readonly registryLookupConcurrencyLimit: number;
  readonly registryLookupTimeoutMs: number;
}

const retentionFits = (candidate: RouterConfiguration): boolean =>
  candidate.retainedMessageCapacity >= 1 &&
  candidate.retainedMessageByteCapacity >=
    SignedMessage.maximumEncodedByteLength;

const pollBatchFits = (candidate: RouterConfiguration): boolean =>
  candidate.pollMessageLimit >= 1 &&
  candidate.pollResponseByteLimit >=
    routerRepresentationLimits.oneMessageBatchBytes;

const heldPollsFit = (candidate: RouterConfiguration): boolean =>
  candidate.heldPollCapacity < candidate.requestConcurrencyLimit;

const validatedConfiguration = configuredValues.pipe(
  Config.validate({
    message:
      "Router resource bounds do not satisfy the representation fit laws",
    validation: (candidate) =>
      retentionFits(candidate) &&
      pollBatchFits(candidate) &&
      heldPollsFit(candidate),
  }),
);

/** Loads and cross-validates the complete private Router process configuration. */
export const loadRouterConfiguration = Effect.gen(function* () {
  const configuration: RouterConfiguration = yield* validatedConfiguration;
  return configuration;
}).pipe(Effect.withSpan("loadRouterConfiguration"));
