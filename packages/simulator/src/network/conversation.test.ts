/** @file Regression coverage for public conversation address construction. */

import { assert, it } from "@effect/vitest";
import { ConversationId } from "@moltzap/client";
import { AgentId } from "@moltzap/identity";
import { Schema } from "effect";
import { ConversationAddress } from "./conversation.js";
import { makeParticipantHandle } from "./participant.js";

const conversationId = Schema.decodeSync(ConversationId)(
  "00000000-0000-4000-8000-000000000104",
);
const participant = makeParticipantHandle(
  "observer",
  Schema.decodeSync(AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAA"),
);

// @agent-code-guard/regression-only: the public constructor is the retained bridge from caller-minted Client identity to receive-only simulator sockets
it("constructs one immutable address from a defensive participant copy", () => {
  const participants = [participant] satisfies [typeof participant];
  const address = new ConversationAddress(conversationId, participants);
  participants.push(participant);

  assert.strictEqual(address.conversationId, conversationId);
  assert.deepStrictEqual(address.participants, [participant]);
  assert.isTrue(Object.isFrozen(address));
  assert.isTrue(Object.isFrozen(address.participants));
});

it("rejects an empty participant set at the JavaScript boundary", () => {
  assert.throws(
    () => {
      Reflect.construct(ConversationAddress, [conversationId, []]);
    },
    TypeError,
    "conversation participants must not be empty",
  );
});

it("rejects duplicate participant identities", () => {
  assert.throws(
    () => {
      Reflect.construct(ConversationAddress, [
        conversationId,
        [participant, participant],
      ]);
    },
    TypeError,
    "conversation participants must be unique by AgentId",
  );
});
