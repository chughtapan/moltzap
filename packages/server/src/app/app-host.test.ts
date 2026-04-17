import { describe, expect, it } from "vitest";
import { it as itEffect } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, TestClock } from "effect";
import type { Broadcaster } from "../ws/broadcaster.js";
import { makeFakeService } from "../test-utils/fakes.js";
import {
  DefaultPermissionService,
  PermissionDeniedError,
  PermissionTimeoutError,
} from "./app-host.js";

describe("PermissionDeniedError", () => {
  it("carries the correct _tag", () => {
    const err = new PermissionDeniedError({ resource: "contacts.read" });
    expect(err._tag).toBe("PermissionDenied");
  });

  it("exposes the resource field verbatim", () => {
    const err = new PermissionDeniedError({ resource: "contacts.read" });
    expect(err.resource).toBe("contacts.read");
  });

  it("renders a message that embeds the resource", () => {
    const err = new PermissionDeniedError({ resource: "files.write" });
    expect(err.message).toBe("Permission denied for resource: files.write");
  });

  it("supports construction with empty-string resource without blowing up", () => {
    // `destroy()` passes the resource name directly into `reject(reason)`
    // to preserve the message shape; empty strings are valid (if ugly).
    const err = new PermissionDeniedError({ resource: "" });
    expect(err.resource).toBe("");
    expect(err.message).toBe("Permission denied for resource: ");
  });
});

describe("PermissionTimeoutError", () => {
  it("carries the correct _tag", () => {
    const err = new PermissionTimeoutError({ resource: "contacts.read" });
    expect(err._tag).toBe("PermissionTimeout");
  });

  it("exposes the resource field verbatim", () => {
    const err = new PermissionTimeoutError({ resource: "contacts.read" });
    expect(err.resource).toBe("contacts.read");
  });

  it("renders a message that embeds the resource", () => {
    const err = new PermissionTimeoutError({ resource: "files.write" });
    expect(err.message).toBe("Permission timeout for resource: files.write");
  });
});

describe("Permission errors are distinct tagged classes", () => {
  it("_tag discriminates denied vs timeout", () => {
    const denied = new PermissionDeniedError({ resource: "r" });
    const timeout = new PermissionTimeoutError({ resource: "r" });
    expect(denied._tag).not.toBe(timeout._tag);
    expect(denied instanceof PermissionDeniedError).toBe(true);
    expect(denied instanceof PermissionTimeoutError).toBe(false);
    expect(timeout instanceof PermissionTimeoutError).toBe(true);
    expect(timeout instanceof PermissionDeniedError).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// DefaultPermissionService.requestPermission — TestClock-driven
// ─────────────────────────────────────────────────────────────────────
//
// `requestPermission` uses `Effect.timeoutFail` against the Effect Clock
// (not raw setTimeout), so `TestClock.adjust(Duration.millis(N))` drives
// the timeout in virtual time. Zero real waits.

function makeFakeBroadcaster(): {
  broadcaster: Broadcaster;
  sent: Array<{ agentId: string; event: unknown }>;
} {
  const sent: Array<{ agentId: string; event: unknown }> = [];
  const broadcaster = makeFakeService<Broadcaster>({
    sendToAgent: (agentId: string, event: unknown) => {
      sent.push({ agentId, event });
    },
  } as Partial<Broadcaster>);
  return { broadcaster, sent };
}

describe("DefaultPermissionService.requestPermission", () => {
  itEffect(
    "fails with PermissionTimeoutError after timeoutMs virtual-elapses",
    () =>
      Effect.gen(function* () {
        const { broadcaster } = makeFakeBroadcaster();
        const svc = new DefaultPermissionService(broadcaster);

        const fiber = yield* Effect.fork(
          svc.requestPermission({
            userId: "u1",
            agentId: "a1",
            sessionId: "s1",
            appId: "app1",
            resource: "contacts.read",
            access: ["read"],
            timeoutMs: 200,
          }),
        );

        // Let the Effect.async body register its pending entry before we
        // advance virtual time.
        yield* Effect.yieldNow();

        yield* TestClock.adjust(Duration.millis(200));

        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const err = (exit.cause as any).error;
          expect(err).toBeInstanceOf(PermissionTimeoutError);
          expect(err._tag).toBe("PermissionTimeout");
          expect(err.resource).toBe("contacts.read");
        }
      }),
  );

  itEffect("broadcasts a permission-required event synchronously", () =>
    Effect.gen(function* () {
      const { broadcaster, sent } = makeFakeBroadcaster();
      const svc = new DefaultPermissionService(broadcaster);

      const fiber = yield* Effect.fork(
        svc.requestPermission({
          userId: "u1",
          agentId: "a1",
          sessionId: "s1",
          appId: "app1",
          resource: "contacts.read",
          access: ["read"],
          timeoutMs: 50,
        }),
      );

      // After one scheduler tick the Effect.async body has run its
      // registration + emitted the event frame.
      yield* Effect.yieldNow();

      expect(sent.length).toBe(1);
      expect(sent[0]!.agentId).toBe("a1");
      const ev = sent[0]!.event as {
        type: string;
        event: string;
        data: { resource: string; targetUserId: string };
      };
      expect(ev.type).toBe("event");
      expect(ev.data.resource).toBe("contacts.read");
      expect(ev.data.targetUserId).toBe("u1");

      // Settle the forked fiber so it doesn't leak into sibling tests.
      yield* TestClock.adjust(Duration.millis(100));
      yield* Fiber.await(fiber);
    }),
  );

  itEffect(
    "resolvePermission shortcut succeeds before the virtual timeout",
    () =>
      Effect.gen(function* () {
        const { broadcaster } = makeFakeBroadcaster();
        const svc = new DefaultPermissionService(broadcaster);

        const fiber = yield* Effect.fork(
          svc.requestPermission({
            userId: "u1",
            agentId: "a1",
            sessionId: "s1",
            appId: "app1",
            resource: "contacts.read",
            access: ["read"],
            timeoutMs: 60_000,
          }),
        );

        // Wait for the pending entry to register before we grant.
        yield* Effect.yieldNow();

        svc.resolvePermission("u1", "s1", "a1", "contacts.read", ["read"]);

        const exit = yield* Fiber.await(fiber);
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value).toEqual(["read"]);
        }
      }),
  );

  itEffect(
    "fiber interrupt runs the Effect.async cleanup and empties pendingPermissions",
    () =>
      Effect.gen(function* () {
        const { broadcaster } = makeFakeBroadcaster();
        const svc = new DefaultPermissionService(broadcaster);

        const fiber = yield* Effect.fork(
          svc.requestPermission({
            userId: "u1",
            agentId: "a1",
            sessionId: "s1",
            appId: "app1",
            resource: "contacts.read",
            access: ["read"],
            timeoutMs: 120_000,
          }),
        );

        yield* Effect.yieldNow();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pendingMap = (svc as any).pendingPermissions as Map<
          string,
          unknown
        >;
        expect(pendingMap.size).toBe(1);

        yield* Fiber.interrupt(fiber);

        expect(pendingMap.size).toBe(0);
      }),
  );
});
