import { assert, effect as test } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import { EventCatalog, EventCatalogDefinitionError } from "./catalog.js";
import {
  AgentProcessExited,
  AgentProcessSignaled,
  coreEvents,
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
      ...runtimeEvents.tags,
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
      runtime: "openclaw",
      code: 0,
    });
    const signaled = yield* coreEvents.decode({
      _tag: "moltzap.agent-process-signaled/v1",
      agentName: "alice",
      runtime: "openclaw",
      signal: "SIGTERM",
    });
    const ambiguous = yield* coreEvents
      .decode({
        _tag: "moltzap.agent-process-exited/v1",
        agentName: "alice",
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
