import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import * as Socket from "@effect/platform/Socket";
import { timingSafeEqual } from "node:crypto";
import { Cause, Data, Effect, Exit } from "effect";
import type { ParamsOf } from "@moltzap/protocol";
import { Claim, Register } from "@moltzap/protocol";

import type { AuthenticatedContext } from "../transport/context.js";
import type { AppTags } from "../transport/layer-tags.js";
import type { ConnectionTag, ResolvedServices } from "./layers.js";
import {
  CLAIM_NOT_FOUND,
  CLAIM_OWNER_MISMATCH,
  CLAIM_SUCCESS,
  type ClaimAgentResult,
} from "../identity/services/auth.service.js";
import type { CoreConfig } from "../config.js";

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_INTERNAL_SERVER_ERROR = 500;

const ERROR_INVALID_JSON = "Invalid JSON";
const ERROR_INVALID_PARAMETERS = "Invalid parameters";

const INVALID_JSON_BODY = Symbol("InvalidJsonBody");
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RegisterParams = ParamsOf<typeof Register>;

class HttpEarlyResponse extends Data.TaggedError("HttpEarlyResponse")<{
  readonly response: HttpServerResponse.HttpServerResponse;
}> {}

interface CoreHttpAppOptions {
  readonly config: CoreConfig;
  readonly authService: ResolvedServices["authService"];
  readonly connections: ResolvedServices["connections"];
  readonly handleSocket: (
    socket: Socket.Socket,
  ) => Effect.Effect<void, Socket.SocketError, Exclude<AppTags, ConnectionTag>>;
}

interface AdminRegisterPayload {
  readonly registerBody: RegisterParams;
  readonly ownerUserId: string | undefined;
}

interface RegisterAgentSuccess {
  readonly agentId: string;
  readonly apiKey: string;
  readonly claimToken: string;
}

/**
 * Build the core HTTP app. Composes the three always-on routes
 * (`/health`, `/ws`, conditional admin) with the auth surface
 * (`/api/v1/auth/register`, `/api/v1/auth/claim`) and wraps the
 * router in CORS.
 *
 * | Route                              | Mounted unless         | Method | Body                          | Status                                                       |
 * |------------------------------------|------------------------|--------|-------------------------------|--------------------------------------------------------------|
 * | `/health`                          | always                 | GET    | —                             | 200 `{status, connections}`                                  |
 * | `/ws`                              | always                 | GET    | WS Upgrade                    | 101                                                          |
 * | `/api/v1/auth/register`            | `skipDefaultRegisterRoute` | POST | `Register.params`           | 201 `{agentId, apiKey, claimToken, claimUrl}`; 400/403/500   |
 * | `/api/v1/auth/claim`               | `skipDefaultRegisterRoute` | POST | `Claim.params`              | 200 (idempotent) / 201 (first); 401/403/500                  |
 * | `/api/v1/admin/register-agent`     | only when `skipDefaultRegisterRoute=false` AND `registrationSecret` set | POST | superset of `Register.params` + `ownerUserId` | 200 (rotated) / 201 (new); 400/403/409/500 |
 *
 * All bodied routes funnel through `readValidatedBody` for JSON
 * decode + Ajv validation. Invite-gate checks use `safeEqual`
 * (constant-time) to compare `inviteCode` against
 * `registrationSecret`.
 *
 * The `/api/v1/auth/claim` success path refreshes
 * `conn.auth.ownerUserId` on every live connection of the
 * just-claimed agent so subsequent owner-gated RPCs see fresh state
 * without forcing a reconnect.
 */
export function makeCoreHttpApp(options: CoreHttpAppOptions) {
  const healthRoute = makeHealthRoute(options.connections);
  const registerRoute = makeRegisterRoute(options);
  const claimRoute = makeClaimRoute(options);
  const adminRoute = makeAdminRegisterAgentRoute(options);
  const wsRoute = makeWsRoute(options.handleSocket);
  if (options.config.skipDefaultRegisterRoute) {
    return withCors(
      HttpRouter.empty.pipe(healthRoute, wsRoute),
      options.config.corsOrigins,
    );
  }
  if (options.config.registrationSecret !== undefined) {
    return withCors(
      HttpRouter.empty.pipe(
        healthRoute,
        registerRoute,
        claimRoute,
        adminRoute,
        wsRoute,
      ),
      options.config.corsOrigins,
    );
  }
  return withCors(
    HttpRouter.empty.pipe(healthRoute, registerRoute, claimRoute, wsRoute),
    options.config.corsOrigins,
  );
}

