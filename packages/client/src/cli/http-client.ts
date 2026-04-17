import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { HttpClientError } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { getHttpUrl, resolveAuth } from "./config.js";
import type { Register, Static } from "@moltzap/protocol";

type RegisterResult = Static<typeof Register.resultSchema>;

/**
 * POST JSON to a MoltZap REST endpoint. Transport failures surface as the
 * typed `HttpClientError` union (`RequestError | ResponseError`); non-2xx
 * responses surface as `Error(HTTP <status>: <body>)`.
 */
function postJson<T>(
  path: string,
  body: unknown,
  opts?: { noAuth?: boolean },
): Effect.Effect<T, Error | HttpClientError.HttpClientError> {
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
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text;
      return yield* Effect.fail(new Error(`HTTP ${response.status}: ${text}`));
    }
    return (yield* response.json) as T;
  }).pipe(Effect.provide(NodeHttpClient.layer));
}

export function registerAgent(
  name: string,
  inviteCode: string,
  description?: string,
): Effect.Effect<RegisterResult, Error | HttpClientError.HttpClientError> {
  return postJson<RegisterResult>(
    "/api/v1/auth/register",
    { name, inviteCode, description },
    { noAuth: true },
  );
}
