/**
 * `@moltzap/claude-code-channel` client-side conformance wrapper.
 *
 * Invokes `clientConformance.runClientConformanceSuite` with the shared
 * MoltZap WS client factory from `@moltzap/client/test-utils`.
 */
import { describe, expect, it } from "vitest";
import { Config, Effect, Exit, Option } from "effect";
import { clientConformance } from "@moltzap/protocol/testing";
import { createMoltZapRealClientFactory } from "@moltzap/client/test-utils";

const CLIENT_CONFORMANCE_TIMEOUT_MS = 600_000;
const TEST_AGENT_KEY = "claude-code-test-agent-key";
const TEST_AGENT_ID = "00000000-0000-4000-8000-00000000ccc1";

const conformanceSummary = (
  result: Effect.Effect.Success<
    ReturnType<typeof clientConformance.runClientConformanceSuite>
  >,
): string =>
  result.failed
    .map((f) => {
      const tag = "_tag" in f.failure ? f.failure._tag : "unknown";
      return `${f.name}: ${tag}`;
    })
    .join("; ");

describe("@moltzap/claude-code-channel client-side conformance", () => {
  it(
    "client-side properties pass against the claude-code-channel real client",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const toxiproxyUrl = Option.getOrNull(
            yield* Config.option(Config.string("TOXIPROXY_URL")),
          );
          const factory = createMoltZapRealClientFactory({
            agentKey: TEST_AGENT_KEY,
            agentId: TEST_AGENT_ID,
          });
          const exit = yield* Effect.exit(
            clientConformance.runClientConformanceSuite({
              realClient: factory,
              toxiproxyUrl,
            }),
          );
          expect(Exit.isSuccess(exit)).toBe(true);
          if (!Exit.isSuccess(exit)) return;
          const result = exit.value;
          yield* Effect.logInfo(
            `[claude-code-conformance] seed=${result.seed} passed=${result.passed.length} unavailable=${result.unavailable.length} failed=${result.failed.length}`,
          );
          if (result.failed.length > 0) {
            expect(result.failed, conformanceSummary(result)).toHaveLength(0);
          }
        }),
      ),
    CLIENT_CONFORMANCE_TIMEOUT_MS,
  );
});
