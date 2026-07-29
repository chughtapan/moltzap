import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { Data, Effect, Either, Schema } from "effect";
import { register } from "@moltzap/protocol/identity";
import type { ResultOf } from "@moltzap/protocol/rpc";

/**
 * HTTP response from the agent registration endpoints
 * (`/api/v1/auth/register`).
 */
export type RegisterResponse = ResultOf<typeof register>;

/** Options for {@link registerAgent}. */
export interface RegisterAgentOptions {
  description?: string;
  inviteCode?: string;
}

const PUBLIC_PATH = "/api/v1/auth/register";
const HTTP_SUCCESS_STATUS_MIN = 200;
const HTTP_REDIRECT_STATUS_MIN = 300;
const decodeRegisterBody = Schema.decodeUnknown(register.paramsSchema);
const encodeRegisterBody = Schema.encode(register.paramsSchema);
const decodeRegisterResult = Schema.decodeUnknown(register.resultSchema);

export class RegisterAgentError extends Data.TaggedError("RegisterAgentError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const registerAgentError = (
  message: string,
  cause?: unknown,
): RegisterAgentError => new RegisterAgentError({ message, cause });

/**
 * Register a new agent via HTTP. Thin wrapper around the agent-registration
 * endpoints — the WebSocket dance is `MoltZapAgentClient`'s job; this just
 * returns the credentials the caller feeds it as `agentKey` at construction.
 *
 * Uses the public `/api/v1/auth/register` endpoint. Server boot policy owns
 * the registered agent immediately and returns the credential once.
 */
export const registerAgent = (
  baseUrl: string,
  name: string,
  opts: RegisterAgentOptions = {},
): Effect.Effect<RegisterResponse, RegisterAgentError> =>
  registerAgentRequest(baseUrl, name, opts).pipe(
    Effect.provide(NodeHttpClient.layer),
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (cause) =>
          Effect.fail(
            cause instanceof RegisterAgentError
              ? cause
              : registerAgentError("Register request failed", cause),
          ),
        onRight: (value) => Effect.succeed(value),
      }),
    ),
    Effect.withSpan("registerAgent"),
  );

function registerAgentRequest(
  baseUrl: string,
  name: string,
  opts: RegisterAgentOptions,
): Effect.Effect<RegisterResponse, RegisterAgentError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const body = yield* registerAgentBody(name, opts);
    const request = registerHttpRequest(baseUrl, PUBLIC_PATH, body);
    const response = yield* client
      .execute(request)
      .pipe(
        Effect.mapError((cause) =>
          registerAgentError("Register request failed", cause),
        ),
      );
    return yield* isSuccessStatus(response.status)
      ? decodeRegisterResponse(response)
      : failRegisterStatus(response);
  });
}

function registerAgentBody(
  name: string,
  opts: RegisterAgentOptions,
): Effect.Effect<unknown, RegisterAgentError> {
  return decodeRegisterBody({
    name,
    ...(opts?.description !== undefined
      ? { description: opts.description }
      : {}),
    ...(opts?.inviteCode !== undefined ? { inviteCode: opts.inviteCode } : {}),
  }).pipe(
    Effect.flatMap(encodeRegisterBody),
    Effect.mapError((cause) =>
      registerAgentError("Register request body decode failed", cause),
    ),
  );
}

function registerHttpRequest(baseUrl: string, path: string, body: unknown) {
  return HttpClientRequest.post(`${baseUrl}${path}`).pipe(
    HttpClientRequest.setHeader("Content-Type", "application/json"),
    HttpClientRequest.bodyUnsafeJson(body),
  );
}

function isSuccessStatus(status: number): boolean {
  return status >= HTTP_SUCCESS_STATUS_MIN && status < HTTP_REDIRECT_STATUS_MIN;
}

function failRegisterStatus(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<never, RegisterAgentError> {
  return Effect.gen(function* () {
    const text = yield* decodeResponseText(response);
    return yield* Effect.fail(
      registerAgentError(`Register failed: ${response.status} ${text}`),
    );
  });
}

function decodeResponseText(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string, RegisterAgentError> {
  return response.text.pipe(
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (cause) =>
          Effect.fail(
            registerAgentError("Register error response read failed", cause),
          ),
        onRight: Effect.succeed,
      }),
    ),
  );
}

function decodeRegisterResponse(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<RegisterResponse, RegisterAgentError> {
  return response.json.pipe(
    Effect.either,
    Effect.flatMap(
      Either.match({
        onLeft: (cause) =>
          Effect.fail(
            registerAgentError("Register response decode failed", cause),
          ),
        onRight: (value) =>
          decodeRegisterResult(value).pipe(
            Effect.mapError((cause) =>
              registerAgentError("Register response decode failed", cause),
            ),
          ),
      }),
    ),
  );
}
