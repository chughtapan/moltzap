/** @file Native provider acceptance is bounded, reference-only and distinct from model processing. */

import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import {
  Deferred,
  Effect,
  FastCheck as fc,
  Fiber,
  Match,
  Redacted,
  Schema,
  TestClock,
  TestContext,
} from "effect";
import { describe, expect, it } from "vitest";
import type { NativeWakeup } from "./index.js";
import { makeGrokWakeup } from "../grokbot/index.js";
import { makeInstinctWakeup } from "../instinct/index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Provider statuses, minimal payloads and closed failures pin native handoff contracts. */

const work = { eventId: "evt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" };
const sender = {
  apiKey: Redacted.make("private-agentmail-provider-key"),
  inboxId: "dedicated+wakes@agentmail.to",
  recipient: "native@instinct.example",
};
const routine = {
  key: Redacted.make("private-owner-approved-routine-key"),
  url: new URL("https://native.example/approved-routine?owner=stable"),
};
const acceptedEmail = JSON.stringify({
  message_id: "email-1",
  thread_id: "thread-1",
});
const emailBody = Schema.Struct({
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
});
const routineBody = Schema.Struct({
  eventId: Schema.String,
  instruction: Schema.String,
});

describe("native handoff plugins", () => {
  it(
    "uses a dedicated AgentMail sender and sends only a stable work reference",
    sendsEmailReference,
  );
  it(
    "uses the exact owner-approved routine and sends only a stable work reference",
    sendsRoutineReference,
  );
  it(
    "preserves generated event references without acquiring send authority",
    preservesReferences,
  );
  it(
    "keeps the owner's approved routine snapshot when its input URL later changes",
    preservesApproval,
  );
  handoffFailures();
  emailFailures();
  routineAcceptance();
  configurationFailures();
});

function handoffFailures() {
  it.each([
    { wake: makeInstinctWakeup(sender), name: "email", status: 400 },
    { wake: makeInstinctWakeup(sender), name: "email", status: 403 },
    { wake: makeInstinctWakeup(sender), name: "email", status: 429 },
    { wake: makeInstinctWakeup(sender), name: "email", status: 201 },
    { wake: makeGrokWakeup(routine), name: "routine", status: 301 },
    { wake: makeGrokWakeup(routine), name: "routine", status: 503 },
  ])(
    "retains work after $name refuses $status, without retrying",
    refusesHandoff,
  );
  it.each([
    { wake: makeInstinctWakeup(sender), name: "email" },
    { wake: makeGrokWakeup(routine), name: "routine" },
  ])(
    "bounds and interrupts uncertain $name handoff without retrying",
    boundsHandoff,
  );
  it(
    "closes provider transport failures without leaking diagnostics",
    closesTransportError,
  );
}

function emailFailures() {
  it.each([
    { body: "{}" },
    { body: JSON.stringify({ message_id: "email-1" }) },
    { body: JSON.stringify({ message_id: "", thread_id: "thread-1" }) },
    { body: "not JSON: private-agentmail-provider-key" },
    { body: "x".repeat(16 * 1024 + 1) },
    { body: new Uint8Array([255]) },
  ])("requires a bounded, valid provider message identity", rejectsEmailBody);
}

function routineAcceptance() {
  it.each([200, 201, 202, 204])(
    "accepts routine HTTP %s as handoff only",
    acceptsRoutine,
  );
}

function configurationFailures() {
  it.each([
    makeInstinctWakeup({ ...sender, recipient: "not-an-email" }),
    makeInstinctWakeup({ ...sender, apiKey: Redacted.make("") }),
    makeInstinctWakeup({ ...sender, inboxId: "" }),
    makeGrokWakeup({ ...routine, key: Redacted.make("") }),
    makeGrokWakeup({
      ...routine,
      url: new URL("http://native.example/routine"),
    }),
    makeGrokWakeup({
      ...routine,
      url: new URL("https://user:password@native.example/routine"),
    }),
    makeGrokWakeup({
      ...routine,
      url: new URL("https://native.example/routine#fragment"),
    }),
  ])(
    "refuses invalid native configuration before making any request",
    refusesConfiguration,
  );
}

function sendsEmailReference() {
  const fixture = responseFixture(acceptedEmail, 200);
  return Effect.gen(function* () {
    yield* makeInstinctWakeup(sender)(work);
    const request = fixture.requests[0];
    expect(request).toBeDefined();
    if (!request) {
      return yield* Effect.dieMessage("missing provider request");
    }
    expect(request.url).toBe(
      "https://api.agentmail.to/v0/inboxes/dedicated%2Bwakes%40agentmail.to/messages/send",
    );
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(
      `Bearer ${Redacted.value(sender.apiKey)}`,
    );
    const raw = yield* requestBody(request);
    const body = yield* Schema.decodeUnknown(emailBody)(raw);
    expect(raw).toEqual({
      to: [sender.recipient],
      subject: `MoltZap work: ${work.eventId}`,
      text: body.text,
    });
    expect(body.text).toContain(`MoltZap event ${work.eventId}`);
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.signals[0]?.aborted).toBe(true);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, fixture.http),
    Effect.runPromise,
  );
}

