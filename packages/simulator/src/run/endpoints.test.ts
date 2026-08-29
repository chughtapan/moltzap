/** @file Regression coverage for controlled endpoint caching and delivery inboxes. */

import { assert, it } from "@effect/vitest";
import {
  AgentAddress,
  Content,
  GroupAddress,
  type InboundDelivery,
  MessageAddressInput,
  PostId,
} from "@moltzap/client";
import { AgentId, AgentName } from "@moltzap/identity";
import {
  Duration,
  Effect,
  Encoding,
  Exit,
  Queue,
  Schema,
  Stream,
} from "effect";
import { makeConversationAddress } from "../network/conversation.js";
import { NetworkError } from "../network/failure.js";
import { makeParticipantHandle } from "../network/participant.js";
import {
  type AcquireControlledEndpoint,
  makeNetworkService,
} from "./endpoints.js";
import { makeLinkFabric } from "./link-fabric.js";

const ENDPOINT_ID = Schema.decodeSync(AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAA");
const AUTHOR_ID = Schema.decodeSync(AgentId)("agt_AQAAAAAAAAAAAAAAAAAAAA");
const ZETA_ID = Schema.decodeSync(AgentId)("agt_AgAAAAAAAAAAAAAAAAAAAA");
const ENDPOINT_NAME = Schema.decodeSync(AgentName)("observer");
const ALPHA_NAME = Schema.decodeSync(AgentName)("alpha");
const ZETA_NAME = Schema.decodeSync(AgentName)("zeta");
const AUTHOR_ADDRESS = Schema.decodeSync(AgentAddress)("agent:author");
const ALPHA_ADDRESS = Schema.decodeSync(AgentAddress)("agent:alpha");
const ENDPOINT_ADDRESS = Schema.decodeSync(AgentAddress)("agent:observer");
const ZETA_ADDRESS = Schema.decodeSync(AgentAddress)("agent:zeta");
const NONCANONICAL_GROUP_DESTINATION =
  Schema.decodeSync(MessageAddressInput)("group:zeta,alpha");
const CANONICAL_GROUP_ADDRESS = Schema.decodeSync(GroupAddress)(
  "group:alpha,observer,zeta",
);
const PROXY_ORIGIN = new URL("http://fault-proxy.example.test:43120");

function delivery(input: {
  readonly byte: number;
  readonly text: string;
  readonly acknowledge?: Effect.Effect<void>;
}): InboundDelivery {
  return {
    message: {
      kind: "direct",
      postId: postId(input.byte),
      address: AUTHOR_ADDRESS,
      sender: AUTHOR_ADDRESS,
      content: Schema.decodeSync(Content)([{ type: "text", text: input.text }]),
    },
    acknowledge: input.acknowledge ?? Effect.void,
  };
}

function groupDelivery(): InboundDelivery {
  return {
    message: {
      kind: "group",
      postId: postId(3),
      address: CANONICAL_GROUP_ADDRESS,
      sender: ALPHA_ADDRESS,
      members: [ALPHA_ADDRESS, ENDPOINT_ADDRESS, ZETA_ADDRESS],
      content: Schema.decodeSync(Content)([
        { type: "text", text: "canonical group delivery" },
      ]),
    },
    acknowledge: Effect.void,
  };
}

function postId(byte: number) {
  return Schema.decodeSync(PostId)(
    `pst_${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`,
  );
}

function cachingEndpointAcquirer(deliveries: Queue.Queue<InboundDelivery>): {
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
          received: Stream.fromQueue(deliveries),
          send: () => Effect.void,
        },
      };
    });
  return { acquireEndpoint, acquisitionCount: () => acquisitions };
}

it("caches one daemon endpoint and retains one shared address cursor", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deliveries = yield* Queue.unbounded<InboundDelivery>();
        const endpointAcquirer = cachingEndpointAcquirer(deliveries);
        const fabric = yield* makeLinkFabric();
        const network = yield* makeNetworkService({
          acquireEndpoint: endpointAcquirer.acquireEndpoint,
          routerOrigin: PROXY_ORIGIN,
          interceptor: fabric.interceptor,
        });
        const endpoint = yield* network.endpoint(ENDPOINT_NAME);
        const repeated = yield* network.endpoint(ENDPOINT_NAME);
        const address = makeConversationAddress(AUTHOR_ADDRESS, [
          endpoint.participant,
        ]);
        const socket = yield* endpoint.socket(address);
        let acknowledged = false;

        yield* Queue.offer(
          deliveries,
          delivery({
            byte: 1,
            text: "first",
            acknowledge: Effect.sync(() => {
              acknowledged = true;
            }),
          }),
        );
        yield* Queue.offer(deliveries, delivery({ byte: 2, text: "second" }));
        const first = yield* socket.receive();
        const second = yield* socket.receive();
        yield* first.acknowledge;

        assert.strictEqual(endpoint, repeated);
        assert.strictEqual(endpointAcquirer.acquisitionCount(), 1);
        assert.deepStrictEqual(first.message.content, [
          { type: "text", text: "first" },
        ]);
        assert.deepStrictEqual(second.message.content, [
          { type: "text", text: "second" },
        ]);
        assert.isTrue(acknowledged);
        yield* fabric.driver.disable(AUTHOR_ID, ENDPOINT_ID);
        yield* fabric.driver.enable(AUTHOR_ID, ENDPOINT_ID);
      }),
    ),
  ));

it("routes an input-order group socket to the canonical delivered group", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deliveries = yield* Queue.unbounded<InboundDelivery>();
        const endpointAcquirer = cachingEndpointAcquirer(deliveries);
        const fabric = yield* makeLinkFabric();
        const network = yield* makeNetworkService({
          acquireEndpoint: endpointAcquirer.acquireEndpoint,
          routerOrigin: PROXY_ORIGIN,
          interceptor: fabric.interceptor,
        });
        const endpoint = yield* network.endpoint(ENDPOINT_NAME);
        const alpha = makeParticipantHandle(ALPHA_NAME, AUTHOR_ID);
        const zeta = makeParticipantHandle(ZETA_NAME, ZETA_ID);
        const address = makeConversationAddress(
          NONCANONICAL_GROUP_DESTINATION,
          [endpoint.participant, alpha, zeta],
        );
        const socket = yield* endpoint.socket(address);

        yield* Queue.offer(deliveries, groupDelivery());
        const received = yield* socket.receive().pipe(
          Effect.timeoutFail({
            duration: Duration.seconds(1),
            onTimeout: () =>
              NetworkError.make({
                operation: "receive",
                detail: "canonical group delivery did not reach its socket",
              }),
          }),
        );

        assert.strictEqual(received.message.address, CANONICAL_GROUP_ADDRESS);
        assert.strictEqual(received.message.kind, "group");
        if (received.message.kind === "group") {
          assert.deepStrictEqual(received.message.members, [
            ALPHA_ADDRESS,
            ENDPOINT_ADDRESS,
            ZETA_ADDRESS,
          ]);
        }
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
