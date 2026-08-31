/** @file Endpoint live delivery exposure and addressed send delegation. */

import { assert, it } from "@effect/vitest";
import { Content, MessageAddressInput, type SendInput } from "@moltzap/client";
import { AgentId } from "@moltzap/identity";
import { Effect, Schema, Stream } from "effect";
import { type EndpointInbox, makeEndpoint } from "./endpoint.js";
import { makeParticipantHandle } from "./participant.js";

const observerId = Schema.decodeUnknownSync(AgentId)(
  "agt_AAAAAAAAAAAAAAAAAAAAAA",
);
const destination =
  Schema.decodeUnknownSync(MessageAddressInput)("agent:other");
const sendInput: SendInput = {
  to: destination,
  content: Schema.decodeUnknownSync(Content)([{ type: "text", text: "hello" }]),
};

const inbox: EndpointInbox = {
  messages: Stream.empty,
};

it("exposes the run-owned live delivery stream", () => {
  const participant = makeParticipantHandle("observer", observerId);
  const endpoint = makeEndpoint(
    {
      participant,
      transport: { received: Stream.empty, send: () => Effect.void },
    },
    inbox,
  );

  assert.strictEqual(endpoint.messages(), inbox.messages);
});

it.effect("delegates addressed send without exposing its daemon client", () =>
  Effect.gen(function* () {
    const participant = makeParticipantHandle("observer", observerId);
    let observed: SendInput | undefined;
    const endpoint = makeEndpoint(
      {
        participant,
        transport: {
          received: Stream.empty,
          send: (input) =>
            Effect.sync(() => {
              observed = input;
            }),
        },
      },
      inbox,
    );

    yield* endpoint.send(sendInput);

    assert.strictEqual(observed, sendInput);
  }),
);