function makeHealthRoute(connections: ResolvedServices["connections"]) {
  return HttpRouter.get(
    "/health",
    Effect.sync(() =>
      HttpServerResponse.unsafeJson({
        status: "ok",
        connections: connections.size,
      }),
    ),
  );
}

function makeRegisterRoute(options: CoreHttpAppOptions) {
  return HttpRouter.post(
    "/api/v1/auth/register",
    handleEarlyResponse(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* readValidatedBody(request, Register.validateParams);
        yield* authorizeInviteCode(
          body.inviteCode,
          options.config.registrationSecret,
        );
        return yield* registerAgent(request, body, options);
      }).pipe(Effect.withSpan("http.auth.register")),
    ),
  );
}

function makeClaimRoute(options: CoreHttpAppOptions) {
  return HttpRouter.post(
    "/api/v1/auth/claim",
    handleEarlyResponse(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* readValidatedBody(request, Claim.validateParams);
        yield* authorizeInviteCode(
          body.inviteCode,
          options.config.registrationSecret,
        );
        const exit = yield* Effect.exit(
          options.authService.claimAgent({
            claimToken: body.claimToken,
            ownerUserId: body.ownerUserId,
          }),
        );
        return yield* handleClaimExit(exit, options.connections);
      }).pipe(Effect.withSpan("http.auth.claim")),
    ),
  );
}

function makeAdminRegisterAgentRoute(options: CoreHttpAppOptions) {
  return HttpRouter.post(
    "/api/v1/admin/register-agent",
    handleEarlyResponse(
      Effect.gen(function* () {
        const registrationSecret = options.config.registrationSecret;
        if (registrationSecret === undefined) return adminUnavailableResponse();
        const request = yield* HttpServerRequest.HttpServerRequest;
        const payload = yield* readAdminRegisterPayload(request);
        yield* authorizeRequiredInviteCode(
          payload.registerBody.inviteCode,
          registrationSecret,
        );
        return yield* upsertAdminAgent(payload, options);
      }).pipe(Effect.withSpan("http.admin.registerAgent")),
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

function readValidatedBody<T>(
  request: HttpServerRequest.HttpServerRequest,
  validator: (value: unknown) => value is T,
): Effect.Effect<T, HttpEarlyResponse> {
  return Effect.gen(function* () {
    const body = yield* readJsonBody(request);
    if (!validator(body)) {
      return yield* failResponse<T>(invalidParametersResponse());
    }
    return body;
  }).pipe(Effect.withSpan("http.readValidatedBody"));
}

function readAdminRegisterPayload(
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<AdminRegisterPayload, HttpEarlyResponse> {
  return Effect.gen(function* () {
    const decoded = yield* readJsonRecord(request);
    const splitBody = splitAdminRegisterBody(decoded);
    const registerBody = splitBody.registerBody;
    if (!Register.validateParams(registerBody)) {
      return yield* failResponse<AdminRegisterPayload>(
        invalidParametersResponse(),
      );
    }
    const ownerUserId = yield* validateOwnerUserId(splitBody.ownerUserIdRaw);
    return {
      registerBody,
      ownerUserId,
    };
  }).pipe(Effect.withSpan("http.readAdminRegisterPayload"));
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

function registerAgent(
  request: HttpServerRequest.HttpServerRequest,
  body: RegisterParams,
  options: CoreHttpAppOptions,
) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      options.authService.registerAgent(body, options.config.devModeUserId),
    );
    if (Exit.isSuccess(exit))
      return registerSuccessResponse(request, exit.value);
    yield* Effect.logError("Registration failed").pipe(
      Effect.annotateLogs({ cause: Cause.pretty(exit.cause) }),
    );
    return registrationFailedResponse();
  }).pipe(Effect.withSpan("http.registerAgent"));
}

function handleClaimExit(
  exit: Exit.Exit<ClaimAgentResult, never>,
  connections: ResolvedServices["connections"],
) {
  return Effect.gen(function* () {
    if (Exit.isFailure(exit)) {
      yield* Effect.logError("Claim failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(exit.cause) }),
      );
      return jsonResponse(
        { error: "Claim failed" },
        HTTP_INTERNAL_SERVER_ERROR,
      );
    }
    return handleClaimResult(exit.value, connections);
  }).pipe(Effect.withSpan("http.handleClaimExit"));
}

function handleClaimResult(
  result: ClaimAgentResult,
  connections: ResolvedServices["connections"],
) {
  switch (result._tag) {
    case CLAIM_SUCCESS:
      refreshClaimedConnections(
        connections,
        result.agentId,
        result.ownerUserId,
      );
      return jsonResponse(
        { agentId: result.agentId, ownerUserId: result.ownerUserId },
        result.alreadyClaimed ? HTTP_OK : HTTP_CREATED,
      );
    case CLAIM_NOT_FOUND:
      return jsonResponse(
        { error: "Invalid claim token", code: CLAIM_NOT_FOUND },
        HTTP_UNAUTHORIZED,
      );
    case CLAIM_OWNER_MISMATCH:
      return jsonResponse(
        {
          error: "Agent already claimed by a different owner",
          code: CLAIM_OWNER_MISMATCH,
        },
        HTTP_FORBIDDEN,
      );
  }
}

function upsertAdminAgent(
  payload: AdminRegisterPayload,
  options: CoreHttpAppOptions,
) {
  return Effect.gen(function* () {
    const ownerUserId = payload.ownerUserId ?? options.config.devModeUserId;
    const exit = yield* Effect.exit(
      options.authService.upsertAgent(payload.registerBody, ownerUserId),
    );
    if (Exit.isFailure(exit)) {
      yield* Effect.logError("Admin upsert failed").pipe(
        Effect.annotateLogs({ cause: Cause.pretty(exit.cause) }),
      );
      return registrationFailedResponse();
    }
    const result = exit.value;
    if ("_tag" in result) {
      return jsonResponse(
        { error: "Registration conflict", code: "REGISTRATION_CONFLICT" },
        HTTP_CONFLICT,
      );
    }
    return jsonResponse(
      { agentId: result.agentId, apiKey: result.apiKey },
      result.rotated ? HTTP_OK : HTTP_CREATED,
    );
  }).pipe(Effect.withSpan("http.upsertAdminAgent"));
}

function splitAdminRegisterBody(body: Record<string, unknown>) {
  const registerBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "ownerUserId") registerBody[key] = value;
  }
  return { ownerUserIdRaw: body["ownerUserId"], registerBody };
}

