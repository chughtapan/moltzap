/** @file Pins the exact events-v3 operation MCP representation. */

import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  AgentAddress,
  Content,
  GroupAddress,
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
const thirdAddress = Schema.decodeUnknownSync(AgentAddress)("agent:carol");
const outsiderAddress = Schema.decodeUnknownSync(AgentAddress)("agent:dave");
const groupAddress = Schema.decodeUnknownSync(GroupAddress)(
  "group:alice,bob,carol",
);
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
  const operation = {
    to: peerAddress,
    text: "meeting invite sent",
    collective: { op: "multicast" },
  };

  expect(
    Effect.runSync(Schema.decodeUnknown(SendInput)(operation, exact)),
  ).toEqual(operation);
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
    address: senderAddress,
    sender: senderAddress,
    content,
  };

  const item = { kind: "multicast", message };

  expect(
    Effect.runSync(decodeHarnessMessageReadyEvent({ deliveryToken, item })),
  ).toEqual({ deliveryToken, item });
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodeHarnessMessageReadyEvent({
          deliveryToken,
          item,
          replyGrant: "forbidden",
        }),
      ),
    ),
  ).toBe(true);
}

function rejectsAnUntaggedMessage(): void {
  const message: InboundMessage = {
    kind: "direct",
    postId,
    address: senderAddress,
    sender: senderAddress,
    content,
  };

  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodeHarnessMessageReadyEvent({ deliveryToken, message }),
      ),
    ),
  ).toBe(true);
}

function decodesCanonicalGroupDelivery(): void {
  const message: InboundMessage = {
    kind: "group",
    postId,
    address: groupAddress,
    sender: peerAddress,
    members: [senderAddress, peerAddress, thirdAddress],
    content,
  };
  const item = { kind: "multicast", message };

  expect(
    Effect.runSync(decodeHarnessMessageReadyEvent({ deliveryToken, item })),
  ).toEqual({ deliveryToken, item });
}

function rejectsInconsistentDeliveryIdentity(): void {
  const invalidMessages = [
    {
      kind: "direct",
      postId,
      address: peerAddress,
      sender: senderAddress,
      content,
    },
    {
      kind: "group",
      postId,
      address: groupAddress,
      sender: peerAddress,
      members: [peerAddress, senderAddress, thirdAddress],
      content,
    },
    {
      kind: "group",
      postId,
      address: groupAddress,
      sender: peerAddress,
      members: [senderAddress, peerAddress, peerAddress],
      content,
    },
    {
      kind: "group",
      postId,
      address: groupAddress,
      sender: outsiderAddress,
      members: [senderAddress, peerAddress, thirdAddress],
      content,
    },
  ];

  for (const message of invalidMessages) {
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          decodeHarnessMessageReadyEvent({
            deliveryToken,
            item: { kind: "multicast", message },
          }),
        ),
      ),
    ).toBe(true);
  }
}

// @agent-code-guard/regression-only: these examples pin the exact public wire grammar and its relational identity checks.
describe("Harness MCP operation representation", () => {
  it("accepts only the empty events-v3 declaration", () => {
    acceptsOnlyEmptyEventsDeclaration();
  });
  it("decodes exact send and acknowledgment requests", () => {
    decodesExactOperationRequests();
  });
  it("decodes one canonical direct multicast delivery", () => {
    decodesCanonicalDirectDelivery();
  });
  it("rejects a delivery that carries a message without an item", () => {
    rejectsAnUntaggedMessage();
  });
  it("decodes one canonical group multicast delivery", () => {
    decodesCanonicalGroupDelivery();
  });
  it("rejects deliveries whose address, members, and sender disagree", () => {
    rejectsInconsistentDeliveryIdentity();
  });
});
