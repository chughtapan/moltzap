/** @file Pins the exact events-v2 addressed-message MCP representation. */

import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentAddress,
  Content,
  type InboundMessage,
  PostId,
  SendInput,
} from "./contract.js";
import { DeliveryToken } from "./endpoint/store.js";
import {
  decodeHarnessAcknowledgeDeliveryRequest,
  decodeHarnessEventsExtensionDeclaration,
  decodeHarnessMessageReadyEvent,
} from "./harness-mcp-contract.js";

const exact = { exact: true, onExcessProperty: "error" } as const;
const deliveryToken = Schema.decodeUnknownSync(DeliveryToken)(
  `dlv_${"A".repeat(43)}`,
);
const peerAddress = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const senderAddress = Schema.decodeUnknownSync(AgentAddress)("agent:alice");
const postId = Schema.decodeUnknownSync(PostId)(`pst_${"A".repeat(43)}`);
const content = Schema.decodeUnknownSync(Content)([
  { type: "text", text: "meeting invite sent" },
]);

function acceptsOnlyEmptyEventsDeclaration(): void {
  expect(Effect.runSync(decodeHarnessEventsExtensionDeclaration({}))).toEqual(
    {},
  );
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodeHarnessEventsExtensionDeclaration({ version: 2 }),
      ),
    ),
  ).toBe(true);
}

function decodesExactOperationRequests(): void {
  expect(
    Effect.runSync(
      Schema.decodeUnknown(SendInput)({ to: peerAddress, content }, exact),
    ),
  ).toEqual({ to: peerAddress, content });
  expect(
    Effect.runSync(decodeHarnessAcknowledgeDeliveryRequest({ deliveryToken })),
  ).toEqual({ deliveryToken });
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodeHarnessAcknowledgeDeliveryRequest({ deliveryToken, content }),
      ),
    ),
  ).toBe(true);
}

function decodesCanonicalDirectDelivery(): void {
  const message: InboundMessage = {
    kind: "direct",
    postId,
    address: peerAddress,
    sender: senderAddress,
    content,
  };

  expect(
    Effect.runSync(decodeHarnessMessageReadyEvent({ deliveryToken, message })),
  ).toEqual({ deliveryToken, message });
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodeHarnessMessageReadyEvent({
          deliveryToken,
          message,
          replyGrant: "forbidden",
        }),
      ),
    ),
  ).toBe(true);
}

describe("Harness MCP addressed-message representation", () => {
  it("accepts only the empty events-v2 declaration", () => {
    acceptsOnlyEmptyEventsDeclaration();
  });
  it("decodes exact send and acknowledgment requests", () => {
    decodesExactOperationRequests();
  });
  it("decodes one canonical direct-message delivery", () => {
    decodesCanonicalDirectDelivery();
  });
});
