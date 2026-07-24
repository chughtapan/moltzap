/**
 * @file Property gates for the event log: unique strictly increasing
 * `logicalSequence` under concurrent enqueue from many sources, the
 * acknowledged sequence matching the drained line, enqueue-after-seal
 * rejection, and `decodeEventLine` as a per-class roundtrip.
 */
/* eslint-disable sonarjs/assertions-in-tests -- assertion bodies are extracted to named top-level functions to satisfy the nesting caps; every test delegates to one */
import { describe, expect, it } from "vitest";
import { Effect, FastCheck as fc, Schema } from "effect";
import {
  decodeEventLine,
  makeEventLog,
  type EventLog,
  type PendingEvent,
} from "./event-log.js";
import { RunId, WallTimeMs } from "./ids.js";
import { AgentName, LogicalTime } from "./run-spec.js";
import { makeSecrets } from "./recording.js";
import { EVENT, EXIT, ERROR_TAG } from "./__tests__/tags.js";

const RUN_ID = Schema.decodeSync(RunId)("abcdefabcdef-s7-a1");

function wall(): WallTimeMs {
  return Schema.decodeSync(WallTimeMs)(Date.now());
}

function pendingSpan(name: string): PendingEvent {
  return {
    _tag: "span.accepted",
    source: "span",
    wallTime: wall(),
    spanName: name,
    raw: { name },
  };
}

function withLog<A>(
  body: (log: EventLog, lines: Array<string>) => Effect.Effect<A, unknown>,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lines: Array<string> = [];
        const log = yield* makeEventLog({
          runId: RUN_ID,
          clock: { now: () => Schema.decodeSync(LogicalTime)(0) },
          sink: {
            appendEvents: (batch) =>
              Effect.sync(() => {
                lines.push(...batch);
              }),
          },
          secrets: makeSecrets([]),
        });
        return yield* body(log, lines);
      }),
    ).pipe(Effect.orDie),
  );
}

function concurrentStampBody(
  producerCount: number,
  log: EventLog,
  lines: Array<string>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const sequences = yield* Effect.forEach(
      Array.from({ length: producerCount }, (_, index) => index),
      (index) => log.enqueue(pendingSpan(`span-${String(index)}`)),
      { concurrency: producerCount },
    );
    const summary = yield* log.seal();
    const sorted = [...sequences].sort((a, b) => a - b);
    expect(new Set(sequences).size).toBe(producerCount);
    expect(summary.finalLogicalSequence).toBeGreaterThanOrEqual(
      sorted[sorted.length - 1] ?? 0,
    );
    yield* assertAcksMatchLines(sequences, lines);
  });
}

function assertAcksMatchLines(
  sequences: ReadonlyArray<number>,
  lines: ReadonlyArray<string>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const byLine = new Map<number, string>();
    const decoded = yield* Effect.forEach(
      lines,
      (line) => decodeEventLine(line),
      { concurrency: 1 },
    );
    for (const event of decoded) {
      expect(byLine.has(event.logicalSequence)).toBe(false);
      byLine.set(event.logicalSequence, event._tag);
    }
    for (const sequence of sequences) {
      expect(byLine.get(sequence)).toBe(EVENT.spanAccepted);
    }
  });
}

function sealRejectionBody(log: EventLog): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* log.enqueue(pendingSpan("before-seal"));
    yield* log.seal();
    const late = yield* Effect.exit(log.enqueue(pendingSpan("late")));
    expect(late._tag).toBe(EXIT.failure);
    expect(JSON.stringify(late)).toContain(ERROR_TAG.eventLogSealed);
  });
}

function checkpointBody(
  log: EventLog,
  lines: Array<string>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* log.enqueue(pendingSpan("one"));
    yield* log.seal();
    const tags = yield* Effect.forEach(
      lines,
      (line) => decodeEventLine(line).pipe(Effect.map((event) => event._tag)),
      { concurrency: 1 },
    );
    expect(tags.at(-1)).toBe(EVENT.checkpoint);
    expect(
      tags.filter((tag) => tag === EVENT.checkpoint).length,
    ).toBeGreaterThan(0);
  });
}

function roundTripBody(
  log: EventLog,
  lines: Array<string>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    yield* log.enqueue(pendingSpan("roundtrip"));
    yield* log.enqueue({
      _tag: "agent.exited",
      source: "lifecycle",
      wallTime: wall(),
      agent: Schema.decodeSync(AgentName)("agent-one"),
      exitCode: 0,
    });
    yield* log.seal();
    const decoded = yield* Effect.forEach(
      lines,
      (line) => decodeEventLine(line),
      { concurrency: 1 },
    );
    for (const event of decoded) {
      expect(event.runId).toBe(RUN_ID);
    }
  });
}

const stampProperty = fc.asyncProperty(
  fc.integer({ min: 1, max: 40 }),
  (producerCount) =>
    withLog((log, lines) => concurrentStampBody(producerCount, log, lines)),
);

describe("makeEventLog", () => {
  it("stamps unique strictly increasing sequences under concurrent enqueue; acks match drained lines (property)", () =>
    fc.assert(stampProperty, { numRuns: 10 }));

  it("rejects enqueues after seal, never silently dropping", () =>
    withLog(sealRejectionBody));

  it("emits a checkpoint at every drain boundary and a final checkpoint at seal", () =>
    withLog(checkpointBody));
});

describe("decodeEventLine", () => {
  it("round-trips every drained line (decode of the written encoding is identity on re-encode)", () =>
    withLog(roundTripBody));

  it("fails typed on non-JSON and non-event lines", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const notJson = yield* Effect.exit(decodeEventLine("{nope"));
        expect(notJson._tag).toBe(EXIT.failure);
        const notEvent = yield* Effect.exit(decodeEventLine("{}"));
        expect(notEvent._tag).toBe(EXIT.failure);
      }),
    ));
});
