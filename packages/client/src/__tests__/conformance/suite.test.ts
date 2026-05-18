/**
 * packages/client — client-side conformance wrapper (AC15).
 *
 * Thin driver around `@moltzap/protocol/testing`'s
 * `clientConformance.runClientConformanceSuite`. Supplies a
 * `MoltZapWsClient`-backed real-client factory and asserts the typed
 * suite result in a single `it(...)`.
 *
 * The protocol suite binds its own TestServer on an ephemeral port and
 * passes the bound URL to each `realClient(args)` invocation via
 * `args.testServerUrl`. The factory below points its `MoltZapWsClient`
 * at that URL.
 */
import { describe, expect, it } from "vitest";
import { Config, Data, Effect, Exit, Option } from "effect";
import { clientConformance } from "@moltzap/protocol/testing";
import { createMoltZapRealClientFactory } from "@moltzap/client/test-utils";

const CLIENT_CONFORMANCE_TIMEOUT_MS = 600_000;
const TOXIPROXY_URL = Effect.runSync(
  Config.option(Config.string("TOXIPROXY_URL")).pipe(
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  ),
);

class ClientConformanceFailed extends Data.TaggedError(
  "ClientConformanceFailed",
)<{
  readonly message: string;
}> {}

describe("@moltzap/client client-side conformance", () => {
  it(
    "client-side properties pass against MoltZapWsClient",
    () => Effect.runPromise(clientConformancePasses()),
    CLIENT_CONFORMANCE_TIMEOUT_MS,
  );
});

function clientConformancePasses() {
  return Effect.gen(function* () {
    const factory = createMoltZapRealClientFactory({
      agentKey: "test-agent-key",
      agentId: "00000000-0000-4000-8000-00000000c1ce",
    });
    const exit = yield* Effect.exit(
      clientConformance.runClientConformanceSuite({
        realClient: factory,
        toxiproxyUrl: TOXIPROXY_URL,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value;
    yield* logConformanceSummary(result);
    yield* logUnavailable(result.unavailable);
    if (result.failed.length > 0) {
      const summary = failedSummary(result);
      return yield* Effect.fail(
        new ClientConformanceFailed({
          message: `${result.failed.length} client-side properties failed: ${summary}`,
        }),
      );
    }
  });
}

type ClientConformanceResult = Effect.Effect.Success<
  ReturnType<typeof clientConformance.runClientConformanceSuite>
>;

function logConformanceSummary(
  result: ClientConformanceResult,
): Effect.Effect<void> {
  return Effect.logInfo("client conformance completed").pipe(
    Effect.annotateLogs({
      seed: result.seed,
      passed: result.passed.length,
      deferred: result.deferred.length,
      unavailable: result.unavailable.length,
      failed: result.failed.length,
    }),
  );
}

function logUnavailable(
  unavailable: ClientConformanceResult["unavailable"],
): Effect.Effect<void> {
  if (unavailable.length === 0) return Effect.void;
  return Effect.logInfo("client conformance unavailable").pipe(
    Effect.annotateLogs({ unavailable: unavailableSummary(unavailable) }),
  );
}

function unavailableSummary(
  unavailable: ClientConformanceResult["unavailable"],
): string {
  return unavailable
    .map((entry) => `${entry.name}: ${entry.reason}`)
    .join(" | ");
}

function failedSummary(result: ClientConformanceResult): string {
  return result.failed.map(failedPropertySummary).join("; ");
}

function failedPropertySummary(
  failed: ClientConformanceResult["failed"][number],
): string {
  const tag = "_tag" in failed.failure ? failed.failure._tag : "unknown";
  return `${failed.name}: ${tag}`;
}
