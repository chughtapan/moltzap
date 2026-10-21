/** @file Real daemons export their spans, and mark collectives and retries, over OTLP/HTTP protobuf. */

import { Duration, Effect, Fiber } from "effect";
import { expect, it } from "vitest";
import { CollectiveError, type InboundItem } from "../src/index.js";
import {
  acquireProcessInfrastructure,
  type DaemonProcessFixture,
  makeDaemonProcessFixture,
  processTrace,
} from "./daemon-process-harness.js";
import {
  acquireOtlpReceiver,
  awaitSpans,
  type ExportedSpan,
  type OtlpReceiver,
} from "./otlp-receiver.js";
import {
  groupAddress,
  nextItem,
  type Participant,
  send,
  startParticipants,
} from "./participants.js";
import { acquireRouterHoldProxy } from "./router-hold-proxy.js";

/**
 * Each test starts PGlite, the Registry, the Router and two or three
 * daemons; the marker trace also waits out one all_gather's 20 s request
 * wait and a proposal's next resend. The limit is the only wall-clock bound
 * the traces set themselves, apart from the silence window.
 */
const TELEMETRY_TEST_TIMEOUT_MS = 300_000;

/** An operation's deadline when only its answers should close it: the test's own limit. */
const ANSWERED_DEADLINE_SECONDS = TELEMETRY_TEST_TIMEOUT_MS / 1000;

/** The standard batch delay, shortened from 5 s so spans reach the receiver sooner. */
const BATCH_DELAY_MILLISECONDS = "100";

/**
 * How long a daemon without an endpoint must stay silent after the exporting
 * daemon's spans arrive: twenty batch delays.
 */
const SILENCE_WINDOW = Duration.seconds(2);

const question = "Which day works for the review?";
const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
} as const;

function withEnvironment(
  fixture: DaemonProcessFixture,
  environment: Readonly<Record<string, string>>,
): DaemonProcessFixture {
  return {
    ...fixture,
    environment: { ...fixture.environment, ...environment },
  };
}

/** The standard variables that point one daemon's spans at `receiver`. */
function exportingTo(
  fixture: DaemonProcessFixture,
  receiver: OtlpReceiver,
): DaemonProcessFixture {
  return withEnvironment(fixture, {
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.endpoint.origin,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_RESOURCE_ATTRIBUTES: `sharness.agent=${fixture.agentName}`,
    OTEL_BSP_SCHEDULE_DELAY: BATCH_DELAY_MILLISECONDS,
  });
}

function named(
  spans: readonly ExportedSpan[],
  name: string,
): readonly ExportedSpan[] {
  return spans.filter((span) => span.name === name);
}

/** The marker span `name` that carries `attributes.key === value`. */
function marker(
  spans: readonly ExportedSpan[],
  name: string,
  key: string,
  value: string,
): ExportedSpan | undefined {
  return named(spans, name).find((span) => span.attributes[key] === value);
}

/**
 * Every `retry.pending` span still unsettled. Each settled span settles one
 * pending span with its id: a re-proposed post starts a second schedule
 * under the same id.
 */
function unsettledRetries(spans: readonly ExportedSpan[]): ExportedSpan[] {
  const settled = named(spans, "retry.settled").map(
    (span) => span.attributes["id"],
  );
  return named(spans, "retry.pending").filter((span) => {
    const match = settled.indexOf(span.attributes["id"]);
    if (match === -1) {
      return true;
    }
    settled.splice(match, 1);
    return false;
  });
}

/**
 * Expect the operation `id` marked open with the deadline its request
 * carried, then closed as completed.
 */
function expectMarked(
  spans: readonly ExportedSpan[],
  id: string,
  request: InboundItem,
  op: "gather" | "all_gather",
): void {
  const opened = marker(spans, "collective.opened", "operationId", id);
  const closed = marker(spans, "collective.closed", "operationId", id);
  expect(opened?.attributes).toEqual({
    operationId: id,
    op,
    deadlineAt: expect.any(Number),
  });
  expect(request).toMatchObject({
    kind: "collectiveRequest",
    id,
    deadlineAt: opened?.attributes["deadlineAt"],
  });
  expect(closed?.attributes).toEqual({ operationId: id, outcome: "completed" });
  expect(opened?.startTimeUnixNano).toBeLessThan(
    closed?.startTimeUnixNano ?? 0n,
  );
}

const exportBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const receiver = yield* acquireOtlpReceiver;
  const silentReceiver = yield* acquireOtlpReceiver;
  const exporting = exportingTo(
    yield* makeDaemonProcessFixture(infrastructure, "otel-exporting"),
    receiver,
  );
  /** Everything but the endpoint, so only the opt-in keeps it from exporting. */
  const silent = withEnvironment(
    yield* makeDaemonProcessFixture(infrastructure, "otel-silent"),
    {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: new URL(
        "/v1/traces",
        silentReceiver.endpoint,
      ).href,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_BSP_SCHEDULE_DELAY: BATCH_DELAY_MILLISECONDS,
    },
  );
  const [sender, target] = yield* startParticipants([exporting, silent]);
  if (sender === undefined || target === undefined) {
    return yield* Effect.dieMessage("expected two participants");
  }

  yield* send(sender, { to: target.address, text: "sent by the exporter" });
  yield* nextItem(target);
  yield* send(target, { to: sender.address, text: "received by the exporter" });
  yield* nextItem(sender);

  const spans = yield* awaitSpans(
    receiver,
    (received) =>
      named(received, "EndpointEngine.send").length > 0 &&
      named(received, "persistInboxItem").length > 0,
  );
  expect(named(spans, "persistInboxItem")[0]?.resource).toMatchObject({
    "service.name": "sharnessd",
    "sharness.agent": "otel-exporting",
  });
  yield* Effect.sleep(SILENCE_WINDOW);
  expect(yield* silentReceiver.connections).toBe(0);
}).pipe(Effect.scoped);

