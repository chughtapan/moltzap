/** @file Pins the exact inbox and operation MCP representation. */

import { Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../transport/messaging/message.js";
import { DeliveryToken } from "../store/index.js";
import { CollectiveId, SendInput } from "../transport/collectives/forms.js";
import { Content, PostId } from "../transport/wire/index.js";
import { AgentAddress, GroupAddress } from "../transport/wire/values.js";
import {
  decodeHarnessAcknowledgeDeliveryRequest,
  decodeHarnessMessageReadyEvent,
  decodeHarnessSendErrorData,
} from "./operations.js";

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
    "acknowledgment carrying content",
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
    "delivery carrying a reply grant",
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
    "delivery carrying a bare message",
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

const inconsistentDeliveries = [
  {
    case: "a direct address that is not the sender",
    message: {
      kind: "direct",
      postId,
      address: peerAddress,
      sender: senderAddress,
      content,
    },
  },
  {
    case: "group members out of canonical order",
    message: {
      kind: "group",
      postId,
      address: groupAddress,
      sender: peerAddress,
      members: [peerAddress, senderAddress, thirdAddress],
      content,
    },
  },
  {
    case: "a repeated group member",
    message: {
      kind: "group",
      postId,
      address: groupAddress,
      sender: peerAddress,
      members: [senderAddress, peerAddress, peerAddress],
      content,
    },
  },
  {
    case: "a sender outside the group",
    message: {
      kind: "group",
      postId,
      address: groupAddress,
      sender: outsiderAddress,
      members: [senderAddress, peerAddress, thirdAddress],
      content,
    },
  },
];

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
  it.each(inconsistentDeliveries)(
    "rejects a delivery with $case",
    ({ message }) => {
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
    },
  );
  // A refused collective names each unreachable member with a send failure
  // reason; a reason outside that vocabulary must not decode.
  it.each(["unknown-agent", "network-unavailable"])(
    "decodes an unreachable member with send failure reason %s",
    (reason) => {
      expect(
        Effect.runSync(decodeHarnessSendErrorData(unreachableFailure(reason))),
      ).toEqual(unreachableFailure(reason));
    },
  );
  it("rejects an unreachable member whose reason is not a send failure", () => {
    expect(
      Exit.isFailure(
        Effect.runSyncExit(
          decodeHarnessSendErrorData(unreachableFailure("transport-failed")),
        ),
      ),
    ).toBe(true);
  });
});
