import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import * as Socket from "@effect/platform/Socket";
import { Cause, Data, Effect, Either, Exit, Redacted, Schema } from "effect";
import type { AgentKey } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import { Register } from "@moltzap/protocol/identity";
import {
  validateAppManifest,
  type AppManifest,
} from "@moltzap/protocol/identity";

import type { AppTags } from "#socket";
import type { ConnectionTag, ResolvedServices } from "#core";
import { safeEqual } from "../identity/credential-keys.js";
import type { CoreConfig } from "../config.js";
import type { RegistrationSecret } from "../config/secrets.js";

const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_SERVER_ERROR = 500;

const ERROR_INVALID_JSON = "Invalid JSON";
const ERROR_INVALID_PARAMETERS = "Invalid parameters";

const INVALID_JSON_BODY = Symbol("InvalidJsonBody");

type RegisterParams = ParamsOf<typeof Register>;

const decodeHttpBody =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (value: unknown): Effect.Effect<A, unknown> =>
    Schema.decodeUnknown(schema)(value, { onExcessProperty: "error" });

const decodeRegisterBody = decodeHttpBody(Register.paramsSchema);

const optionalSecretValue = <A>(
  value: Redacted.Redacted<A> | undefined,
): A | undefined => {
  if (value === undefined) return undefined;
  return Redacted.value(value);
};

class HttpEarlyResponse extends Data.TaggedError("HttpEarlyResponse")<{
  readonly response: HttpServerResponse.HttpServerResponse;
}> {}

interface CoreHttpAppOptions {
  readonly config: CoreConfig;
  readonly authService: ResolvedServices["authService"];
  readonly appAuthService: ResolvedServices["appAuthService"];
  readonly connections: ResolvedServices["connections"];
  readonly handleSocket: (
    socket: Socket.Socket,
  ) => Effect.Effect<void, Socket.SocketError, Exclude<AppTags, ConnectionTag>>;
}

interface RegisterAgentSuccess {
  readonly agentId: string;
  readonly apiKey: AgentKey;
}

/**
 * Build the core HTTP app. Composes the three always-on routes
 * (`/health`, `/ws`) with the auth surface
 * (`/api/v1/auth/register`) and wraps the router in CORS.
 *
 * | Route                              | Mounted unless         | Method | Body                          | Status                                                       |
 * |------------------------------------|------------------------|--------|-------------------------------|--------------------------------------------------------------|
 * | `/health`                          | always                 | GET    | —                             | 200 `{status, connections}`                                  |
 * | `/ws`                              | always                 | GET    | WS Upgrade                    | 101                                                          |
 * | `/api/v1/auth/register`            | `skipDefaultRegisterRoute` | POST | `Register.params`           | 201 `{agentId, apiKey}`; 400/403/500                         |
 * | `/api/v1/apps/register`            | `skipDefaultRegisterRoute` | POST | `{ manifest, inviteCode? }` | 201 `{appId, appKey}`; 400/403/500                           |
 * All bodied routes funnel through `readValidatedBody` for JSON
 * decode + Effect-Schema strict (excess-rejecting) decode. Invite-gate
 * checks use `safeEqual`
 * (constant-time) to compare `inviteCode` against
 * `registrationSecret`.
 */
export function makeCoreHttpApp(options: CoreHttpAppOptions) {
  const healthRoute = makeHealthRoute(options.connections);
  const registerRoute = makeRegisterRoute(options);
  const appsRegisterRoute = makeAppsRegisterRoute(options);
  const wsRoute = makeWsRoute(options.handleSocket);
  if (options.config.skipDefaultRegisterRoute) {
    return withCors(
      HttpRouter.empty.pipe(healthRoute, wsRoute),
      options.config.corsOrigins,
    );
  }
  return withCors(
    HttpRouter.empty.pipe(
      healthRoute,
      registerRoute,
      appsRegisterRoute,
      wsRoute,
    ),
    options.config.corsOrigins,
  );
}

function makeHealthRoute(connections: ResolvedServices["connections"]) {
  return HttpRouter.get(
    "/health",
    Effect.gen(function* () {
      const connectionCount = yield* connections.currentSize();
      return HttpServerResponse.unsafeJson({
        status: "ok",
        connections: connectionCount,
      });
    }),
  );
}

function makeRegisterRoute(options: CoreHttpAppOptions) {
  return HttpRouter.post(
    "/api/v1/auth/register",
    handleEarlyResponse(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* readDecodedBody(request, decodeRegisterBody);
        yield* authorizeInviteCode(
          optionalSecretValue(body.inviteCode),
          options.config.registrationSecret,
        );
        return yield* registerAgent(body, options);
      }).pipe(Effect.withSpan("http.auth.register")),
    ),
  );
}

/**
 * App-credential minting. The App-principal sibling of
 * `/api/v1/auth/register`: an operator POSTs an `AppManifest` and receives
 * the server-minted `{ appId, appKey }` exactly once (the `app_id` is issued
 * by `gen_random_uuid()`, never client-controlled). The returned `appKey` is
 * the credential an app client presents on the third Connect arm
 * (`connect.handlers.ts → handleConnect`'s `appKey` branch), where implicit
 * registration binds the live `AppConnection` as the app's moderator
 * endpoint.
 */
function makeAppsRegisterRoute(options: CoreHttpAppOptions) {
  return HttpRouter.post(
    "/api/v1/apps/register",
    handleEarlyResponse(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* readJsonRecord(request);
        const manifest = yield* validateManifestBody(body["manifest"]);
        yield* authorizeInviteCode(
          extractInviteCode(body),
          options.config.registrationSecret,
        );
        return yield* registerApp(manifest, options);
      }).pipe(Effect.withSpan("http.apps.register")),
    ),
  );
}

