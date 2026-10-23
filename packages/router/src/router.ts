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
  legacyKeys,
  SignedMessage,
} from "@moltzap/identity";
import canonicalize from "canonicalize";
import {
  Config,
  type ConfigError,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Match,
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
  routerRepresentationLimits,
  RouterRequestTimeoutError,
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

/** ConfigError trees retain every missing field without printing rejected inputs. */
export function configurationMessage(error: ConfigError.ConfigError): string {
  return Match.value(error).pipe(
    Match.discriminatorsExhaustive("_op")({
      And: (cause) =>
        `${configurationMessage(cause.left)}; ${configurationMessage(cause.right)}`,
      Or: (cause) =>
        `${configurationMessage(cause.left)} or ${configurationMessage(cause.right)}`,
      MissingData: (cause) => `${Array.from(cause.path).join("_")} is required`,
      InvalidData: invalidConfigurationMessage,
      SourceUnavailable: (cause) =>
        `${Array.from(cause.path).join("_")} configuration source unavailable`,
      Unsupported: (cause) =>
        `${Array.from(cause.path).join("_")} configuration source unavailable`,
    }),
  );
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
    if (canonical === undefined || text !== canonical) {
      return yield* Effect.fail(invalidResponse());
    }
    return result;
  });

/**
 * Gateway statuses an intermediary answers with while the Router behind it is
 * down or restarting.
 */
const gatewayStatuses: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Whether a response is a gateway's page rather than a Router answer: a
 * gateway status without the Router's JSON content type. The Router itself
 * could not be reached, so this is a connection failure, not an invalid
 * Router response.
 */
const isGatewayPage = (
  response: HttpClientResponse.HttpClientResponse,
): boolean =>
  gatewayStatuses.has(response.status) &&
  response.headers["content-type"] !== routerJsonContentType;

const decodeResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  A,
  RouterHttpEnvelopeError | RouterConnectionError | RouterInvalidResponseError
