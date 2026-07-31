import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServerRequest } from "@effect/platform-node";
import { Cause, Effect, Option, Schema } from "effect";
import {
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
  httpEnvelope,
  type HttpEnvelopeError,
} from "../http-errors.js";
import { decodeCanonicalJson, encodeCanonicalJson } from "../identity-json.js";
import { MOLTZAP_VERSION } from "../version.js";
import { verifyBootstrapRegistration } from "./bootstrap-admission.js";
import {
  listResponseSchema,
  lookupResponseSchema,
  RegistryListRequest,
  RegistryLookupRequest,
  registerResponseSchema,
} from "./operations.js";
import type { RegistryRpcClient } from "./rpc.js";
import { withBootstrapAdmission } from "./request-context.js";
import type { RegistryStorage } from "./storage.js";

const REGISTER_PATH = "/v1/identities:register";
const LOOKUP_PATH = "/v1/identities:lookup";
const LIST_PATH = "/v1/identities:list";
const HEALTH_PATH = "/healthz";
const REGISTER_ROUTE = "/v1/identities::register";
const LOOKUP_ROUTE = "/v1/identities::lookup";
const LIST_ROUTE = "/v1/identities::list";
const JSON_CONTENT_TYPE = "application/json";
const SIGNATURE_HEADERS = [
  "content-digest",
  "signature-input",
  "signature",
  "authorization",
] as const;
const SINGLE_VALUE_HEADERS = [
  "host",
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "moltzap-version",
  ...SIGNATURE_HEADERS,
] as const;
const KNOWN_PATHS = new Set([
  REGISTER_PATH,
  LOOKUP_PATH,
  LIST_PATH,
  HEALTH_PATH,
]);

const maximumIdentifier = "agt_AAAAAAAAAAAAAAAAAAAAAA";
const maximumOperationId = "opn_AAAAAAAAAAAAAAAAAAAAAA";
const maximumPrincipalId = "prn_AAAAAAAAAAAAAAAAAAAAAA";
const maximumName = "a".repeat(32);
const maximumCoordinate = "A".repeat(43);
const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const REGISTER_BODY_CAP = byteLength({
  request: {
    operationId: maximumOperationId,
    principalId: maximumPrincipalId,
    agentName: maximumName,
    publicKey: {
      crv: "Ed25519",
      kty: "OKP",
      x: maximumCoordinate,
    },
  },
});
const LOOKUP_BODY_CAP = Math.max(
  byteLength({ agentId: maximumIdentifier }),
  byteLength({ agentName: maximumName }),
);
const LIST_BODY_CAP = byteLength({
  afterAgentId: maximumIdentifier,
});

const jsonResponse = (
  bodyBytes: Uint8Array,
  status: number,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.uint8Array(bodyBytes, {
    status,
    contentType: JSON_CONTENT_TYPE,
  });

const errorResponse = (
  error: HttpEnvelopeError,
): HttpServerResponse.HttpServerResponse => {
  const envelope = httpEnvelope(error);
  return jsonResponse(
    new TextEncoder().encode(`{"error":"${envelope.code}"}`),
    envelope.status,
  );
};

const resultResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  value: A,
): Effect.Effect<HttpServerResponse.HttpServerResponse, InternalServerError> =>
  Schema.encode(schema)(value).pipe(
    Effect.flatMap(encodeCanonicalJson),
    Effect.map((bytes) => jsonResponse(bytes, 200)),
    // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Response serialization is an internal closed boundary with no client-actionable detail.
    Effect.mapError(() => new InternalServerError()),
  );

const canonicalContentLength = (
  request: HttpServerRequest.HttpServerRequest,
): number | undefined => {
  const value = request.headers["content-length"];
  if (value === undefined || !/^(?:0|[1-9]\d*)$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const rawHeaderCount = (
  request: HttpServerRequest.HttpServerRequest,
  name: string,
): number => {
  const incoming = NodeHttpServerRequest.toIncomingMessage(request);
  let count = 0;
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    if (incoming.rawHeaders[index]?.toLowerCase() === name) {
      count += 1;
    }
  }
  return count;
};

type RequestProfile = "registration" | "public-read";

const requestFramingIsMalformed = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly profile: RequestProfile;
}): boolean => {
  if (
    SINGLE_VALUE_HEADERS.some((name) => rawHeaderCount(input.request, name) > 1)
  ) {
    return true;
  }
  if (
    input.request.headers["content-length"] !== undefined &&
    input.request.headers["transfer-encoding"] !== undefined
  ) {
    return true;
  }
  return (
    input.profile === "public-read" &&
    SIGNATURE_HEADERS.some((name) => rawHeaderCount(input.request, name) !== 0)
  );
};

