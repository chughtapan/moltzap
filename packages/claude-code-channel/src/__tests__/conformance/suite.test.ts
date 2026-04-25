/**
 * @moltzap/claude-code-channel — client-side conformance wrapper (issue #254).
 *
 * Invokes `clientConformance.runClientConformanceSuite` with the
 * MoltZap WS client factory re-exported by the channel package's
 * `test-support` subpath. Mirrors `packages/{client,openclaw-channel,
 * nanoclaw-channel}/src/__tests__/conformance/suite.test.ts` exactly —
 * cc-channel is the 4th client-side wrapper alongside the existing three.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { clientConformance } from "@moltzap/protocol/testing";
import { createMoltZapRealClientFactory } from "../../test-support.js";

const TOXIPROXY_URL = process.env.TOXIPROXY_URL ?? null;

describe("@moltzap/claude-code-channel client-side conformance", () => {
  it("client-side properties pass against the claude-code-channel real client", async () => {
    const factory = createMoltZapRealClientFactory({
      agentKey: "claude-code-test-agent-key",
      agentId: "claude-code-test-agent-id",
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
      `[claude-code-conformance] seed=${result.seed} passed=${result.passed.length} unavailable=${result.unavailable.length} failed=${result.failed.length}`,
    );
    if (result.failed.length > 0) {
      const summary = result.failed
        .map((f) => {
          const tag = "_tag" in f.failure ? f.failure._tag : "unknown";
          return `${f.name}: ${tag}`;
        })
        .join("; ");
      throw new Error(
        `${result.failed.length} claude-code-channel properties failed: ${summary}`,
      );
    }
  }, 600_000);
});
