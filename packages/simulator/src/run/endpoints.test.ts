/** @file Regression coverage for controlled endpoint caching and turn inboxes. */

import { assert, it } from "@effect/vitest";
import {
  AgentName,
  ConversationId,
  type HarnessTurn,
  type VerifiedAgentCard,
} from "@moltzap/client";
import { AgentId } from "@moltzap/identity";
import { Effect, Exit, Queue, Schema, Stream } from "effect";
import { makeConversationAddress } from "../network/conversation.js";
import { NetworkError } from "../network/failure.js";
import { makeParticipantHandle } from "../network/participant.js";
import {
  type AcquireControlledEndpoint,
  makeNetworkService,
} from "./endpoints.js";
import { makeLinkFabric } from "./link-fabric.js";

const ENDPOINT_ID = Schema.decodeSync(AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAA");
const ENDPOINT_NAME = Schema.decodeSync(AgentName)("observer");
const AUTHOR_NAME = Schema.decodeSync(AgentName)("author");
const CONVERSATION_ID = Schema.decodeSync(ConversationId)(
  "00000000-0000-4000-8000-000000000103",
);
const PROXY_ORIGIN = new URL("http://fault-proxy.example.test:43120");

function turn(text: string, reply?: HarnessTurn["reply"]): HarnessTurn {
  const author = fakeCard(AUTHOR_NAME);
  return {
    conversationId: CONVERSATION_ID,
    peers: [author],
    author,
    content: [{ type: "text", text }],
    reply: reply ?? (() => Effect.void),
  };
}

function fakeCard(agentName: typeof AgentName.Type): VerifiedAgentCard {
  const candidate: unknown = {
    agentId: "agt_BBBBBBBBBBBBBBBBBBBBBB",
    agentName,
  };
  if (!isFakeVerifiedAgentCard(candidate)) {
    throw new Error("invalid VerifiedAgentCard test fixture");
  }
  return candidate;
}

function isFakeVerifiedAgentCard(value: unknown): value is VerifiedAgentCard {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("agentId" in value) || typeof value.agentId !== "string") {
    return false;
  }
  return "agentName" in value && typeof value.agentName === "string";
}

function cachingEndpointAcquirer(turns: Queue.Queue<HarnessTurn>): {
  readonly acquireEndpoint: AcquireControlledEndpoint;
  readonly acquisitionCount: () => number;
} {
  let acquisitions = 0;
  const acquireEndpoint: AcquireControlledEndpoint = ({ name, routerOrigin }) =>
    Effect.sync(() => {
      acquisitions += 1;
      assert.strictEqual(routerOrigin.href, PROXY_ORIGIN.href);
      return {
        participant: makeParticipantHandle(name, ENDPOINT_ID),
        transport: {
          received: Stream.fromQueue(turns),
          start: () => Effect.void,
        },
      };
    });
  return { acquireEndpoint, acquisitionCount: () => acquisitions };
}

function captureReplyText(capture: { value?: string }): HarnessTurn["reply"] {
  return (content) =>
    Effect.sync(() => {
      const [part] = content;
      if (part?.type === "text") {
        capture.value = part.text;
      } else {
        delete capture.value;
      }
    });
}

it("caches one daemon endpoint and retains one shared conversation cursor", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const turns = yield* Queue.unbounded<HarnessTurn>();
        const endpointAcquirer = cachingEndpointAcquirer(turns);
        const fabric = yield* makeLinkFabric();
        const network = yield* makeNetworkService({
          acquireEndpoint: endpointAcquirer.acquireEndpoint,
          routerOrigin: PROXY_ORIGIN,
          interceptor: fabric.interceptor,
        });
        const endpoint = yield* network.endpoint(ENDPOINT_NAME);
        const repeated = yield* network.endpoint(ENDPOINT_NAME);
        const address = makeConversationAddress(CONVERSATION_ID, [
          endpoint.participant,
        ]);
        const socket = yield* endpoint.socket(address);
        const replyText: { value?: string } = {};

        yield* Queue.offer(turns, turn("first", captureReplyText(replyText)));
        yield* Queue.offer(turns, turn("second"));
        const first = yield* socket.receive();
        const second = yield* socket.receive();
        yield* first.reply([{ type: "text", text: "ack" }]);

        assert.strictEqual(endpoint, repeated);
        assert.strictEqual(endpointAcquirer.acquisitionCount(), 1);
        assert.deepStrictEqual(first.content, [
          { type: "text", text: "first" },
        ]);
        assert.deepStrictEqual(second.content, [
          { type: "text", text: "second" },
        ]);
        assert.strictEqual(replyText.value, "ack");
        yield* fabric.driver.disable(first.author.agentId, ENDPOINT_ID);
        yield* fabric.driver.enable(first.author.agentId, ENDPOINT_ID);
      }),
    ),
  ));

it("retains a terminal acquisition failure for one endpoint name", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        let acquisitions = 0;
        const acquireEndpoint: AcquireControlledEndpoint = () =>
          Effect.suspend(() => {
            acquisitions += 1;
            return Effect.fail(
              NetworkError.make({
                operation: "attach-endpoint",
                detail: `attempt ${String(acquisitions)} failed`,
              }),
            );
          });
        const fabric = yield* makeLinkFabric();
        const network = yield* makeNetworkService({
          acquireEndpoint,
          routerOrigin: PROXY_ORIGIN,
          interceptor: fabric.interceptor,
        });

        const first = yield* network.endpoint(ENDPOINT_NAME).pipe(Effect.exit);
        const second = yield* network.endpoint(ENDPOINT_NAME).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(first));
        assert.isTrue(Exit.isFailure(second));
        assert.strictEqual(acquisitions, 1);
      }),
    ),
  ));
