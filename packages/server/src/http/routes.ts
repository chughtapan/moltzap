import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import type * as Socket from "@effect/platform/Socket";
import { Cause, Data, Effect, Exit, Redacted, Schema } from "effect";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import { register, type AgentKey } from "@moltzap/protocol/identity";

import type { ServerTags } from "#moltzap";
import type { ResolvedServices } from "#core";
import type { ConnectionTag } from "#socket";
import { safeEqual } from "#identity/credential-keys";
import type { CoreConfig } from "#config";
import type { RegistrationSecret } from "#config/secrets";

const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_SERVER_ERROR = 500;

const ERROR_INVALID_JSON = "Invalid JSON";
const ERROR_INVALID_PARAMETERS = "Invalid parameters";

type RegisterParams = ParamsOf<typeof register>;

const decodeHttpBody =
  <A, I>(schema: Schema.Schema<A, I>) =>
  (value: unknown): Effect.Effect<A, unknown> =>
    Schema.decodeUnknown(schema)(value, { onExcessProperty: "error" });

const decodeRegisterBody = decodeHttpBody(register.paramsSchema);

const optionalSecretValue = <A>(
  value?: Redacted.Redacted<A>,
): A | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return Redacted.value(value);
};

class HttpEarlyResponse extends Data.TaggedError("HttpEarlyResponse")<{
  readonly response: HttpServerResponse.HttpServerResponse;
}> {}

interface CoreHttpAppOptions {
  readonly config: CoreConfig;
  readonly authService: ResolvedServices["authService"];
  readonly connections: ResolvedServices["connections"];
  readonly handleSocket: (
    socket: Socket.Socket,
  ) => Effect.Effect<
    void,
    Socket.SocketError,
    Exclude<ServerTags, ConnectionTag>
  >;
}

interface RegisterAgentSuccess {
  readonly agentId: string;
  readonly apiKey: AgentKey;
}

/**
 * Build the core HTTP app. Composes the two always-on routes
 * (`/health`, `/ws`) with the auth surface
 * (`/api/v1/auth/register`) and wraps the router in CORS.
 *
 * | Route                              | Mounted unless         | Method | Body                          | Status                                                       |
 * |------------------------------------|------------------------|--------|-------------------------------|--------------------------------------------------------------|
 * | `/health`                          | always                 | GET    | —                             | 200 `{status, connections}`                                  |
 * | `/ws`                              | always                 | GET    | WS Upgrade                    | 101                                                          |
 * | `/api/v1/auth/register`            | `skipDefaultRegisterRoute` | POST | `Register.params`           | 201 `{agentId, apiKey}`; 400/403/500                         |
 * The bodied route funnels through `readDecodedBody` for JSON
 * decode + Effect-Schema strict (excess-rejecting) decode. Invite-gate
 * checks use `safeEqual`
 * (constant-time) to compare `inviteCode` against
 * `registrationSecret`.
 * @param options Options that control the operation.
 * @returns The created core http app.
 */
export function makeCoreHttpApp(options: CoreHttpAppOptions) {
  const healthRoute = makeHealthRoute(options.connections);
  const registerRoute = makeRegisterRoute(options);
  const wsRoute = makeWsRoute(options.handleSocket);
  const router = options.config.skipDefaultRegisterRoute
    ? HttpRouter.empty.pipe(healthRoute, wsRoute)
    : HttpRouter.empty.pipe(healthRoute, registerRoute, wsRoute);
  return withCors(router, options.config.corsOrigins);
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
        // The router factory is intentionally kept above the reusable handler definitions.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- route construction is declaration-order independent.
        const body = yield* readDecodedBody(request, decodeRegisterBody);
        yield* authorizeInviteCode(
          optionalSecretValue(body.inviteCode),
          options.config.registrationSecret,
        );
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- route construction is declaration-order independent.
        return yield* registerAgent(body, options);
      }).pipe(Effect.withSpan("http.auth.register")),
    ),
  );
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

const readDecodedBody = Effect.fn("http.readDecodedBody")(function* <T>(
  request: HttpServerRequest.HttpServerRequest,
  decode: (value: unknown) => Effect.Effect<T, unknown>,
) {
  const body = yield* readJsonBody(request);
  return yield* decode(body).pipe(
    Effect.catchAll(() => failResponse<T>(invalidParametersResponse())),
  );
});

function readJsonBody(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<unknown, HttpEarlyResponse> {
  return request.json.pipe(
    Effect.catchAll(() => failResponse(invalidJsonResponse())),
  );
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

const registerAgent = Effect.fn("http.registerAgent")(function* (
  body: RegisterParams,
  options: CoreHttpAppOptions,
) {
  const exit = yield* Effect.exit(
    options.authService.registerAgent(body, options.config.adminUserId),
  );
  if (Exit.isSuccess(exit)) {
    return registerSuccessResponse(exit.value);
  }
  yield* Effect.logError("Registration failed").pipe(
    Effect.annotateLogs({ cause: Cause.pretty(exit.cause) }),
  );
  return registrationFailedResponse();
});

function authorizeInviteCode(
  inviteCode?: string,
  secret?: RegistrationSecret,
): Effect.Effect<void, HttpEarlyResponse> {
  if (secret === undefined) {
    return Effect.void;
  }
  if (inviteCode === undefined) {
    return failResponse(invalidInviteCodeResponse());
  }
  if (safeEqual(inviteCode, Redacted.value(secret))) {
    return Effect.void;
  }
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
    if (corsOrigins.includes("*")) {
      return true;
    }
    if (corsOrigins.includes(origin)) {
      return true;
    }
    Effect.runFork(
      Effect.logWarning("CORS origin rejected").pipe(
        Effect.annotateLogs({ origin }),
      ),
    );
    return false;
  };
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
