/**
 * Drives a stale-shape notification through the real subscriber →
 * service → typed-handler dispatch path (`handleNotification` →
 * `notificationHandlers.dispatch`). The helper test in
 * `ws-client.typed-bridge.test.ts` exercises `validateNotificationParams`
 * in isolation; this file proves the subscriber-fanout bridge actually
 * invokes it and skips dispatch on drift, so the stale frame never
 * reaches the typed handler bound inside `createNotificationHandlers`.
 *
 * Discriminating choice: `ConversationArchivedNotificationDefinition`
 * is one of the five notifications in `serviceNotificationGroup`, so a
 * payload missing the required `archivedAt` field hits the typed-handler
 * dispatch path (which would call `markConversationArchived` +
 * `fanout(handlers.conversationArchived, ...)`). The regression asserts:
 *   1. The typed `conversationArchived` user handler is NOT invoked.
 *   2. The internal `archivedConversationIds` set is NOT updated.
 *   3. The raw-notification handler IS invoked (proves the
 *      pre-validation surface still fires; only the typed dispatch is
 *      gated).
 *   4. A drift warning is logged with the notification name.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ConversationArchivedNotificationDefinition,
  agentId,
  conversationId,
  notificationFrame,
  type AnyNotificationDefinition,
} from "@moltzap/protocol";
import { MoltZapService } from "./service.js";
import type { DecodedNotification } from "./runtime/frame.js";

class TestMoltZapService extends MoltZapService {
  public driveNotification(
    notification: DecodedNotification<AnyNotificationDefinition>,
  ): void {
    this.handleNotification(notification);
  }
}

const CONV_ID = conversationId("00000000-0000-4000-8000-000000c0a4ed");
const BY_AGENT = agentId("00000000-0000-4000-8000-0000000a9e47");

type ConversationArchivedDecoded = DecodedNotification<
  typeof ConversationArchivedNotificationDefinition
>;

const STALE_ARCHIVED = {
  _tag: "Notification",
  jsonrpc: "2.0",
  method: ConversationArchivedNotificationDefinition.name,
  // Missing the required `archivedAt` field — schema requires all
  // three fields with `additionalProperties: false`. The cast models a
  // stale wire frame the opaque decoder forwards without payload
  // validation; the deeper RawDecoded vs Decoded split would erase it
  // (deferred to a follow-up phase).
  params: { conversationId: CONV_ID, by: BY_AGENT },
  definition: ConversationArchivedNotificationDefinition,
} as unknown as ConversationArchivedDecoded; // #ignore-sloppy-code[as-unknown-as]: stale-shape fixture; structurally compatible with DecodedNotification but TS can't narrow params

const LIVE_ARCHIVED: ConversationArchivedDecoded = {
  ...notificationFrame(ConversationArchivedNotificationDefinition, {
    conversationId: CONV_ID,
    archivedAt: "2026-05-05T00:00:00.000Z",
    by: BY_AGENT,
  }),
  _tag: "Notification",
  definition: ConversationArchivedNotificationDefinition,
};

describe("MoltZapService.handleNotification subscriber-fanout bridge", () => {
  it("skips typed dispatch on a stale shape, fans out raw, and logs drift", () => {
    const warn = vi.fn();
    const service = new TestMoltZapService({
      serverUrl: "ws://test",
      agentKey: "test-key",
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const onArchived = vi.fn();
    const onRaw = vi.fn();
    service.on("conversationArchived", onArchived);
    service.on("rawNotification", onRaw);

    service.driveNotification(STALE_ARCHIVED);

    // Typed handler MUST NOT see the malformed payload.
    expect(onArchived).not.toHaveBeenCalled();
    expect(service.isConversationArchived(CONV_ID)).toBe(false);

    // Raw-notification handler still fires — fanout runs before the
    // typed-bridge gate, so subscribers using the opaque surface are
    // unaffected.
    expect(onRaw).toHaveBeenCalledTimes(1);

    // Drift warning surfaced via the WsClientLogger.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /conversations\/archived.*drift signal/,
    );
  });

  it("dispatches a live shape to the typed handler and updates internal state", () => {
    const warn = vi.fn();
    const service = new TestMoltZapService({
      serverUrl: "ws://test",
      agentKey: "test-key",
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const onArchived = vi.fn();
    service.on("conversationArchived", onArchived);

    service.driveNotification(LIVE_ARCHIVED);

    expect(onArchived).toHaveBeenCalledTimes(1);
    expect(service.isConversationArchived(CONV_ID)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