function sendsRoutineReference() {
  const fixture = responseFixture(null, 202);
  return Effect.gen(function* () {
    yield* makeGrokWakeup(routine)(work);
    const request = fixture.requests[0];
    if (!request) {
      return yield* Effect.dieMessage("missing provider request");
    }
    expect(fixture.urls).toEqual([routine.url.href]);
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(
      `Bearer ${Redacted.value(routine.key)}`,
    );
    const raw = yield* requestBody(request);
    const body = yield* Schema.decodeUnknown(routineBody)(raw);
    expect(raw).toEqual({
      eventId: work.eventId,
      instruction: body.instruction,
    });
    expect(body.instruction).toContain("read_event");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.signals[0]?.aborted).toBe(true);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, fixture.http),
    Effect.runPromise,
  );
}

function preservesReferences() {
  return fc.assert(
    fc.asyncProperty(fc.string({ minLength: 1, maxLength: 100 }), (eventId) => {
      const fixture = responseFixture(null, 202);
      return Effect.gen(function* () {
        yield* makeGrokWakeup(routine)({ eventId });
        const request = fixture.requests[0];
        if (!request) {
          return yield* Effect.dieMessage("missing provider request");
        }
        const raw = yield* requestBody(request);
        const body = yield* Schema.decodeUnknown(routineBody)(raw);
        expect(raw).toEqual({
          eventId,
          instruction: body.instruction,
        });
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.http),
        Effect.runPromise,
      );
    }),
    { numRuns: 30 },
  );
}

function refusesHandoff({
  wake,
  status,
}: {
  readonly wake: NativeWakeup;
  readonly status: number;
}) {
  const fixture = responseFixture(
    "provider diagnostics contain private keys",
    status,
  );
  return Effect.gen(function* () {
    const result = yield* Effect.either(wake(work));
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "NativeWakeError", reason: "refused" },
    });
    expect(JSON.stringify(result)).not.toContain("private keys");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.signals[0]?.aborted).toBe(true);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, fixture.http),
    Effect.runPromise,
  );
}

function rejectsEmailBody({ body }: { readonly body: string | Uint8Array }) {
  const fixture = responseFixture(body, 200);
  return Effect.gen(function* () {
    const result = yield* Effect.either(makeInstinctWakeup(sender)(work));
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "NativeWakeError", reason: "decode-failed" },
    });
    expect(JSON.stringify(result)).not.toContain(Redacted.value(sender.apiKey));
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.signals[0]?.aborted).toBe(true);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, fixture.http),
    Effect.runPromise,
  );
}

function acceptsRoutine(status: number) {
  const fixture = responseFixture(null, status);
  return makeGrokWakeup(routine)(work).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(fixture.requests).toHaveLength(1);
      }),
    ),
    Effect.provideService(HttpClient.HttpClient, fixture.http),
    Effect.runPromise,
  );
}

function refusesConfiguration(wake: NativeWakeup) {
  const fixture = responseFixture(acceptedEmail, 200);
  return Effect.gen(function* () {
    expect(yield* Effect.either(wake(work))).toMatchObject({
      _tag: "Left",
      left: { reason: "invalid-configuration" },
    });
    expect(fixture.requests).toHaveLength(0);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, fixture.http),
    Effect.runPromise,
  );
}

function boundsHandoff({ wake }: { readonly wake: NativeWakeup }) {
  return Effect.gen(function* () {
    const entered = yield* Deferred.make<undefined>();
    const interrupted = yield* Deferred.make<undefined>();
    const signals: AbortSignal[] = [];
    const http = HttpClient.make((httpRequest, url, signal) => {
      expect(httpRequest.method).toBe("POST");
      expect(url.protocol).toBe("https:");
      signals.push(signal);
      return Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(interrupted, undefined)),
      );
    });
    const request = yield* wake(work).pipe(
      Effect.either,
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.join(request)).toMatchObject({
      _tag: "Left",
      left: { reason: "timed-out" },
    });
    yield* Deferred.await(interrupted);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  }).pipe(
    Effect.scoped,
    Effect.provide(TestContext.TestContext),
    Effect.runPromise,
  );
}

function preservesApproval() {
  const url = new URL(routine.url.href);
  const wake = makeGrokWakeup({ ...routine, url });
  url.hostname = "different.example";
  const fixture = responseFixture(null, 202);
  return wake(work).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(fixture.urls).toEqual([routine.url.href]);
      }),
    ),
    Effect.provideService(HttpClient.HttpClient, fixture.http),
    Effect.runPromise,
  );
}

function responseFixture(body: string | Uint8Array | null, status: number) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const signals: AbortSignal[] = [];
  const urls: string[] = [];
  const http = HttpClient.make((request, url, signal) =>
    Effect.sync(() => {
      requests.push(request);
      signals.push(signal);
      urls.push(url.href);
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, { status }),
      );
    }),
  );
  return { http, requests, signals, urls };
}

function requestBody(request: HttpClientRequest.HttpClientRequest) {
  return Match.value(request.body).pipe(
    Match.tag("Uint8Array", ({ body }) =>
      Schema.decodeUnknown(Schema.parseJson(Schema.Unknown))(
        new TextDecoder().decode(body),
      ),
    ),
    Match.orElse(() => Effect.dieMessage("expected JSON request bytes")),
  );
}

function closesTransportError() {
  const http = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.RequestError({
        request,
        reason: "Transport",
        cause: `failed ${Redacted.value(sender.apiKey)}`,
      }),
    ),
  );
  return Effect.gen(function* () {
    const result = yield* Effect.either(makeInstinctWakeup(sender)(work));
    expect(result).toMatchObject({
      _tag: "Left",
      left: { reason: "transport-failed" },
    });
    expect(JSON.stringify(result)).not.toContain(Redacted.value(sender.apiKey));
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.runPromise,
  );
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Provider contract expectations above are complete. */