> =>
  Effect.gen(function* () {
    if (isGatewayPage(response)) {
      return yield* Effect.fail(new RouterConnectionError());
    }
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
    if (Option.isNone(recognized)) {
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
  Schema.annotations({
    identifier: "serialized HTTP(S) origin without a path",
  }),
);
const registryOrigin = registryOriginText.pipe(Schema.compose(Schema.URL));
const compactPublicKeyJson = Schema.String.pipe(
  Schema.pattern(/^\{"crv":"Ed25519","kty":"OKP","x":"[A-Za-z0-9_-]{43}"\}$/),
  Schema.compose(Schema.parseJson(Ed25519PublicKey)),
);

const configurationFields = {
  host: setting("SHARNESS_ROUTER_HOST", bindHost, "127.0.0.1"),
  port: setting("SHARNESS_ROUTER_PORT", port),
  registryOrigin: setting("SHARNESS_ROUTER_REGISTRY_ORIGIN", registryOrigin),
  registrySignerPublicKey: setting(
    "SHARNESS_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY",
    compactPublicKeyJson,
  ),
  retainedMessageCapacity: setting(
    "SHARNESS_ROUTER_RETAINED_MESSAGE_CAPACITY",
    processInteger,
    4_096,
  ),
  retainedMessageByteCapacity: setting(
    "SHARNESS_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY",
    processInteger,
    67_108_864,
  ),
  pollMessageLimit: setting(
    "SHARNESS_ROUTER_POLL_MESSAGE_LIMIT",
    processInteger,
    128,
  ),
  pollResponseByteLimit: setting(
    "SHARNESS_ROUTER_POLL_RESPONSE_BYTE_LIMIT",
    processInteger,
    1_048_576,
  ),
  requestConcurrencyLimit: setting(
    "SHARNESS_ROUTER_REQUEST_CONCURRENCY_LIMIT",
    processInteger,
    512,
  ),
  heldPollCapacity: setting(
    "SHARNESS_ROUTER_HELD_POLL_CAPACITY",
    processInteger,
    256,
  ),
  liveNonceCapacity: setting(
    "SHARNESS_ROUTER_LIVE_NONCE_CAPACITY",
    processInteger,
    100_000,
  ),
  agentCardCacheCapacity: setting(
    "SHARNESS_ROUTER_AGENT_CARD_CACHE_CAPACITY",
    processInteger,
    10_000,
  ),
  registryLookupConcurrencyLimit: setting(
    "SHARNESS_ROUTER_REGISTRY_LOOKUP_CONCURRENCY_LIMIT",
    processInteger,
    32,
  ),
  registryLookupTimeoutMs: setting(
    "SHARNESS_ROUTER_REGISTRY_LOOKUP_TIMEOUT_MS",
    processInteger,
    5_000,
  ),
};

const configuredValues = Config.all(configurationFields);

/** Usage is generated from the same fields consumed by the process. */
export const processHelp = [
  "Usage: sharness-router [--help]",
  "",
  "Environment:",
  ...Object.values(configurationFields).map((field) => `  ${field.usage}`),
].join("\n");

/** Complete validated private process configuration. */
export type RouterConfiguration = Readonly<
  Config.Config.Success<typeof configuredValues>
>;

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

const resourceLimitMessages = {
  retention: `SHARNESS_ROUTER_RETAINED_MESSAGE_BYTE_CAPACITY must be at least ${SignedMessage.maximumEncodedByteLength} to retain one maximum-size message`,
  pollBatch: `SHARNESS_ROUTER_POLL_RESPONSE_BYTE_LIMIT must be at least ${routerRepresentationLimits.oneMessageBatchBytes} to return one maximum-size message`,
  heldPolls:
    "SHARNESS_ROUTER_HELD_POLL_CAPACITY must be less than SHARNESS_ROUTER_REQUEST_CONCURRENCY_LIMIT",
};

const validatedConfiguration = configuredValues.pipe(
  Config.validate({
    message: resourceLimitMessages.retention,
    validation: retentionFits,
  }),
  Config.validate({
    message: resourceLimitMessages.pollBatch,
    validation: pollBatchFits,
  }),
  Config.validate({
    message: resourceLimitMessages.heldPolls,
    validation: heldPollsFit,
  }),
);

/** Legacy key names survive configuration mapping without rereading ambient state. */
class LegacyConfigurationError extends Data.TaggedError(
  "LegacyConfigurationError",
)<{
  readonly keys: readonly string[];
}> {}

/** Loads and cross-validates the complete private Router process configuration. */
export const loadRouterConfiguration = Effect.gen(function* () {
  // eslint-disable-next-line agent-code-guard/no-process-env-at-runtime -- Configuration acquisition enumerates unknown legacy keys, which Effect.Config cannot name in advance.
  const keys = legacyKeys(process.env);
  if (keys.length > 0) {
    return yield* Effect.fail(new LegacyConfigurationError({ keys }));
  }
  const configuration: RouterConfiguration = yield* validatedConfiguration;
  return configuration;
}).pipe(Effect.withSpan("loadRouterConfiguration"));

/** Config and operator text share the name, schema and default at declaration. */
function setting<A, D = never>(
  name: string,
  schema: Schema.Schema<A, string>,
  ...defaults: [] | [D]
) {
  const config = Schema.Config(name, schema);
  return Object.assign(
    defaults.length === 0
      ? config
      : config.pipe(Config.withDefault(defaults[0])),
    {
      name,
      reason: `must satisfy ${schema.ast.toString()}`,
      usage: `${name}: ${settingUsage(defaults)}`,
    },
  );
}

/** Distinguishes absent defaults from explicitly unset or empty defaults in operator help. */
function settingUsage(defaults: readonly unknown[]): string {
  if (defaults.length === 0) {
    return "required; default: none";
  }
  if (defaults[0] === undefined) {
    return "optional; default: unset";
  }
  if (defaults[0] === "") {
    return "optional; default: none";
  }
  return `optional; default: ${JSON.stringify(defaults[0])}`;
}

/** Only declared setting constraints may appear in invalid-value diagnostics. */
function invalidConfigurationMessage(error: ConfigError.InvalidData): string {
  if (Object.values(resourceLimitMessages).includes(error.message)) {
    return error.message;
  }
  const name = Array.from(error.path).join("_");
  const field = Object.values(configurationFields).find(
    (candidate) => candidate.name === name,
  );
  return field === undefined
    ? "environment configuration is invalid"
    : `${name} ${field.reason}`;
}
