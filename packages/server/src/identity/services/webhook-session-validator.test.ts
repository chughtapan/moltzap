/** Tests for the webhook-backed SessionValidator adapter. */

import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import * as fc from "fast-check";
import { describe, expect } from "vitest";
import { WebhookSessionValidator } from "./webhook-session-validator.js";
import type { SessionValidation } from "./session-validator.js";

const it = effectIt.effect;

const URL = "https://hook.test/sessions/validate";
const TOKEN = "tok-deadbeef";
const TIMEOUT_MS = 1_000;
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const POST_METHOD = "POST";
const SESSIONS_VALIDATE_EVENT = "sessions.validate";
const ECONNREFUSED_DESCRIPTION = "ECONNREFUSED";
const VALID_AGENT_ID = "agent-1";
const VALID_OWNER_USER_ID = "user-1";
const AGENT_STATUS_ACTIVE = "active";

const FAIL_CLOSED: SessionValidation = { valid: false };

interface CapturedRequest {
  url: string;
  method: string;
  event: string;
  bodyText: string;
}

type Verdict =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "ok-raw"; status: number; raw: string }
  | { kind: "transport-fail"; description: string };

function fakeClient(
  captured: { last: CapturedRequest | null },
  handler: (req: CapturedRequest) => Verdict,
): HttpClient.HttpClient {
  return HttpClient.make((request) =>
    handleFakeRequest(request, captured, handler),
  );
}

function handleFakeRequest(
  request: HttpClientRequest.HttpClientRequest,
  captured: { last: CapturedRequest | null },
  handler: (req: CapturedRequest) => Verdict,
) {
  return Effect.gen(function* () {
    const bodyText = yield* extractBodyText(request);
    const event = request.headers["x-moltzap-event"] ?? "";
    const captured_: CapturedRequest = {
      url: request.url,
      method: request.method,
      event,
      bodyText,
    };
    captured.last = captured_;
    return yield* renderVerdict(request, handler(captured_));
  });
}

function renderVerdict(
  request: HttpClientRequest.HttpClientRequest,
  verdict: Verdict,
) {
  if (verdict.kind === "transport-fail") {
    return Effect.fail(
      new HttpClientError.RequestError({
        request,
        reason: "Transport",
        description: verdict.description,
      }),
    );
  }
  const raw =
    verdict.kind === "ok-raw" ? verdict.raw : JSON.stringify(verdict.body);
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(raw, { status: verdict.status }),
    ),
  );
}

function extractBodyText(
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<string> {
  const body = request.body;
  if (body._tag === "Raw") return Effect.succeed(String(body.body));
  if (body._tag === "Uint8Array") {
    return Effect.succeed(new TextDecoder().decode(body.body));
  }
  return Effect.succeed("");
}

function makeValidator(handler: (req: CapturedRequest) => Verdict) {
  const captured = { last: null as CapturedRequest | null };
  const validator = new WebhookSessionValidator(
    fakeClient(captured, handler),
    URL,
    TIMEOUT_MS,
  );
  return { validator, captured };
}

function sendsExpectedWireShape() {
  return Effect.gen(function* () {
    const { validator, captured } = makeValidator(() => ({
      kind: "ok",
      status: HTTP_OK,
      body: { valid: false },
    }));
    yield* validator.validateSession(TOKEN);
    expect(captured.last?.url).toBe(URL);
    expect(captured.last?.method).toBe(POST_METHOD);
    expect(captured.last?.event).toBe(SESSIONS_VALIDATE_EVENT);
    expect(JSON.parse(captured.last?.bodyText ?? "{}")).toEqual({
      token: TOKEN,
    });
  });
}

function returnsValidMinimalResponse() {
  return Effect.gen(function* () {
    const { validator } = makeValidator(() => ({
      kind: "ok",
      status: HTTP_OK,
      body: {
        valid: true,
        agentId: VALID_AGENT_ID,
        ownerUserId: VALID_OWNER_USER_ID,
      },
    }));
    const result = yield* validator.validateSession(TOKEN);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.agentId).toBe(VALID_AGENT_ID);
      expect(result.ownerUserId).toBe(VALID_OWNER_USER_ID);
      expect(result.agentStatus).toBeUndefined();
    }
  });
}

function propagatesAgentStatusWhenPresent() {
  return Effect.gen(function* () {
    const { validator } = makeValidator(() => ({
      kind: "ok",
      status: HTTP_OK,
      body: {
        valid: true,
        agentId: VALID_AGENT_ID,
        ownerUserId: VALID_OWNER_USER_ID,
        agentStatus: AGENT_STATUS_ACTIVE,
      },
    }));
    const result = yield* validator.validateSession(TOKEN);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.agentStatus).toBe(AGENT_STATUS_ACTIVE);
    }
  });
}

function returnsInvalidOnExplicitFalse() {
  return Effect.gen(function* () {
    const { validator } = makeValidator(() => ({
      kind: "ok",
      status: HTTP_OK,
      body: { valid: false },
    }));
    expect(yield* validator.validateSession(TOKEN)).toEqual(FAIL_CLOSED);
  });
}

function failsClosedOnNon2xx() {
  return Effect.gen(function* () {
    const { validator } = makeValidator(() => ({
      kind: "ok",
      status: HTTP_FORBIDDEN,
      body: {
        valid: true,
        agentId: VALID_AGENT_ID,
        ownerUserId: VALID_OWNER_USER_ID,
      },
    }));
    expect(yield* validator.validateSession(TOKEN)).toEqual(FAIL_CLOSED);
  });
}

