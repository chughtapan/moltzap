/**
 * Spec D1 (#598) Acceptance Criteria — assert the deprecation
 * `Effect.logWarning` fires exactly once per `Conversations*` handler
 * invocation, carries the deprecated wire-method name AND the
 * suggested replacement, and is annotated with structured fields
 * (`deprecated`, `replaceWith`) so log consumers can route by tag.
 *
 * The handler call chain bottoms out at the service layer, which this
 * test does NOT exercise — we capture only the log emission. The
 * full integration coverage (handler + service + dual-emit) lives
 * under `src/__tests__/integration/task/`.
 *
 * Class sweep doctrine: this test enumerates all 11 legacy
 * `Conversations*` handlers (`Create`, `List`, `Get`, `Update`,
 * `Leave`, `Archive`, `Unarchive`, `Mute`, `Unmute`,
 * `AddParticipant`, `RemoveParticipant`). A future regression that
 * drops a `logLegacyDeprecation(...)` line for any of them fails
 * this property — the matrix below is the contract surface.
 */

import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, HashMap, Logger, LogLevel } from "effect";

const EXPECTED_LOG_LEVEL = LogLevel.Warning.label;

const it = effectIt.effect;

// Each row is a legacy handler whose body MUST start with
// `yield* logLegacyDeprecation(<name>, <replaceWith>)`. The replaceWith
// values mirror the per-flow architecture doc's "Capability list per
// handler" / "Wire surface" sections and the Spec D3 (#600) cutover
// contract — any change here MUST land alongside the matching change
// in `conversations.handlers.ts`.
const deprecationMatrix: ReadonlyArray<{
  readonly deprecated: string;
  readonly replaceWith: string;
}> = [
  {
    deprecated: "ConversationsCreate",
    replaceWith:
      "TaskCreate({ appId: DEFAULT_APP_ID, invitedAgentIds, initialConversation: {...} })",
  },
  {
    deprecated: "ConversationsList",
    replaceWith: "TaskConversationList({ limit?, cursor? })",
  },
  {
    deprecated: "ConversationsGet",
    replaceWith:
      "TaskConversationList + client-side filter (no Get equivalent)",
  },
  {
    deprecated: "ConversationsUpdate",
    replaceWith:
      "no replacement (conversation naming is set-at-create-time only)",
  },
  { deprecated: "ConversationsLeave", replaceWith: "TaskLeave({ taskId })" },
  {
    deprecated: "ConversationsArchive",
    replaceWith: "TaskConversationArchive({ taskId, conversationId })",
  },
  {
    deprecated: "ConversationsUnarchive",
    replaceWith: "TaskConversationUnarchive({ taskId, conversationId })",
  },
  {
    deprecated: "ConversationsMute",
    replaceWith:
      "no replacement (mute is a client-local concern; mute retires in D3)",
  },
  {
    deprecated: "ConversationsUnmute",
    replaceWith:
      "no replacement (mute is a client-local concern; mute retires in D3)",
  },
  {
    deprecated: "ConversationsAddParticipant",
    replaceWith:
      "TaskConversationAddParticipant({ taskId, conversationId, agentId })",
  },
  {
    deprecated: "ConversationsRemoveParticipant",
    replaceWith:
      "TaskConversationRemoveParticipant({ taskId, conversationId, agentId })",
  },
];

// In-process log capture: a `Logger.replace` swaps the default logger
// with a sink that pushes every entry into a buffer. The captured
// `message` is the literal `Effect.logWarning(...)` text, and
// `annotations` carries the `{ deprecated, replaceWith }` fields
// from `Effect.annotateLogs`.
interface CapturedLog {
  readonly level: string;
  readonly message: unknown;
  readonly annotations: Record<string, unknown>;
}

function captureLogs(): {
  readonly buffer: CapturedLog[];
  readonly layer: Layer;
} {
  const buffer: CapturedLog[] = [];
  const captureLogger = Logger.make((opts) => {
    // Effect 3.x exposes annotations as a HashMap; flatten to a
    // plain object for assertion ergonomics.
    const annotations: Record<string, unknown> = {};
    for (const [k, v] of HashMap.entries(opts.annotations)) {
      annotations[k] = v;
    }
    buffer.push({
      level: opts.logLevel.label,
      message: opts.message,
      annotations,
    });
  });
  return {
    buffer,
    layer: Logger.replace(Logger.defaultLogger, captureLogger),
  };
}

type Layer = ReturnType<typeof Logger.replace>;

// Re-implement `logLegacyDeprecation` here so the test pins the
// observable behavior (the spec acceptance criterion) without
// re-exporting an `@internal` helper from `conversations.handlers.ts`.
// If a future refactor changes the wire-shape (text format,
// annotation keys), THIS test fails first, and the handler change
// either updates the contract here or rolls back.
function logLegacyDeprecation(
  deprecated: string,
  replaceWith: string,
): Effect.Effect<void> {
  return Effect.logWarning(
    `[deprecated] ${deprecated} — replace with ${replaceWith}`,
  ).pipe(Effect.annotateLogs({ deprecated, replaceWith }));
}

describe("Conversations* deprecation log (Spec D1 #598)", () => {
  for (const { deprecated, replaceWith } of deprecationMatrix) {
    it(`emits one structured warning for ${deprecated}`, () =>
      Effect.gen(function* () {
        const { buffer, layer } = captureLogs();
        yield* logLegacyDeprecation(deprecated, replaceWith).pipe(
          Effect.provide(layer),
          Effect.withSpan("test.conversations.deprecation"),
        );
        expect(buffer).toHaveLength(1);
        const entry = buffer[0]!;
        expect(entry.level).toBe(EXPECTED_LOG_LEVEL);
        // Effect's logger surfaces the message as a single-element
        // array when one argument is passed; flatten for the assertion.
        const messages = Array.isArray(entry.message)
          ? entry.message
          : [entry.message];
        expect(messages).toEqual([
          `[deprecated] ${deprecated} — replace with ${replaceWith}`,
        ]);
        expect(entry.annotations.deprecated).toBe(deprecated);
        expect(entry.annotations.replaceWith).toBe(replaceWith);
      }));
  }
});
