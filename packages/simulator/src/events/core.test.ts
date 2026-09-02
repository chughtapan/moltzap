/** @file Core event-universe, tag-validation, and process-termination regressions. */

import { assert, effect as test } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import { EventCatalog, EventCatalogDefinitionError } from "./catalog.js";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  AgentWorkspaceFileHarvested,
  coreEvents,
  type HarvestedFileOutcome,
  linkEvents,
  routerEvents,
  runEvents,
  runtimeEvents,
} from "./core.js";

const MISCASED_TAG_FAILURE = "invalid-tag";
const DUPLICATE_TAG_FAILURE = "duplicate-tag";

class MiscasedTagEvent extends Schema.TaggedClass<MiscasedTagEvent>()(
  "Acme.Miscased/v1",
  {},
) {}
class UnversionedTagEvent extends Schema.TaggedClass<UnversionedTagEvent>()(
  "acme.unversioned/v0",
  {},
) {}

function catalogFailure(build: () => unknown): EventCatalogDefinitionError {
  try {
    build();
  } catch (cause) {
    if (cause instanceof EventCatalogDefinitionError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("the catalog was accepted");
}

test("declares one exact versioned lifecycle event universe", () =>
  Effect.sync(() => {
    assert.deepStrictEqual(coreEvents.tags, [
      ...runEvents.tags,
      ...routerEvents.tags,
      ...runtimeEvents.tags,
      ...linkEvents.tags,
    ]);
    assert.isTrue(coreEvents.tags.every((tag) => /\/v\d+$/u.test(tag)));
  }));

test("rejects invalid and duplicate event tags", () =>
  Effect.sync(() => {
    const miscased = catalogFailure(() => EventCatalog.make(MiscasedTagEvent));
    const unversioned = catalogFailure(() =>
      EventCatalog.make(UnversionedTagEvent),
    );
    const duplicate = catalogFailure(() =>
      EventCatalog.make(AgentProcessExited, AgentProcessExited),
    );

    assert.strictEqual(miscased.failure, MISCASED_TAG_FAILURE);
    assert.strictEqual(miscased.tag, MiscasedTagEvent._tag);
    assert.strictEqual(unversioned.failure, MISCASED_TAG_FAILURE);
    assert.strictEqual(duplicate.failure, DUPLICATE_TAG_FAILURE);
    assert.strictEqual(duplicate.tag, AgentProcessExited._tag);
  }));

test("represents process exit and signal as distinct lifecycle facts", () =>
  Effect.gen(function* () {
    const exited = yield* coreEvents.decode({
      _tag: "moltzap.agent-process-exited/v1",
      agentName: "alice",
      agentId: "agt_AAAAAAAAAAAAAAAAAAAAAA",
      runtime: "openclaw",
      code: 0,
    });
    const signaled = yield* coreEvents.decode({
      _tag: "moltzap.agent-process-signaled/v1",
      agentName: "alice",
      agentId: "agt_AAAAAAAAAAAAAAAAAAAAAA",
      runtime: "openclaw",
      signal: "SIGTERM",
    });
    const ambiguous = yield* coreEvents
      .decode({
        _tag: "moltzap.agent-process-exited/v1",
        agentName: "alice",
        agentId: "agt_AAAAAAAAAAAAAAAAAAAAAA",
        runtime: "openclaw",
        code: 0,
        signal: "SIGTERM",
      })
      .pipe(Effect.either);

    assert.instanceOf(exited, AgentProcessExited);
    assert.instanceOf(signaled, AgentProcessSignaled);
    assert.isTrue(
      Either.match(ambiguous, {
        onLeft: () => true,
        onRight: () => false,
      }),
    );
  }));

const HARVEST_OUTCOMES: readonly HarvestedFileOutcome[] = [
  { _tag: "text", content: "# Calendar", byteLength: 10 },
  { _tag: "oversize", byteLength: 70_000, limitBytes: 65_536 },
  { _tag: "absent" },
  { _tag: "unreadable", cause: "the read exited 1" },
];

test("round-trips every way a harvested workspace file resolves", () =>
  Effect.gen(function* () {
    for (const outcome of HARVEST_OUTCOMES) {
      const decoded = yield* coreEvents.decode({
        _tag: "moltzap.agent-workspace-file/v1",
        agentName: "alice",
        agentId: "agt_AAAAAAAAAAAAAAAAAAAAAA",
        runtime: "openclaw",
        relativePath: "CALENDAR.md",
        outcome,
      });

      assert.instanceOf(decoded, AgentWorkspaceFileHarvested);
      if (decoded instanceof AgentWorkspaceFileHarvested) {
        assert.deepStrictEqual(decoded.outcome, outcome);
      }
    }
    const unknownOutcome = yield* coreEvents
      .decode({
        _tag: "moltzap.agent-workspace-file/v1",
        agentName: "alice",
        agentId: "agt_AAAAAAAAAAAAAAAAAAAAAA",
        runtime: "openclaw",
        relativePath: "CALENDAR.md",
        outcome: { _tag: "binary", bytes: "AAAA" },
      })
      .pipe(Effect.either);

    assert.isTrue(
      Either.match(unknownOutcome, {
        onLeft: () => true,
        onRight: () => false,
      }),
    );
  }));