const gatherFrom = (
  requester: Participant,
  to: string,
  op: "gather" | "all_gather",
) =>
  send(requester, {
    to,
    text: question,
    collective: {
      op,
      deadline: ANSWERED_DEADLINE_SECONDS,
      requestedSchema: slotSchema,
    },
  });

/**
 * The requester exports; the third daemon reaches the Router through a hold
 * proxy. In a three-member group every post needs every member, so holding
 * that member keeps the requester's proposals uncertified.
 */
const markerBehavior = Effect.gen(function* () {
  const infrastructure = yield* acquireProcessInfrastructure;
  const receiver = yield* acquireOtlpReceiver;
  const proxy = yield* acquireRouterHoldProxy(infrastructure.routerOrigin);
  const fixtures = [
    exportingTo(
      yield* makeDaemonProcessFixture(infrastructure, "otel-requester"),
      receiver,
    ),
    yield* makeDaemonProcessFixture(infrastructure, "otel-member-a"),
    withEnvironment(
      yield* makeDaemonProcessFixture(infrastructure, "otel-member-b"),
      { SHARNESS_ROUTER_ORIGIN: proxy.origin.origin },
    ),
  ];
  const [requester, member, held] = yield* startParticipants(fixtures);
  if (requester === undefined || member === undefined || held === undefined) {
    return yield* Effect.dieMessage("expected three participants");
  }
  const group = groupAddress([requester, member, held]);

  const gathered = yield* gatherFrom(requester, group, "gather");
  const gatherRequest = yield* nextItem(member);
  yield* nextItem(held);
  yield* send(member, {
    to: requester.address,
    collectiveResponse: { action: "accept", content: { slot: "mon" } },
  });
  yield* send(held, {
    to: requester.address,
    collectiveResponse: { action: "decline" },
  });
  yield* nextItem(requester);

  const allGathered = yield* gatherFrom(requester, group, "all_gather");
  const allGatherRequest = yield* nextItem(member);
  yield* nextItem(held);
  yield* send(member, {
    to: group,
    collectiveResponse: { action: "accept", content: { slot: "tue" } },
  });
  yield* send(held, {
    to: group,
    collectiveResponse: { action: "decline" },
  });
  yield* Effect.forEach([requester, member, held], nextItem);

  const gatherId = gathered.operationId ?? "";
  const allGatherId = allGathered.operationId ?? "";
  /** Every earlier proposal settles too, so the held send's is the one left pending. */
  const completed = yield* awaitSpans(
    receiver,
    (received) =>
      marker(received, "collective.closed", "operationId", gatherId) !==
        undefined &&
      marker(received, "collective.closed", "operationId", allGatherId) !==
        undefined &&
      unsettledRetries(received).length === 0,
  );
  expectMarked(completed, gatherId, gatherRequest, "gather");
  expectMarked(completed, allGatherId, allGatherRequest, "all_gather");

  yield* proxy.hold;
  yield* Effect.addFinalizer(() => proxy.release);
  const heldSend = yield* Effect.fork(
    send(requester, {
      to: held.address,
      text: "sent while the member is held",
    }),
  );
  const [pending] = unsettledRetries(
    yield* awaitSpans(
      receiver,
      (received) => unsettledRetries(received).length > 0,
    ),
  );
  expect(pending?.attributes).toEqual({
    kind: "proposal",
    id: expect.any(String),
  });
  const pendingId = String(pending?.attributes["id"]);

  const refused = yield* gatherFrom(requester, group, "all_gather").pipe(
    Effect.flip,
    Effect.filterOrDieMessage(
      (error) => error instanceof CollectiveError,
      "the all_gather to the held group was not refused",
    ),
  );
  expect(refused.failure).toMatchObject({ kind: "members-unreachable" });
  expect(
    marker(yield* receiver.spans, "retry.settled", "id", pendingId),
  ).toBeUndefined();

  yield* proxy.release;
  yield* Fiber.join(heldSend);
  const settled = yield* awaitSpans(
    receiver,
    (received) =>
      marker(received, "retry.settled", "id", pendingId) !== undefined &&
      marker(received, "collective.closed", "operationId", refused.id) !==
        undefined,
  );
  expect(marker(settled, "retry.settled", "id", pendingId)?.attributes).toEqual(
    { kind: "proposal", id: pendingId, outcome: "certified" },
  );
  expect(
    marker(settled, "collective.opened", "operationId", refused.id)?.attributes,
  ).toMatchObject({ operationId: refused.id, op: "all_gather" });
  expect(
    marker(settled, "collective.closed", "operationId", refused.id)?.attributes,
  ).toEqual({ operationId: refused.id, outcome: "refused" });
}).pipe(Effect.scoped);

it(
  "exports send and receive spans only from the daemon given an OTLP endpoint",
  processTrace(exportBehavior),
  TELEMETRY_TEST_TIMEOUT_MS,
);

it(
  "marks collective operations open until they close, and proposals pending until a held member returns",
  processTrace(markerBehavior),
  TELEMETRY_TEST_TIMEOUT_MS,
);
