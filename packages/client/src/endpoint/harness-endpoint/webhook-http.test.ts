/** @file The private callback transport bounds unauthenticated work before semantic processing. */

import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { Deferred, Effect, Fiber, TestClock, TestContext } from "effect";
import { describe, expect, it } from "vitest";
import { maximumEventBytes } from "../event-contract/index.js";
import { acquireCallbackServer } from "./webhook-http.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- HTTP statuses and exact callback bodies are transport contract expectations. */

const rejectedRequests = [
  {
    path: "/mcp",
    method: "POST",
    contentType: "application/json",
    body: "{}",
    status: 404,
  },
  {
    path: "/events?wrong=route",
    method: "POST",
    contentType: "application/json",
    body: "{}",
    status: 404,
  },
  {
    path: "/events",
    method: "GET",
    contentType: "application/json",
    body: undefined,
    status: 405,
  },
  {
    path: "/events",
    method: "POST",
    contentType: "text/plain",
    body: "{}",
    status: 400,
  },
  {
    path: "/events",
    method: "POST",
    contentType: "application/json",
    body: new Uint8Array([255]),
    status: 400,
  },
  {
    path: "/events",
    method: "POST",
    contentType: "application/json",
    body: "x".repeat(maximumEventBytes + 1),
    status: 413,
  },
] as const;

describe("native callback HTTP listener", () => {
  it("serves a scoped callback without management authority", servesCallback);
  it(
    "refuses and interrupts a handoff that exceeds the callback deadline",
    boundsHandoff,
  );
  it.each(rejectedRequests)(
    "rejects $method $path with $status before semantic processing",
    rejectsRequest,
  );
});

function boundsHandoff() {
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<undefined>();
    const stopped = yield* Deferred.make<undefined>();
    const port = yield* acquireCallbackServer({
      port: 0,
      path: "/events",
      handle: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
    });
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(
        HttpClientRequest.post(`http://127.0.0.1:${String(port)}/events`).pipe(
          HttpClientRequest.bodyText("{}", "application/json"),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("4 seconds");
    expect((yield* Fiber.join(response)).status).toBe(503);
    yield* Deferred.await(stopped);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeHttpClient.layer),
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );
}

function servesCallback() {
  return Effect.gen(function* () {
    const port = yield* acquireCallbackServer({
      port: 0,
      path: "/events",
      handle: ({ body }) => Effect.succeed({ status: 200, body }),
    });
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.post(`http://127.0.0.1:${String(port)}/events`).pipe(
        HttpClientRequest.bodyText("{}", "application/json"),
      ),
    );
    expect(response.status).toBe(200);
    expect(yield* response.text).toBe("{}");
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeHttpClient.layer),
    Effect.runPromise,
  );
}

function rejectsRequest({
  path,
  method,
  contentType,
  body,
  status,
}: (typeof rejectedRequests)[number]) {
  return Effect.gen(function* () {
    let calls = 0;
    const port = yield* acquireCallbackServer({
      port: 0,
      path: "/events",
      handle: () =>
        Effect.sync(() => {
          calls += 1;
          return { status: 200, body: "{}" };
        }),
    });
    const http = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.make(method)(
      `http://127.0.0.1:${String(port)}${path}`,
    ).pipe(HttpClientRequest.setHeader("content-type", contentType));
    const response = yield* http.execute(withBody(request, contentType, body));
    expect(response.status).toBe(status);
    expect(calls).toBe(0);
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeHttpClient.layer),
    Effect.runPromise,
  );
}

function withBody(
  request: HttpClientRequest.HttpClientRequest,
  contentType: string,
  body?: string | Uint8Array,
) {
  if (body === undefined) {
    return request;
  }
  return typeof body === "string"
    ? HttpClientRequest.bodyText(request, body, contentType)
    : HttpClientRequest.bodyUint8Array(request, body, contentType);
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- The status-contract expectations above are complete. */