function failsClosedOnMalformedJson() {
  return Effect.gen(function* () {
    const { validator } = makeValidator(() => ({
      kind: "ok-raw",
      status: HTTP_OK,
      raw: "not-json",
    }));
    expect(yield* validator.validateSession(TOKEN)).toEqual(FAIL_CLOSED);
  });
}

function failsClosedOnIncompleteValidResponse() {
  return Effect.gen(function* () {
    const { validator } = makeValidator(() => ({
      kind: "ok",
      status: HTTP_OK,
      body: { valid: true },
    }));
    expect(yield* validator.validateSession(TOKEN)).toEqual(FAIL_CLOSED);
  });
}

function failsClosedOnTransportFailure() {
  return Effect.gen(function* () {
    const { validator } = makeValidator(() => ({
      kind: "transport-fail",
      description: ECONNREFUSED_DESCRIPTION,
    }));
    expect(yield* validator.validateSession(TOKEN)).toEqual(FAIL_CLOSED);
  });
}

const HTTP_NON_2XX_STATUS_MIN = 300;
const HTTP_NON_2XX_STATUS_MAX = 599;
const FAILURE_PROPERTY_RUNS = 64;
// Web `Response` constructor rejects body-disallowed statuses; the
// failure-space arbitrary excludes them so we exercise the SUT, not the
// test harness's response builder.
const NULL_BODY_STATUSES = new Set<number>([204, 205, 304]);

/** Arbitrary covering the entire universe of remote failure modes. */
const remoteFailureArb: fc.Arbitrary<Verdict> = fc.oneof(
  // Arbitrary non-2xx status with arbitrary body bytes.
  fc.record({
    kind: fc.constant<"ok-raw">("ok-raw"),
    status: fc
      .integer({
        min: HTTP_NON_2XX_STATUS_MIN,
        max: HTTP_NON_2XX_STATUS_MAX,
      })
      .filter((s) => !NULL_BODY_STATUSES.has(s)),
    raw: fc.string(),
  }),
  // 2xx with non-JSON body bytes.
  fc.record({
    kind: fc.constant<"ok-raw">("ok-raw"),
    status: fc.constant(HTTP_OK),
    raw: fc
      .string()
      .filter(
        (s) => !/^\s*(?:true|false|null|\d|"|\{|\[)/.test(s) || s.includes(" "),
      ),
  }),
  // 2xx with a JSON body that does not match the schema union.
  fc.record({
    kind: fc.constant<"ok">("ok"),
    status: fc.constant(HTTP_OK),
    body: fc.oneof(
      fc.constant(null),
      fc.constant([]),
      fc.record({ wrong: fc.string() }),
      fc.record({ valid: fc.string() }),
      // `valid: true` missing required fields.
      fc.record({ valid: fc.constant(true) }),
      fc.record({ valid: fc.constant(true), agentId: fc.string() }),
    ),
  }),
  // Transport failures with arbitrary descriptions.
  fc.record({
    kind: fc.constant<"transport-fail">("transport-fail"),
    description: fc.string(),
  }),
);

function checkFailClosedFor(verdict: Verdict): Effect.Effect<void> {
  const { validator } = makeValidator(() => verdict);
  return validator.validateSession(TOKEN).pipe(
    Effect.flatMap((result) =>
      Effect.sync(() => {
        expect(result).toEqual(FAIL_CLOSED);
      }),
    ),
  );
}

describe("WebhookSessionValidator.validateSession wire shape", () => {
  it("sends POST {token} with X-MoltZap-Event header", () =>
    sendsExpectedWireShape());
});

describe("WebhookSessionValidator.validateSession success branches", () => {
  it("returns valid with agentId+ownerUserId on minimal valid response", () =>
    returnsValidMinimalResponse());

  it("propagates optional agentStatus when present", () =>
    propagatesAgentStatusWhenPresent());

  it("returns invalid when remote responds with valid:false", () =>
    returnsInvalidOnExplicitFalse());
});

describe("WebhookSessionValidator.validateSession fail-closed semantics", () => {
  it("returns invalid on non-2xx HTTP response", () => failsClosedOnNon2xx());

  it("returns invalid when response body is malformed JSON", () =>
    failsClosedOnMalformedJson());

  it("returns invalid when valid:true response is missing required fields", () =>
    failsClosedOnIncompleteValidResponse());

  it("returns invalid on transport failure", () =>
    failsClosedOnTransportFailure());

  /**
   * Property: across the full universe of remote failure modes
   * (arbitrary 4xx/5xx codes, arbitrary non-JSON / schema-mismatched
   * bodies, arbitrary transport errors), `validateSession` ALWAYS
   * returns `{ valid: false }` and NEVER fails. The example tests
   * above pin specific representative shapes; this generative test
   * checks the contract holds over the whole space.
   */
  it("never propagates a failure for any non-2xx / malformed / transport failure", () =>
    Effect.tryPromise({
      try: () =>
        fc.assert(
          fc.asyncProperty(remoteFailureArb, (verdict) =>
            Effect.runPromise(checkFailClosedFor(verdict)),
          ),
          { numRuns: FAILURE_PROPERTY_RUNS },
        ),
      catch: (err) => err,
    }));
});
