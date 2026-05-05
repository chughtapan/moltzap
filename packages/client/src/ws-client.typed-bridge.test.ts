/**
 * R11 regression: the typed-bridge between the wire decoder (which is
 * payload-opaque per `delivery/payload-opacity-client` conformance) and
 * the typed `waitForNotification` consumer must validate `params`
 * against `definition.validateParams`. A stale Phase-6 `task/closed`
 * shape (carrying `sessionId` + scalar `closedBy`) is a known-method
 * notification whose method DOES match `TaskClosedNotificationDefinition`,
 * so a definition-only match would silently bridge a malformed payload
 * into a typed consumer. The bridge logs and skips instead.
 */
import { describe, expect, it, vi } from "vitest";
import {
  TaskClosedNotificationDefinition,
  agentId,
  conversationId,
  notificationFrame,
  taskId,
} from "@moltzap/protocol";
import { acceptTypedNotification } from "./ws-client.js";
import type { DecodedNotification } from "./runtime/frame.js";

const STALE_TASK_CLOSED: DecodedNotification = {
  _tag: "Notification",
  jsonrpc: "2.0",
  method: TaskClosedNotificationDefinition.name,
  // Pre-Phase-7 shape: `sessionId` (renamed → `taskId`) + scalar
  // `closedBy` (now `{agentId, ownerId}` envelope).
  params: {
    sessionId: "11111111-1111-4111-8111-111111111111",
    closedBy: "33333333-3333-4333-8333-333333333333",
  },
  definition: TaskClosedNotificationDefinition,
} as unknown as DecodedNotification; // #ignore-sloppy-code[as-unknown-as]: hand-built fixture for typed-bridge unit test bypasses brand validation

const LIVE_TASK_CLOSED: DecodedNotification = {
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
} as unknown as DecodedNotification; // #ignore-sloppy-code[as-unknown-as]: hand-built fixture for typed-bridge unit test bypasses brand validation

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

describe("acceptTypedNotification (R11 typed-bridge validation)", () => {
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
    const wrongMethod: DecodedNotification = {
      _tag: "Notification",
      jsonrpc: "2.0",
      method: "presence/changed",
      params: {},
      definition: { name: "presence/changed" },
    } as unknown as DecodedNotification; // #ignore-sloppy-code[as-unknown-as]: hand-built fixture for typed-bridge unit test bypasses brand validation
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