function validateManifestBody(
  raw: unknown,
): Effect.Effect<AppManifest, HttpEarlyResponse> {
  return Either.match(validateAppManifest(raw), {
    onLeft: () => failResponse<AppManifest>(invalidParametersResponse()),
    onRight: (manifest) => Effect.succeed(manifest),
  });
}

function extractInviteCode(body: Record<string, unknown>): string | undefined {
  const raw = body["inviteCode"];
  return typeof raw === "string" ? raw : undefined;
}

function registerApp(manifest: AppManifest, options: CoreHttpAppOptions) {
  return Effect.gen(function* () {
    const { appId, appKey } = yield* options.appAuthService.registerApp({
      manifest,
    });
    return jsonResponse(
      { appId, appKey: Redacted.value(appKey) },
      HTTP_CREATED,
    );
  }).pipe(Effect.withSpan("http.registerApp"));
}

function makeWsRoute(handleSocket: CoreHttpAppOptions["handleSocket"]) {
  return HttpRouter.get(
    "/ws",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const socket = yield* request.upgrade;
      yield* handleSocket(socket);
      return HttpServerResponse.empty();
    }).pipe(
      Effect.catchAll((err) => {
        Effect.runFork(
          Effect.logWarning("WS upgrade failed").pipe(
            Effect.annotateLogs({ err }),
          ),
        );
        return HttpServerResponse.empty({ status: HTTP_BAD_REQUEST });
      }),
      Effect.withSpan("http.ws"),
    ),
  );
}

function readDecodedBody<T>(
  request: HttpServerRequest.HttpServerRequest,
  decode: (value: unknown) => Effect.Effect<T, unknown>,
): Effect.Effect<T, HttpEarlyResponse> {
  return Effect.gen(function* () {
    const body = yield* readJsonBody(request);
    return yield* decode(body).pipe(
      Effect.catchAll(() => failResponse<T>(invalidParametersResponse())),
    );
  }).pipe(Effect.withSpan("http.readDecodedBody"));
}

function readJsonBody(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<unknown, HttpEarlyResponse> {
  return request.json.pipe(
    Effect.catchAll(() => failResponse(invalidJsonResponse())),
  );
}

function readJsonRecord(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<Record<string, unknown>, HttpEarlyResponse> {
  return Effect.gen(function* () {
    const body = yield* request.json.pipe(
      Effect.catchAll(() => Effect.succeed(INVALID_JSON_BODY)),
    );
    if (body === INVALID_JSON_BODY) {
      return yield* failResponse<Record<string, unknown>>(
        invalidJsonResponse(),
      );
    }
    if (!isStringKeyedRecord(body)) {
      return yield* failResponse<Record<string, unknown>>(
        invalidParametersResponse(),
      );
    }
    return body;
  });
}

function handleEarlyResponse<R>(
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpEarlyResponse,
    R
  >,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> {
  return effect.pipe(
    Effect.catchTag("HttpEarlyResponse", ({ response }) =>
      Effect.succeed(response),
    ),
  );
}

function failResponse<A>(
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<A, HttpEarlyResponse> {
  return Effect.fail(new HttpEarlyResponse({ response }));
}

function withCors<E, R>(
  router: HttpRouter.HttpRouter<E, R>,
  corsOrigins: readonly string[],
) {
  return router.pipe(
    HttpMiddleware.cors({
      allowedOrigins: makeAllowedOriginsPredicate(corsOrigins),
    }),
  );
}

function registerAgent(body: RegisterParams, options: CoreHttpAppOptions) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      options.authService.registerAgent(body, options.config.adminUserId),
    );
    if (Exit.isSuccess(exit)) return registerSuccessResponse(exit.value);
    yield* Effect.logError("Registration failed").pipe(
      Effect.annotateLogs({ cause: Cause.pretty(exit.cause) }),
    );
    return registrationFailedResponse();
  }).pipe(Effect.withSpan("http.registerAgent"));
}

function authorizeInviteCode(
  inviteCode: string | undefined,
  secret: RegistrationSecret | undefined,
): Effect.Effect<void, HttpEarlyResponse> {
  if (secret === undefined) return Effect.void;
  if (inviteCode === undefined)
    return failResponse(invalidInviteCodeResponse());
  if (safeEqual(inviteCode, Redacted.value(secret))) return Effect.void;
  return failResponse(invalidInviteCodeResponse());
}

function registerSuccessResponse(result: RegisterAgentSuccess) {
  const { agentId, apiKey } = result;
  return jsonResponse(
    {
      agentId,
      apiKey: Redacted.value(apiKey),
    },
    HTTP_CREATED,
  );
}

function makeAllowedOriginsPredicate(corsOrigins: readonly string[]) {
  return (origin: string): boolean => {
    if (corsOrigins.includes("*")) return true;
    if (corsOrigins.includes(origin)) return true;
    Effect.runFork(
      Effect.logWarning("CORS origin rejected").pipe(
        Effect.annotateLogs({ origin }),
      ),
    );
    return false;
  };
}

function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidJsonResponse() {
  return jsonResponse({ error: ERROR_INVALID_JSON }, HTTP_BAD_REQUEST);
}

function invalidParametersResponse() {
  return jsonResponse({ error: ERROR_INVALID_PARAMETERS }, HTTP_BAD_REQUEST);
}

function invalidInviteCodeResponse() {
  return jsonResponse(
    { error: "Invalid or missing invite code" },
    HTTP_FORBIDDEN,
  );
}

function registrationFailedResponse() {
  return jsonResponse(
    { error: "Registration failed" },
    HTTP_INTERNAL_SERVER_ERROR,
  );
}

function jsonResponse(body: Record<string, unknown>, status: number) {
  return HttpServerResponse.unsafeJson(body, { status });
}