function validateOwnerUserId(
  raw: unknown,
): Effect.Effect<string | undefined, HttpEarlyResponse> {
  if (raw === undefined) return Effect.succeed(undefined);
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    return failResponse(
      jsonResponse({ error: "ownerUserId must be a UUID" }, HTTP_BAD_REQUEST),
    );
  }
  return Effect.succeed(raw);
}

function authorizeInviteCode(
  inviteCode: string | undefined,
  secret: string | undefined,
): Effect.Effect<void, HttpEarlyResponse> {
  if (secret === undefined) return Effect.void;
  if (inviteCode === undefined)
    return failResponse(invalidInviteCodeResponse());
  if (safeEqual(inviteCode, secret)) return Effect.void;
  return failResponse(invalidInviteCodeResponse());
}

function authorizeRequiredInviteCode(
  inviteCode: string | undefined,
  secret: string,
): Effect.Effect<void, HttpEarlyResponse> {
  if (inviteCode === undefined)
    return failResponse(invalidInviteCodeResponse());
  if (safeEqual(inviteCode, secret)) return Effect.void;
  return failResponse(invalidInviteCodeResponse());
}

function refreshClaimedConnections(
  connections: ResolvedServices["connections"],
  agentId: string,
  ownerUserId: string,
): void {
  for (const conn of connections.getByAgent(agentId)) {
    if (conn.auth === null) continue;
    conn.auth = {
      ...conn.auth,
      ownerUserId: ownerUserId as AuthenticatedContext["ownerUserId"],
    };
  }
}

function registerSuccessResponse(
  request: HttpServerRequest.HttpServerRequest,
  result: RegisterAgentSuccess,
) {
  const { agentId, apiKey, claimToken } = result;
  const host = request.headers["host"] ?? "localhost";
  const proto = forwardedProto(request);
  return jsonResponse(
    {
      agentId,
      apiKey,
      claimToken,
      claimUrl: `${proto}://${host}/api/v1/auth/claim`,
    },
    HTTP_CREATED,
  );
}

function forwardedProto(request: HttpServerRequest.HttpServerRequest): string {
  const forwarded = request.headers["x-forwarded-proto"];
  if (forwarded === undefined) return "http";
  const first = forwarded.split(",")[0] ?? "";
  const proto = first.trim();
  return proto === "" ? "http" : proto;
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

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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

function adminUnavailableResponse() {
  return jsonResponse(
    { error: "Admin registration unavailable" },
    HTTP_NOT_FOUND,
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
