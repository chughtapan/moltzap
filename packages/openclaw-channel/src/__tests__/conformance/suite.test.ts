/**
 * @moltzap/openclaw-channel — client-side conformance wrapper (AC16).
 *
 * Invokes `clientConformance.runClientConformanceSuite` with the
 * MoltZap WS client factory re-exported by the channel package's
 * `test-support` subpath. Architect-201 §8 O5.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { clientConformance } from "@moltzap/protocol/testing";
import { createMoltZapRealClientFactory } from "../../test-support.js";

const TOXIPROXY_URL = process.env.TOXIPROXY_URL ?? null;

describe("@moltzap/openclaw-channel client-side conformance", () => {
  it("client-side properties pass against the openclaw-channel real client", async () => {
    const factory = createMoltZapRealClientFactory({
      agentKey: "openclaw-test-agent-key",
      agentId: "openclaw-test-agent-id",
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
      `[openclaw-conformance] seed=${result.seed} passed=${result.passed.length} unavailable=${result.unavailable.length} failed=${result.failed.length}`,
    );
    if (result.failed.length > 0) {
      const summary = result.failed
        .map((f) => {
          const tag = "_tag" in f.failure ? f.failure._tag : "unknown";
          return `${f.name}: ${tag}`;
        })
        .join("; ");
      throw new Error(
        `${result.failed.length} openclaw-channel properties failed: ${summary}`,
      );
    }
  }, 600_000);
});
