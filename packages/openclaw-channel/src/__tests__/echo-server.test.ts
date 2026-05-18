import { afterAll, beforeAll, describe, expect } from "vitest";
import { live as it } from "@effect/vitest";
import { Effect } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";

import { startEchoServer, type EchoServer } from "./echo-server.js";

interface EchoCompletionBody {
  readonly id: string;
  readonly created: unknown;
  readonly object: string;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly index: number;
    readonly message: { readonly role: string; readonly content: string };
    readonly finish_reason: string;
  }>;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const LOCALHOST = "http://127.0.0.1";
const JSON_CONTENT_TYPE = "application/json";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const HELLO_WORLD = "hello world";
const MALFORMED_BODY = "not json";
const CHAT_COMPLETION_OBJECT = "chat.completion";
const ECHO_MODEL_ID = "echo-1";
const STOP_FINISH_REASON = "stop";
const CREATED_TYPE = "number";
const CHAT_ID_PATTERN = /^chatcmpl-echo-/;
const CONCURRENT_MESSAGES = ["alpha", "bravo", "charlie", "delta", "echo"];
const CONCURRENT_REQUESTS = CONCURRENT_MESSAGES.length;

let server: EchoServer;

function serverUrl(path: string): string {
  return `${LOCALHOST}:${server.port}${path}`;
}

function echoContent(message: string): string {
  return `ECHO: ${message}`;
}

function startServer(): Effect.Effect<EchoServer, unknown> {
  return Effect.tryPromise({
    try: () => startEchoServer(),
    catch: (cause) => cause,
  });
}

function executeRequest(
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown> {
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(request);
  }).pipe(Effect.provide(NodeHttpClient.layer));
}

function readJson(
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, unknown> {
  return response.json;
}

function postChatCompletion(
  content: string,
): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown> {
  const request = HttpClientRequest.post(serverUrl(CHAT_COMPLETIONS_PATH)).pipe(
    HttpClientRequest.bodyUnsafeJson({
      messages: [{ role: USER_ROLE, content }],
    }),
  );
  return executeRequest(request);
}

function postMalformedBody(): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  unknown
> {
  const request = HttpClientRequest.post(serverUrl(CHAT_COMPLETIONS_PATH)).pipe(
    HttpClientRequest.bodyText(MALFORMED_BODY, JSON_CONTENT_TYPE),
  );
  return executeRequest(request);
}

function fetchCompletionBody(
  content: string,
): Effect.Effect<EchoCompletionBody, unknown> {
  return Effect.gen(function* () {
    const response = yield* postChatCompletion(content);
    return (yield* readJson(response)) as EchoCompletionBody;
  });
}

function returnsOpenAiResponseShape() {
  return Effect.gen(function* () {
    const response = yield* postChatCompletion(HELLO_WORLD);
    expect(response.status).toBe(HTTP_OK);
    const body = (yield* readJson(response)) as EchoCompletionBody;
    expect(body).toMatchObject({
      object: CHAT_COMPLETION_OBJECT,
      model: ECHO_MODEL_ID,
      choices: [
        {
          index: 0,
          message: {
            role: ASSISTANT_ROLE,
            content: echoContent(HELLO_WORLD),
          },
          finish_reason: STOP_FINISH_REASON,
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(body.id).toMatch(CHAT_ID_PATTERN);
    expect(typeof body.created).toBe(CREATED_TYPE);
  });
}

function returnsBadRequestForMalformedBody() {
  return Effect.gen(function* () {
    const response = yield* postMalformedBody();
    expect(response.status).toBe(HTTP_BAD_REQUEST);
    const body = yield* readJson(response);
    expect(body).toMatchObject({ error: expect.any(String) });
  });
}

function returnsNotFoundForWrongEndpoint() {
  return Effect.gen(function* () {
    const response = yield* executeRequest(
      HttpClientRequest.get(serverUrl("/")),
    );
    expect(response.status).toBe(HTTP_NOT_FOUND);
  });
}

function assignsRandomPorts() {
  return Effect.gen(function* () {
    const second = yield* startServer();
    expect(second.port).toBeGreaterThan(0);
    expect(second.port).not.toBe(server.port);
    yield* Effect.sync(() => {
      second.close();
    });
  });
}

function handlesConcurrentRequests() {
  return Effect.gen(function* () {
    const results = yield* Effect.all(
      CONCURRENT_MESSAGES.map(fetchCompletionBody),
      { concurrency: CONCURRENT_REQUESTS },
    );

    for (const [index, message] of CONCURRENT_MESSAGES.entries()) {
      expect(results[index]!.choices[0]!.message.content).toBe(
        echoContent(message),
      );
    }
  });
}

beforeAll(() =>
  Effect.runPromise(
    startServer().pipe(
      Effect.tap((started) =>
        Effect.sync(() => {
          server = started;
        }),
      ),
    ),
  ),
);

afterAll(() => {
  server.close();
});

describe("echo-server response shape", () => {
  it(
    "returns correct OpenAI response shape with ECHO prefix",
    returnsOpenAiResponseShape,
  );
});

describe("echo-server error responses", () => {
  it("returns 400 for malformed body", returnsBadRequestForMalformedBody);
  it("returns 404 for wrong endpoint", returnsNotFoundForWrongEndpoint);
});

describe("echo-server lifecycle and concurrency", () => {
  it("assigns a random port and shuts down cleanly", assignsRandomPorts);
  it("handles concurrent requests correctly", handlesConcurrentRequests);
});
