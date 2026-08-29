/** @file Regression coverage for public conversation address construction. */

import { assert, it } from "@effect/vitest";
import { MessageAddressInput } from "@moltzap/client";
import { AgentId } from "@moltzap/identity";
import { Schema } from "effect";
import { ConversationAddress } from "./conversation.js";
import { makeParticipantHandle } from "./participant.js";

const destination = Schema.decodeSync(MessageAddressInput)("agent:author");
const participant = makeParticipantHandle(
  "observer",
  Schema.decodeSync(AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAA"),
);

// @agent-code-guard/regression-only: the public constructor binds an explicit destination to receive-only simulator sockets
it("constructs one immutable address from a defensive participant copy", () => {
  const participants = [participant] satisfies [typeof participant];
  const address = new ConversationAddress(destination, participants);
  participants.push(participant);

  assert.strictEqual(address.destination, destination);
  assert.deepStrictEqual(address.participants, [participant]);
  assert.isTrue(Object.isFrozen(address));
  assert.isTrue(Object.isFrozen(address.participants));
});

it("rejects an empty participant set at the JavaScript boundary", () => {
  assert.throws(
    () => {
      Reflect.construct(ConversationAddress, [destination, []]);
    },
    TypeError,
    "conversation participants must not be empty",
  );
});

it("rejects duplicate participant identities", () => {
  assert.throws(
    () => {
      Reflect.construct(ConversationAddress, [
        destination,
        [participant, participant],
      ]);
    },
    TypeError,
    "conversation participants must be unique by AgentId",
  );
});
