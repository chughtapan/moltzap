/** @file Pins the exact inbox and operation MCP representation. */

import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../../transport/messaging/message.js";
import {
  decodeHarnessAcknowledgeDeliveryRequest,
  decodeHarnessMessageReadyEvent,
  decodeHarnessSendErrorData,
} from "../../delivery/operations.js";
import { DeliveryToken } from "../../store/index.js";
import { CollectiveId, SendInput } from "../../transport/collectives/forms.js";
import {
  AgentAddress,
  GroupAddress,
} from "../../transport/messaging/address.js";
import { Content, PostId } from "../../transport/wire/index.js";

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

const collectiveId = Schema.decodeUnknownSync(CollectiveId)(
  `col_${"A".repeat(43)}`,
);

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

function decodesUnreachableMembersBySendReason(): void {
  for (const reason of ["unknown-agent", "network-unavailable"]) {
    expect(
      Effect.runSync(decodeHarnessSendErrorData(unreachableFailure(reason))),
    ).toEqual(unreachableFailure(reason));
  }
  expect(
    Exit.isFailure(
      Effect.runSyncExit(
        decodeHarnessSendErrorData(unreachableFailure("transport-failed")),
      ),
    ),
  ).toBe(true);
}

function unreachableFailure(reason: string) {
  return {
    reason: "collective-failed",
    id: collectiveId,
    failure: {
      kind: "members-unreachable",
      members: [{ member: peerAddress, reason }],
    },
  };
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
  // A refused collective names each unreachable member with a send failure
  // reason; a reason outside that vocabulary must not decode.
  it("decodes unreachable members only with a send failure reason", () => {
    decodesUnreachableMembersBySendReason();
  });
});