const mediaTypeIsUnsupported = (
  request: HttpServerRequest.HttpServerRequest,
): boolean =>
  request.headers["content-type"] !== JSON_CONTENT_TYPE ||
  request.headers["content-encoding"] !== undefined;

const rejectBeforeBodyRead = <E>(
  request: HttpServerRequest.HttpServerRequest,
  error: E,
): Effect.Effect<never, E> =>
  Effect.sync(() => {
    NodeHttpServerRequest.toIncomingMessage(request).resume();
  }).pipe(Effect.zipRight(Effect.fail(error)));

const validateDeclaredLength = (
  request: HttpServerRequest.HttpServerRequest,
  maximumBytes: number,
): Effect.Effect<void, MalformedRequestError | PayloadTooLargeError> => {
  const headerIsPresent = request.headers["content-length"] !== undefined;
  const declaredLength = canonicalContentLength(request);
  if (headerIsPresent && declaredLength === undefined) {
    return rejectBeforeBodyRead(request, new MalformedRequestError());
  }
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    return rejectBeforeBodyRead(request, new PayloadTooLargeError());
  }
  return Effect.void;
};

const validateRequestFraming = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly maximumBytes: number;
  readonly profile: RequestProfile;
}): Effect.Effect<
  void,
  MalformedRequestError | UnsupportedMediaTypeError | PayloadTooLargeError
> => {
  if (requestFramingIsMalformed(input)) {
    return rejectBeforeBodyRead(input.request, new MalformedRequestError());
  }
  if (mediaTypeIsUnsupported(input.request)) {
    return rejectBeforeBodyRead(input.request, new UnsupportedMediaTypeError());
  }
  return validateDeclaredLength(input.request, input.maximumBytes);
};

interface BodyReader {
  readonly cleanup: () => void;
  readonly onData: (chunk: Uint8Array) => void;
  readonly onEnd: () => void;
  readonly onError: () => void;
}

const readBoundedBody = (
  request: HttpServerRequest.HttpServerRequest,
  maximumBytes: number,
): Effect.Effect<Uint8Array, PayloadTooLargeError | MalformedRequestError> =>
  Effect.async((resume) => {
    const incoming = NodeHttpServerRequest.toIncomingMessage(request);
    const body = new Uint8Array(maximumBytes);
    let length = 0;
    const reader: BodyReader = {
      cleanup: () => {
        incoming.off("data", reader.onData);
        incoming.off("end", reader.onEnd);
        incoming.off("error", reader.onError);
      },
      onData: (chunk) => {
        if (length + chunk.byteLength > maximumBytes) {
          reader.cleanup();
          incoming.resume();
          resume(Effect.fail(new PayloadTooLargeError()));
          return;
        }
        body.set(chunk, length);
        length += chunk.byteLength;
      },
      onEnd: () => {
        reader.cleanup();
        resume(Effect.succeed(body.slice(0, length)));
      },
      onError: () => {
        reader.cleanup();
        resume(Effect.fail(new MalformedRequestError()));
      },
    };
    incoming.on("data", reader.onData);
    incoming.once("end", reader.onEnd);
    incoming.once("error", reader.onError);
    return Effect.sync(() => {
      reader.cleanup();
      incoming.resume();
    });
  });

const executeWithPermit = <A, E, R>(
  semaphore: Effect.Semaphore,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | OverloadedError, R> =>
  semaphore
    .withPermitsIfAvailable(1)(effect)
    .pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new OverloadedError()),
          onSome: Effect.succeed,
        }),
      ),
    );

const recoverHttpResponse = <R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpEnvelopeError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchAll((error) => Effect.succeed(errorResponse(error))),
    Effect.catchAllCause((cause) =>
      Effect.logError("Registry request failed", Cause.squash(cause)).pipe(
        Effect.as(errorResponse(new InternalServerError())),
      ),
    ),
  );

const registerHandler = (input: {
  readonly client: RegistryRpcClient;
  readonly storage: RegistryStorage;
  readonly admissionCredential: Parameters<
    typeof verifyBootstrapRegistration
  >[0]["admissionCredential"];
  readonly nonceCapacity: number;
  readonly requestSemaphore: Effect.Semaphore;
}) =>
  recoverHttpResponse(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.url !== REGISTER_PATH) {
        return yield* new RouteNotFoundError();
      }
      yield* validateRequestFraming({
        request,
        maximumBytes: REGISTER_BODY_CAP,
        profile: "registration",
      });
      return yield* executeWithPermit(
        input.requestSemaphore,
        Effect.gen(function* () {
          const bodyBytes = yield* readBoundedBody(request, REGISTER_BODY_CAP);
          const registration = yield* verifyBootstrapRegistration({
            httpRequest: request,
            bodyBytes,
            admissionCredential: input.admissionCredential,
            nonceCapacity: input.nonceCapacity,
            storage: input.storage,
          });
          const result = yield* withBootstrapAdmission(
            input.client.register(registration),
          );
          return yield* resultResponse(registerResponseSchema, result);
        }),
      );
    }),
  );

