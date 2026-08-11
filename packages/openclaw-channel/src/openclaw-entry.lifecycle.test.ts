import { live as it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { describe, expect, vi } from "vitest";

const clientModule = vi.hoisted(() => ({
  harnessClientForProfile: vi.fn(),
}));

vi.mock("@moltzap/client", () => clientModule);

import { createMoltzapChannelPlugin } from "./openclaw-entry.js";
import {
  cleanUpStart,
  createHarnessFixture,
  startPluginHarnessGateway,
  stopHarnessAccount,
  waitForGatewayStart,
} from "./test-utils/harness-fixture.js";

function installScopedProfileAcquisitions(
  fixtures: ReadonlyArray<ReturnType<typeof createHarnessFixture>>,
  events: string[],
): void {
  clientModule.harnessClientForProfile.mockImplementation(() => {
    const index = clientModule.harnessClientForProfile.mock.calls.length - 1;
    const fixture = fixtures[index];
    if (fixture === undefined) {
      return Effect.dieMessage("unexpected profile acquisition");
    }
    // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The mock is returned through the production acquisition seam, which startAccount encloses in Effect.scoped.
    return Effect.acquireRelease(
      Effect.sync(() => {
        events.push(`acquire:${String(index + 1)}`);
        return fixture.client;
      }),
      () =>
        Effect.sleep(Duration.millis(25)).pipe(
          Effect.zipRight(
            Effect.sync(() => {
              events.push(`release:${String(index + 1)}`);
            }),
          ),
        ),
    );
  });
}

const replacementWaitsForProductionScopeRelease = () => {
  const firstFixture = createHarnessFixture();
  const secondFixture = createHarnessFixture();
  const events: string[] = [];
  installScopedProfileAcquisitions([firstFixture, secondFixture], events);

  const plugin = createMoltzapChannelPlugin();
  const firstStart = startPluginHarnessGateway(plugin);
  let secondStart: ReturnType<typeof startPluginHarnessGateway> | undefined;

  return Effect.gen(function* () {
    yield* waitForGatewayStart(firstStart);
    secondStart = startPluginHarnessGateway(plugin);
    yield* waitForGatewayStart(secondStart);
    yield* Fiber.join(firstStart.startFiber);

    expect(events).toEqual(["acquire:1", "release:1", "acquire:2"]);
    expect(clientModule.harnessClientForProfile).toHaveBeenCalledTimes(2);

    yield* stopHarnessAccount(plugin);
    expect(events).toEqual([
      "acquire:1",
      "release:1",
      "acquire:2",
      "release:2",
    ]);
    yield* Fiber.join(secondStart.startFiber);
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        secondStart === undefined
          ? cleanUpStart(firstStart)
          : Effect.all([cleanUpStart(firstStart), cleanUpStart(secondStart)], {
              discard: true,
            }),
      ),
    ),
  );
};

// @agent-code-guard/regression-only: this example pins fixed-port handoff at the production scoped-acquisition boundary.
describe("OpenClaw gateway lifecycle", () => {
  it(
    "releases the prior production client scope before replacement acquisition",
    replacementWaitsForProductionScopeRelease,
  );
});
