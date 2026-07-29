import { assert, effect as test } from "@effect/vitest";
import { DateTime, Effect, Schema, Stream } from "effect";
import { LedgerManifest, LedgerRef, LedgerStorageError } from "../ledger.js";
import { EventCatalog } from "../events/catalog.js";
import type { LedgerWriter, RunLedger } from "../ledger/live.js";
import type { LedgerRecord } from "../ledger/model.js";
import { makeDefinitionEventServices } from "./event-services.js";

class Observation extends Schema.TaggedClass<Observation>()(
  "acme.observation/v1",
  {
    value: Schema.String,
  },
) {}

const CustomerEvents = EventCatalog.make(Observation);
const PROGRAM_PRODUCER = "program";
const VISIBLE_OBSERVATION = "visible";
const services = makeDefinitionEventServices(
  "acme.service-test/v1",
  CustomerEvents,
);
const ledgerRef = Schema.decodeSync(LedgerRef)("service-test");
const manifest = LedgerManifest.make({
  ledgerFormatVersion: 1,
  definitionId: "acme.service-test/v1",
  runId: "service-test",
  catalogTags: services.catalog.tags,
  createdAt: DateTime.unsafeMake(0),
  provenance: {},
  metadata: {},
});

function emptyLedger(): RunLedger<typeof services.catalog> {
  return {
    ref: ledgerRef,
    manifest,
    records: Stream.empty,
    events: () => Stream.empty,
  };
}

function record(event: Observation): LedgerRecord<typeof CustomerEvents> {
  return {
    runId: "service-test",
    eventId: "service-test:0",
    logicalSequence: 0,
    elapsedNanos: 0n,
    observedAt: 0,
    producer: PROGRAM_PRODUCER,
    event,
  };
}

test("provides customer emission through the definition tag", () => {
  const writer: LedgerWriter<typeof CustomerEvents> = {
    write: ({ event }) => Effect.succeed(record(event)),
  };
  return Effect.gen(function* () {
    const events = yield* services.Events;
    const committed = yield* events.emit(
      Observation.make({ value: VISIBLE_OBSERVATION }),
    );

    assert.strictEqual(committed.producer, PROGRAM_PRODUCER);
    assert.strictEqual(committed.event.value, VISIBLE_OBSERVATION);
  }).pipe(Effect.provide(services.layer(emptyLedger(), writer)));
});

test("omits empty causality metadata before it reaches the ledger", () => {
  type Write = Parameters<LedgerWriter<typeof CustomerEvents>["write"]>[0];
  let captured: Write | undefined;
  const writer: LedgerWriter<typeof CustomerEvents> = {
    write: (input) =>
      Effect.sync(() => {
        captured = input;
        return record(input.event);
      }),
  };
  return Effect.gen(function* () {
    const events = yield* services.Events;
    yield* events.emit(Observation.make({ value: VISIBLE_OBSERVATION }), {
      causationId: "",
      correlationId: "",
    });

    assert.isDefined(captured);
    assert.notProperty(captured, "causationId");
    assert.notProperty(captured, "correlationId");
  }).pipe(Effect.provide(services.layer(emptyLedger(), writer)));
});

test("preserves the precise ledger failure at the live service boundary", () => {
  const failure = LedgerStorageError.make({
    operation: "append",
    detail: "disk unavailable",
  });
  const writer: LedgerWriter<typeof CustomerEvents> = {
    write: () => Effect.fail(failure),
  };
  return Effect.gen(function* () {
    const events = yield* services.Events;
    const observed = yield* events
      .emit(Observation.make({ value: "uncommitted" }))
      .pipe(Effect.flip);

    assert.strictEqual(observed, failure);
  }).pipe(Effect.provide(services.layer(emptyLedger(), writer)));
});