const publicReadHandler = <
  Request,
  RequestEncoded,
  Result,
  ResultEncoded,
>(input: {
  readonly path: string;
  readonly bodyCap: number;
  readonly requestSchema: Schema.Schema<Request, RequestEncoded>;
  readonly resultSchema: Schema.Schema<Result, ResultEncoded>;
  readonly invoke: (
    request: Request,
  ) => Effect.Effect<Result, HttpEnvelopeError>;
  readonly requestSemaphore: Effect.Semaphore;
}) =>
  recoverHttpResponse(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.url !== input.path) {
        return yield* new RouteNotFoundError();
      }
      yield* validateRequestFraming({
        request,
        maximumBytes: input.bodyCap,
        profile: "public-read",
      });
      return yield* executeWithPermit(
        input.requestSemaphore,
        Effect.gen(function* () {
          const bodyBytes = yield* readBoundedBody(request, input.bodyCap);
          if (request.headers["moltzap-version"] !== MOLTZAP_VERSION) {
            return yield* new VersionMismatchError();
          }
          const decoded = yield* decodeCanonicalJson(
            input.requestSchema,
            bodyBytes,
          ).pipe(
            // eslint-disable-next-line agent-code-guard/no-effect-error-coalescing -- Every canonical body or request-schema failure has the same public malformed-request meaning.
            Effect.mapError(() => new MalformedRequestError()),
          );
          const result = yield* input.invoke(decoded);
          return yield* resultResponse(input.resultSchema, result);
        }),
      );
    }),
  );

type RegistryHttpAppInput = Readonly<{
  client: RegistryRpcClient;
  storage: RegistryStorage;
  admissionCredential: Parameters<
    typeof verifyBootstrapRegistration
  >[0]["admissionCredential"];
  nonceCapacity: number;
  requestSemaphore: Effect.Semaphore;
}>;

const lookupRoute = (input: RegistryHttpAppInput) =>
  HttpRouter.post(
    LOOKUP_ROUTE,
    publicReadHandler({
      path: LOOKUP_PATH,
      bodyCap: LOOKUP_BODY_CAP,
      requestSchema: RegistryLookupRequest,
      resultSchema: lookupResponseSchema,
      invoke: (request) => input.client.lookup(request),
      requestSemaphore: input.requestSemaphore,
    }),
  );

const listRoute = (input: RegistryHttpAppInput) =>
  HttpRouter.post(
    LIST_ROUTE,
    publicReadHandler({
      path: LIST_PATH,
      bodyCap: LIST_BODY_CAP,
      requestSchema: RegistryListRequest,
      resultSchema: listResponseSchema,
      invoke: (request) => input.client.list(request),
      requestSemaphore: input.requestSemaphore,
    }),
  );

const healthRoute = (storage: RegistryStorage) =>
  HttpRouter.get(
    HEALTH_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.url !== HEALTH_PATH) {
        return errorResponse(new RouteNotFoundError());
      }
      return yield* storage.checkReadiness().pipe(
        Effect.match({
          onFailure: () => HttpServerResponse.empty({ status: 503 }),
          onSuccess: () => HttpServerResponse.empty({ status: 204 }),
        }),
        Effect.catchAllCause(() =>
          Effect.succeed(HttpServerResponse.empty({ status: 503 })),
        ),
      );
    }),
  );

const fallbackRoute = HttpRouter.all(
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.url.includes("?")) {
      return errorResponse(new RouteNotFoundError());
    }
    const path = request.url.split("?", 1)[0] ?? "";
    return KNOWN_PATHS.has(path)
      ? errorResponse(new MethodNotAllowedError())
      : errorResponse(new RouteNotFoundError());
  }),
);

/**
 * Builds the complete Registry HTTP application.
 *
 * @param input Complete Registry boundary dependencies.
 * @param input.client In-process RPC client for domain operations.
 * @param input.storage Durable registration nonce storage.
 * @param input.admissionCredential Bootstrap admission secret.
 * @param input.nonceCapacity Maximum live bootstrap nonces.
 * @param input.requestSemaphore Immediate global request admission.
 * @returns The complete Registry HTTP application.
 */
export const makeRegistryHttpApp = (input: RegistryHttpAppInput) =>
  HttpRouter.empty.pipe(
    HttpRouter.post(REGISTER_ROUTE, registerHandler(input)),
    lookupRoute(input),
    listRoute(input),
    healthRoute(input.storage),
    fallbackRoute,
  );
