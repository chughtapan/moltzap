import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform";
import {
  type AgentId,
  AgentSigningError,
  type AgentSigningAuthority,
  AuthenticatedHttp,
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
} from "@moltzap/v2-identity";
import canonicalize from "canonicalize";
import { Duration, Effect, Schema } from "effect";
import {
  RouterConnectionError,
  RouterInvalidResponseError,
  RouterRequestTimeoutError,
} from "./errors.js";
import {
  RouterPollRequest,
  RouterPollResult,
  RouterSendRequest,
  RouterSendResult,
} from "./operations.js";

const SEND_PATH = "/v1/messages:send";
const POLL_PATH = "/v1/messages:poll";
const JSON_CONTENT_TYPE = "application/json";

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

/** Closed public Router client failure union. */
export type RouterClientError =
  | MalformedRequestError
  | AuthenticationFailedError
  | RouteNotFoundError
  | MethodNotAllowedError
  | VersionMismatchError
  | PayloadTooLargeError
  | UnsupportedMediaTypeError
  | OverloadedError
  | UnavailableError
  | InternalServerError
  | RouterConnectionError
  | RouterRequestTimeoutError
  | RouterInvalidResponseError
  | AgentSigningError;

/** Service shape provided by the public Router capability. */
export interface RouterClientService {
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

const envelopeErrors = new Map<
  number,
  Readonly<{
    body: string;
    make: () =>
      | MalformedRequestError
      | AuthenticationFailedError
      | RouteNotFoundError
      | MethodNotAllowedError
      | VersionMismatchError
      | PayloadTooLargeError
      | UnsupportedMediaTypeError
      | OverloadedError
      | UnavailableError
      | InternalServerError;
  }>
>([
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

const decodeResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<
  A,
  | MalformedRequestError
  | AuthenticationFailedError
  | RouteNotFoundError
  | MethodNotAllowedError
  | VersionMismatchError
  | PayloadTooLargeError
  | UnsupportedMediaTypeError
  | OverloadedError
  | UnavailableError
  | InternalServerError
  | RouterConnectionError
  | RouterInvalidResponseError
> =>
  Effect.gen(function* () {
    const bytes = yield* response.arrayBuffer.pipe(
      Effect.catchTag("ResponseError", () =>
        Effect.fail(new RouterConnectionError()),
      ),
      Effect.map((buffer) => new Uint8Array(buffer)),
    );
    if (response.headers["content-type"] !== JSON_CONTENT_TYPE) {
      return yield* Effect.fail(invalidResponse());
    }
    if (response.status === 200) {
      return yield* decodeCanonicalResult(schema, bytes);
    }
    const recognized = envelopeErrors.get(response.status);
    if (recognized === undefined) {
      return yield* Effect.fail(invalidResponse());
    }
    const text = yield* decodeUtf8(bytes);
    if (
      recognized.body !== text ||
      !sameBytes(bytes, utf8Encoder.encode(recognized.body))
    ) {
      return yield* Effect.fail(invalidResponse());
    }
    return yield* Effect.fail(recognized.make());
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

interface RouterClientSettings {
  readonly origin: URL;
  readonly sendTimeout: Duration.Duration;
  readonly pollTimeout: Duration.Duration;
}

const snapshotDuration = (duration: Duration.Duration): Duration.Duration =>
  Duration.match(duration, {
    onMillis: Duration.millis,
    onNanos: Duration.nanos,
  });

const makeClientService = (
  client: HttpClient.HttpClient,
  settings: RouterClientSettings,
): RouterClientService => ({
  send: (call) =>
    execute({
      client,
      origin: settings.origin,
      path: SEND_PATH,
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
      path: POLL_PATH,
      request: call.request,
      requestSchema: RouterPollRequest,
      schema: RouterPollResult,
      callerAgentId: call.callerAgentId,
      signingAuthority: call.signingAuthority,
      timeout: settings.pollTimeout,
    }),
});

/**
 * Builds the public Router service over Effect's standard HttpClient.
 *
 * @param input Remote origin and complete operation deadlines.
 * @param input.origin Router HTTP origin.
 * @param input.sendTimeout Complete send deadline.
 * @param input.pollTimeout Complete poll deadline.
 * @returns A client service requiring the standard HttpClient capability.
 */
export const makeRouterClient = (input: {
  readonly origin: URL;
  readonly sendTimeout: Duration.Duration;
  readonly pollTimeout: Duration.Duration;
}): Effect.Effect<RouterClientService, never, HttpClient.HttpClient> => {
  const settings = Object.freeze({
    origin: new URL(input.origin.href),
    sendTimeout: snapshotDuration(input.sendTimeout),
    pollTimeout: snapshotDuration(input.pollTimeout),
  });
  return HttpClient.HttpClient.pipe(
    Effect.map((client) => makeClientService(client, settings)),
    Effect.withSpan("makeRouterClient"),
  );
};
