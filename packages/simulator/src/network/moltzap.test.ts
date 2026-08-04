/* eslint-disable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, sonarjs/no-nested-functions, agent-code-guard/no-hardcoded-assertion-literals -- regression-only resource tests keep each acquisition and release timeline visible in one Effect program. */

import { it as effectIt } from "@effect/vitest";
import { agentName as agentNameSchema } from "@moltzap/protocol/identity";
import { serverBaseUrl } from "@moltzap/protocol/network";
import {
  agentId,
  agentKeyString,
  conversationId,
  messageId,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import {
  makeRouterStopReport,
  networkFailure,
  routerSequence,
  type EndpointTransport,
} from "../network.js";
import { Duration, Effect, Exit, Schema, Scope, Stream } from "effect";
import { describe, expect } from "vitest";
import {
  makeMoltZapRouterProviderWith,
  type MoltZapRouterDriver,
  type MoltZapRouterDriverAcquirer,
} from "./moltzap.js";

const it = effectIt.scoped;
const STARTUP_TIMEOUT = Duration.seconds(10);
const ROUTER_URL = serverBaseUrl("http://127.0.0.1:43100");
const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-000000000102");
const MESSAGE_ID = messageId("00000000-0000-4000-8000-000000000103");
const agentName = Schema.decodeSync(agentNameSchema);
const ALICE = agentName("alice");
const PROBE = agentName("probe");

function id(suffix: number) {
  return agentId(`00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`);
}

function key(suffix: number) {
  return redactedAgentKey(agentKeyString(suffix));
}

const transport: EndpointTransport = {
  received: Stream.empty,
  openConversation: () => Effect.never,
  send: () => Effect.never,
};

interface Harness {
  readonly acquire: MoltZapRouterDriverAcquirer;
  readonly registrations: string[];
  readonly timeline: string[];
}

function harness(): Harness {
  const registrations: string[] = [];
  const timeline: string[] = [];
  const identities = new Map<string, number>();
  const stopped = makeRouterStopReport([
    {
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      senderId: id(1),
      routerSequence: routerSequence(7),
    },
  ]);
  const driver: MoltZapRouterDriver = {
    address: ROUTER_URL,
    register: (name) =>
      Effect.sync(() => {
        registrations.push(name);
        const suffix = identities.get(name) ?? identities.size + 1;
        identities.set(name, suffix);
        return { agentId: id(suffix), key: key(suffix) };
      }),
    attachEndpoint: () =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            timeline.push("endpoint-close");
          }),
        );
        return transport;
      }),
    stopAndCollect: Effect.sync(() => {
      timeline.push("router-stop");
      return stopped;
    }),
  };
  const acquire: MoltZapRouterDriverAcquirer = () =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          timeline.push("driver-release");
        }),
      );
      return driver;
    });
  return {
    acquire,
    registrations,
    timeline,
  };
}

function close(scope: Scope.CloseableScope) {
  return Scope.close(scope, Exit.void);
}

describe("MoltZap router", () => {
  it("keeps identities stable and completes stopped after scoped release", () =>
    Effect.gen(function* () {
      const test = harness();
      const provider = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        test.acquire,
      );
      const scope = yield* Scope.make();
      const router = yield* provider.acquire.pipe(Scope.extend(scope));
      const [firstAlice, secondAlice] = yield* Effect.all(
        [
          router.attachAgent("alice", ALICE).pipe(Scope.extend(scope)),
          router.attachAgent("alice", ALICE).pipe(Scope.extend(scope)),
        ],
        { concurrency: 2 },
      );
      const [firstProbe, secondProbe] = yield* Effect.all(
        [
          router.attachEndpoint("probe", PROBE).pipe(Scope.extend(scope)),
          router.attachEndpoint("probe", PROBE).pipe(Scope.extend(scope)),
        ],
        { concurrency: 2 },
      );
      const conflictingRole = yield* router
        .attachEndpoint("alice", ALICE)
        .pipe(Scope.extend(scope), Effect.flip);

      expect(router.address).toBe(ROUTER_URL);
      expect(firstAlice.routerUrl).toBe(ROUTER_URL);
      expect(firstAlice.agent.id).toBe(secondAlice.agent.id);
      expect(firstAlice.key).toBe(secondAlice.key);
      expect(firstProbe.participant.id).toBe(secondProbe.participant.id);
      expect(conflictingRole.operation).toBe("attach-endpoint");
      expect(conflictingRole.detail).toContain("already bound as an agent");
      expect(test.registrations).toEqual(["alice", "probe"]);
      expect(test.timeline).toEqual([]);

      yield* close(scope);

      expect(test.timeline).toEqual([
        "endpoint-close",
        "endpoint-close",
        "router-stop",
        "driver-release",
      ]);
      const stopped = yield* router.stopped;
      expect(stopped.committedMessages).toEqual([
        {
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          senderId: id(1),
          routerSequence: routerSequence(7),
        },
      ]);
    }));

  it("maps acquisition and registration failures to network operations", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const unavailable = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        () => Effect.fail("router unavailable"),
      );
      const acquisition = yield* unavailable.acquire.pipe(
        Scope.extend(scope),
        Effect.flip,
      );

      expect(acquisition.operation).toBe("acquire-router");
      expect(acquisition.detail).toContain("router unavailable");

      const test = harness();
      const registrationFailed: MoltZapRouterDriverAcquirer = (options) =>
        test.acquire(options).pipe(
          Effect.map((driver) => ({
            ...driver,
            register: () => Effect.fail("registration rejected"),
          })),
        );
      const provider = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        registrationFailed,
      );
      const router = yield* provider.acquire.pipe(Scope.extend(scope));
      const registration = yield* router
        .attachAgent("alice", ALICE)
        .pipe(Scope.extend(scope), Effect.flip);

      expect(registration.operation).toBe("attach-agent");
      expect(registration.detail).toContain("registration rejected");
      yield* close(scope);
    }));

  it("normalizes endpoint attachment and release-time collection failures", () =>
    Effect.gen(function* () {
      const base = harness();
      const acquire: MoltZapRouterDriverAcquirer = (options) =>
        base.acquire(options).pipe(
          Effect.map((driver) => ({
            ...driver,
            attachEndpoint: () => Effect.fail("socket authentication failed"),
            stopAndCollect: Effect.fail(
              networkFailure("stop-router", "traffic collection failed"),
            ),
          })),
        );
      const provider = makeMoltZapRouterProviderWith(
        { startupTimeout: STARTUP_TIMEOUT },
        acquire,
      );
      const scope = yield* Scope.make();
      const router = yield* provider.acquire.pipe(Scope.extend(scope));
      const attachment = yield* router
        .attachEndpoint("probe", PROBE)
        .pipe(Scope.extend(scope), Effect.flip);

      expect(attachment.operation).toBe("attach-endpoint");
      expect(attachment.detail).toContain("socket authentication failed");

      yield* close(scope);

      const stopped = yield* router.stopped.pipe(Effect.flip);
      expect(stopped.operation).toBe("stop-router");
      expect(stopped.detail).toContain("traffic collection failed");
    }));
});

/* eslint-enable max-lines-per-function, sonarjs/max-lines-per-function, max-nested-callbacks, sonarjs/no-nested-functions, agent-code-guard/no-hardcoded-assertion-literals -- Restore strict defaults after the scoped file-level exception. */
