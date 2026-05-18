import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform";
import { NodeHttpServer } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { Effect, Exit, Ref } from "effect";
import { describe, expect } from "vitest";
import { registerAgent } from "./auth.js";

const it = effectIt.scoped;

interface CapturedCall {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

interface StubResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

type StubResponder = (path: string) => StubResponse;

const ADMIN_REGISTER_PATH = "/api/v1/admin/register-agent";
const PUBLIC_REGISTER_PATH = "/api/v1/auth/register";
const POST_METHOD = "POST";
const CREATED_STATUS = 201;
const FORBIDDEN_STATUS = 403;
const SINGLE_CALL_COUNT = 1;
const LOCALHOST = "127.0.0.1";
const LOCAL_HTTP_SCHEME = "http";
const JSON_CONTENT_TYPE = "application/json";
const TEXT_CONTENT_TYPE = "text/plain";
const TEST_AGENT_NAME = "test";
const INVITE_CODE = "secret";
const OWNER_USER_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "agent-id";
const API_KEY = "api-key";
const CLAIM_URL = "https://example.test/claim";
const CLAIM_TOKEN = "claim-token";
const INVITE_REQUIRED_BODY = "invite required";

const defaultRegisterResponse = (): StubResponse => ({
  status: CREATED_STATUS,
  contentType: JSON_CONTENT_TYPE,
  body: JSON.stringify({
    agentId: AGENT_ID,
    apiKey: API_KEY,
    claimUrl: CLAIM_URL,
    claimToken: CLAIM_TOKEN,
  }),
});

const forbiddenResponse = (): StubResponse => ({
  status: FORBIDDEN_STATUS,
  contentType: TEXT_CONTENT_TYPE,
  body: INVITE_REQUIRED_BODY,
});

const localBaseUrl = (port: number): string =>
  `${LOCAL_HTTP_SCHEME}://${LOCALHOST}:${port}`;

const requestBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.catchAll(() => Effect.succeed(undefined)));

const appendCapturedCall = (
  calls: Ref.Ref<ReadonlyArray<CapturedCall>>,
  call: CapturedCall,
) => Ref.update(calls, (current) => [...current, call]);

const responseFromStub = (response: StubResponse) =>
  HttpServerResponse.text(response.body, {
    status: response.status,
    contentType: response.contentType,
  });

const routeHandler = (
  path: string,
  calls: Ref.Ref<ReadonlyArray<CapturedCall>>,
  responder: StubResponder,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* requestBody(request);
    yield* appendCapturedCall(calls, {
      path,
      method: request.method,
      body,
    });
    return responseFromStub(responder(path));
  });

const makeRegisterServer = (
  responder: StubResponder = defaultRegisterResponse,
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<CapturedCall>>([]);
    const adminRoute = HttpRouter.post(
      ADMIN_REGISTER_PATH,
      routeHandler(ADMIN_REGISTER_PATH, calls, responder),
    );
    const publicRoute = HttpRouter.post(
      PUBLIC_REGISTER_PATH,
      routeHandler(PUBLIC_REGISTER_PATH, calls, responder),
    );

    yield* HttpServer.serveEffect(
      HttpRouter.empty.pipe(adminRoute, publicRoute),
    );
    const address = yield* HttpServer.addressWith((serverAddress) =>
      Effect.succeed(serverAddress),
    );
    if (address._tag !== "TcpAddress") {
      return yield* Effect.dieMessage(`expected TCP address: ${address._tag}`);
    }
    return { baseUrl: localBaseUrl(address.port), calls };
  });

const expectSingleCall = (calls: ReadonlyArray<CapturedCall>): CapturedCall => {
  expect(calls).toHaveLength(SINGLE_CALL_COUNT);
  const [call] = calls;
  expect(call).toBeDefined();
  return call ?? { path: "", method: "", body: undefined };
};

function postsOwnerUserIdToAdminEndpoint() {
  return Effect.gen(function* () {
    const server = yield* makeRegisterServer();
    const result = yield* registerAgent(server.baseUrl, TEST_AGENT_NAME, {
      inviteCode: INVITE_CODE,
      ownerUserId: OWNER_USER_ID,
    });

    const call = expectSingleCall(yield* Ref.get(server.calls));
    expect(call.path).toBe(ADMIN_REGISTER_PATH);
    expect(call.method).toBe(POST_METHOD);
    expect(call.body).toEqual({
      name: TEST_AGENT_NAME,
      inviteCode: INVITE_CODE,
      ownerUserId: OWNER_USER_ID,
    });
    expect(result.agentId).toBe(AGENT_ID);
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.orDie);
}

function postsToPublicEndpointWithoutOwnerUserId() {
  return Effect.gen(function* () {
    const server = yield* makeRegisterServer();

    yield* registerAgent(server.baseUrl, TEST_AGENT_NAME, {
      inviteCode: INVITE_CODE,
    });

    const call = expectSingleCall(yield* Ref.get(server.calls));
    expect(call.path).toBe(PUBLIC_REGISTER_PATH);
    expect(call.body).toEqual({
      name: TEST_AGENT_NAME,
      inviteCode: INVITE_CODE,
    });
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.orDie);
}

function nonSuccessResponseFails() {
  return Effect.gen(function* () {
    const server = yield* makeRegisterServer(() => forbiddenResponse());

    const exit = yield* Effect.exit(
      registerAgent(server.baseUrl, TEST_AGENT_NAME, {
        ownerUserId: OWNER_USER_ID,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  }).pipe(Effect.provide(NodeHttpServer.layerTest), Effect.orDie);
}

describe("registerAgent", () => {
  it(
    "posts ownerUserId in the body to the admin endpoint",
    postsOwnerUserIdToAdminEndpoint,
  );

  it(
    "posts to the public endpoint without ownerUserId when absent",
    postsToPublicEndpointWithoutOwnerUserId,
  );

  it(
    "fails when the server returns a non-2xx response",
    nonSuccessResponseFails,
  );
});
