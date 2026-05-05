/**
 * Typed-bridge regression: the wire decoder is payload-opaque (so
 * `delivery/payload-opacity-client` conformance holds). Inbound typed
 * consumers MUST validate `params` before exposing them to a typed
 * handler. A stale Phase-6 `task/closed` shape (carrying `sessionId` +
 * scalar `closedBy`) is a known-method notification whose method
 * matches `TaskClosedNotificationDefinition`, so a definition-only
 * match would silently bridge a malformed payload into a typed
 * consumer. Both bridges (`acceptTypedNotification` for
 * `waitForNotification` and the shared `validateNotificationParams`
 * helper used by `service.handleNotification`) log and skip instead.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PresenceChangedNotificationDefinition,
  TaskClosedNotificationDefinition,
  agentId,
  conversationId,
  notificationFrame,
  taskId,
} from "@moltzap/protocol";
import {
  acceptTypedNotification,
  validateNotificationParams,
} from "./ws-client.js";
import type { RawDecodedNotification } from "./runtime/frame.js";

type TaskClosedRaw = RawDecodedNotification<
  typeof TaskClosedNotificationDefinition
>;
type PresenceChangedRaw = RawDecodedNotification<
  typeof PresenceChangedNotificationDefinition
>;

// Stale wire-shape fixture as `RawDecodedNotification` (params: unknown):
// the wire decoder is payload-opaque, so the pre-Phase-7 `sessionId` /
// scalar `closedBy` shape is structurally a valid Raw notification.
// `validateNotificationParams` is what rejects it at the typed-bridge
// boundary; the type system distinguishes "decoded from the wire" from
// "validated against the schema."
const STALE_TASK_CLOSED: TaskClosedRaw = {
  jsonrpc: "2.0",
  method: TaskClosedNotificationDefinition.name,
  params: {
    sessionId: "11111111-1111-4111-8111-111111111111",
    closedBy: "33333333-3333-4333-8333-333333333333",
  },
  _tag: "Notification",
  definition: TaskClosedNotificationDefinition,
} as TaskClosedRaw;

const LIVE_TASK_CLOSED: TaskClosedRaw = {
  ...notificationFrame(TaskClosedNotificationDefinition, {
    taskId: taskId("11111111-1111-4111-8111-111111111111"),
    conversations: {
      main: conversationId("22222222-2222-4222-8222-222222222222"),
    },
    closedBy: {
      agentId: agentId("33333333-3333-4333-8333-333333333333"),
      ownerId: "owner-1",
    },
  }),
  _tag: "Notification",
  definition: TaskClosedNotificationDefinition,
};

function makeLogger(): {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("acceptTypedNotification", () => {
  it("rejects a stale `task/closed` payload, logs the drift signal", () => {
    const logger = makeLogger();
    const accepted = acceptTypedNotification(
      TaskClosedNotificationDefinition,
      STALE_TASK_CLOSED,
      logger,
    );
    expect(accepted).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(
      /task\/closed.*drift signal/,
    );
  });

  it("accepts a live `task/closed` payload — proves the validator is not vacuously false", () => {
    const logger = makeLogger();
    const accepted = acceptTypedNotification(
      TaskClosedNotificationDefinition,
      LIVE_TASK_CLOSED,
      logger,
    );
    expect(accepted).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns false for a non-matching definition without invoking validateParams", () => {
    const logger = makeLogger();
    const validateSpy = vi.spyOn(
      TaskClosedNotificationDefinition,
      "validateParams",
    );
    const wrongMethod: PresenceChangedRaw = {
      jsonrpc: "2.0",
      method: PresenceChangedNotificationDefinition.name,
      params: {},
      _tag: "Notification",
      definition: PresenceChangedNotificationDefinition,
    } as PresenceChangedRaw;
    const accepted = acceptTypedNotification(
      TaskClosedNotificationDefinition,
      wrongMethod,
      logger,
    );
    expect(accepted).toBe(false);
    expect(validateSpy).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    validateSpy.mockRestore();
  });

  it("works without a logger (logger is optional)", () => {
    const accepted = acceptTypedNotification(
      TaskClosedNotificationDefinition,
      STALE_TASK_CLOSED,
      undefined,
    );
    expect(accepted).toBe(false);
  });
});

// Tests the shared validation core used by both inbound typed bridges
// (`acceptTypedNotification` and `service.handleNotification`). A
// refactor that breaks the shared core surfaces here, not via downstream
// integration regressions.
describe("validateNotificationParams", () => {
  it("returns false + logs when params fail the attached schema", () => {
    const logger = makeLogger();
    expect(validateNotificationParams(STALE_TASK_CLOSED, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0]?.[0])).toMatch(
      /task\/closed.*drift signal/,
    );
  });

  it("returns true + no log when params conform", () => {
    const logger = makeLogger();
    expect(validateNotificationParams(LIVE_TASK_CLOSED, logger)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
