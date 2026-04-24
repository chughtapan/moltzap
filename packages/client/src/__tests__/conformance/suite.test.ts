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
import { Effect, Exit } from "effect";
import { clientConformance } from "@moltzap/protocol/testing";
import { createMoltZapRealClientFactory } from "../../test-utils/index.js";

const TOXIPROXY_URL = process.env.TOXIPROXY_URL ?? null;

describe("@moltzap/client client-side conformance", () => {
  it("client-side properties pass against MoltZapWsClient", async () => {
    const factory = createMoltZapRealClientFactory({
      agentKey: "test-agent-key",
      agentId: "test-agent-id",
    });
    const exit = await Effect.runPromiseExit(
      clientConformance.runClientConformanceSuite({
        realClient: factory,
        toxiproxyUrl: TOXIPROXY_URL,
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value;
    console.log(
      `[client-conformance] seed=${result.seed} passed=${result.passed.length} deferred=${result.deferred.length} unavailable=${result.unavailable.length} failed=${result.failed.length}`,
    );
    if (result.unavailable.length > 0) {
      console.log(
        `[client-conformance] unavailable: ${result.unavailable.map((u) => `${u.name}: ${u.reason}`).join(" | ")}`,
      );
    }
    if (result.failed.length > 0) {
      const summary = result.failed
        .map((f) => {
          const tag = "_tag" in f.failure ? f.failure._tag : "unknown";
          return `${f.name}: ${tag}`;
        })
        .join("; ");
      throw new Error(
        `${result.failed.length} client-side properties failed: ${summary}`,
      );
    }
  }, 600_000);
});
