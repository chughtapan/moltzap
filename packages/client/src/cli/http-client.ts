import { Data, Effect } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { HttpClientError } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { getHttpUrl, resolveAuth, type CliConfigError } from "./config.js";
import type { Register, ResultOf } from "@moltzap/protocol";

type RegisterResult = ResultOf<typeof Register>;
const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECT_MIN = 300;

export class CliHttpStatusError extends Data.TaggedError("CliHttpStatusError")<{
  readonly status: number;
  readonly responseText: string;
  readonly message: string;
}> {}

/**
 * POST JSON to a MoltZap REST endpoint. Transport failures surface as the
 * typed `HttpClientError` union (`RequestError | ResponseError`); non-2xx
 * responses surface as `CliHttpStatusError`.
 */
function postJson<T>(
  path: string,
  body: unknown,
  opts?: { noAuth?: boolean },
): Effect.Effect<
  T,
  CliConfigError | CliHttpStatusError | HttpClientError.HttpClientError
> {
  return Effect.gen(function* () {
    const baseUrl = yield* getHttpUrl;
    const headers: Record<string, string> = opts?.noAuth
      ? {}
      : { "X-API-Key": (yield* resolveAuth).agentKey };
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.post(`${baseUrl}${path}`).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyUnsafeJson(body),
    );
    const response = yield* client.execute(request);
    if (
      response.status < HTTP_SUCCESS_MIN ||
      response.status >= HTTP_REDIRECT_MIN
    ) {
      const text = yield* response.text;
      return yield* Effect.fail(
        new CliHttpStatusError({
          status: response.status,
          responseText: text,
          message: `HTTP ${response.status}: ${text}`,
        }),
      );
    }
    return (yield* response.json) as T;
  }).pipe(Effect.provide(NodeHttpClient.layer));
}

export function registerAgent(
  name: string,
  inviteCode: string,
  description?: string,
): Effect.Effect<
  RegisterResult,
  CliConfigError | CliHttpStatusError | HttpClientError.HttpClientError
> {
  return postJson<RegisterResult>(
    "/api/v1/auth/register",
    { name, inviteCode, description },
    { noAuth: true },
  );
}
