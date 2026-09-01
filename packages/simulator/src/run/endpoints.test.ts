/** @file Controlled endpoint caching and live delivery stream regressions. */

import { assert, it } from "@effect/vitest";
import {
  AgentAddress,
  Content,
  GroupAddress,
  type InboundDelivery,
  PostId,
} from "@moltzap/client";
import { AgentId, AgentName } from "@moltzap/identity";
import {
  Deferred,
  Effect,
  Encoding,
  Exit,
  Fiber,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { Endpoint } from "../network/endpoint.js";
import { NetworkError } from "../network/failure.js";
import { makeParticipantHandle } from "../network/participant.js";
import {
  type AcquireControlledEndpoint,
  makeNetworkService,
} from "./endpoints.js";
import { makeLinkFabric } from "./link-fabric.js";

const ENDPOINT_ID = Schema.decodeSync(AgentId)("agt_AAAAAAAAAAAAAAAAAAAAAA");
const AUTHOR_ID = Schema.decodeSync(AgentId)("agt_AQAAAAAAAAAAAAAAAAAAAA");
const ENDPOINT_NAME = Schema.decodeSync(AgentName)("observer");
const AUTHOR_ADDRESS = Schema.decodeSync(AgentAddress)("agent:author");
const ALPHA_ADDRESS = Schema.decodeSync(AgentAddress)("agent:alpha");
const ENDPOINT_ADDRESS = Schema.decodeSync(AgentAddress)("agent:observer");
const ZETA_ADDRESS = Schema.decodeSync(AgentAddress)("agent:zeta");
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

function cachingEndpointAcquirer(
  received: Stream.Stream<InboundDelivery, NetworkError>,
): {
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
        transport: { received, send: () => Effect.void },
      };
    });
  return { acquireEndpoint, acquisitionCount: () => acquisitions };
}

function assertFanout(
  first: readonly InboundDelivery[],
  second: readonly InboundDelivery[],
): void {
  assert.deepStrictEqual(
    first.map(({ message }) => message.content),
    [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]],
  );
  assert.deepStrictEqual(second, first);
}

function collectTwoDeliveries(endpoint: Endpoint) {
  return endpoint
    .messages()
    .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
}

function fanoutTest() {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deliveries = yield* Queue.unbounded<InboundDelivery>();
        const endpointAcquirer = cachingEndpointAcquirer(
          Stream.fromQueue(deliveries),
        );
        const fabric = yield* makeLinkFabric();
        const network = yield* makeNetworkService({
          acquireEndpoint: endpointAcquirer.acquireEndpoint,
          routerOrigin: PROXY_ORIGIN,
          interceptor: fabric.interceptor,
        });
        const endpoint = yield* network.endpoint(ENDPOINT_NAME);
        const repeated = yield* network.endpoint(ENDPOINT_NAME);
        let acknowledged = false;
        const firstSubscriber = yield* collectTwoDeliveries(endpoint);
        const secondSubscriber = yield* collectTwoDeliveries(endpoint);
        yield* Effect.yieldNow();
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

        const firstDeliveries = Array.from(yield* Fiber.join(firstSubscriber));
        const secondDeliveries = Array.from(
          yield* Fiber.join(secondSubscriber),
        );
        const firstDelivery = firstDeliveries[0];
        assert.exists(firstDelivery);
        yield* firstDelivery.acknowledge;

        assert.strictEqual(endpoint, repeated);
        assert.strictEqual(endpointAcquirer.acquisitionCount(), 1);
        assertFanout(firstDeliveries, secondDeliveries);
        assert.isTrue(acknowledged);
        yield* fabric.driver.disable(AUTHOR_ID, ENDPOINT_ID);
        yield* fabric.driver.enable(AUTHOR_ID, ENDPOINT_ID);
      }),
    ),
  );
}

it(
  "caches one endpoint and fans out ordered deliveries to live subscribers",
  fanoutTest,
);

it("does not replay earlier traffic and preserves the delivered group facts", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deliveries = yield* Queue.unbounded<InboundDelivery>();
        const earlierDeliveryPublished = yield* Deferred.make<undefined>();
        const received = Stream.make(
          delivery({ byte: 1, text: "before subscription" }),
        ).pipe(
          Stream.concat(
            Stream.fromEffect(
              Deferred.succeed(earlierDeliveryPublished, undefined),
            ).pipe(Stream.drain),
          ),
          Stream.concat(Stream.fromQueue(deliveries)),
        );
        const endpointAcquirer = cachingEndpointAcquirer(received);
        const fabric = yield* makeLinkFabric();
        const network = yield* makeNetworkService({
          acquireEndpoint: endpointAcquirer.acquireEndpoint,
          routerOrigin: PROXY_ORIGIN,
          interceptor: fabric.interceptor,
        });
        const endpoint = yield* network.endpoint(ENDPOINT_NAME);
        yield* Deferred.await(earlierDeliveryPublished);

        const subscriber = yield* endpoint
          .messages()
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
        yield* Effect.yieldNow();
        yield* Queue.offer(deliveries, groupDelivery());
        const observed = Array.from(yield* Fiber.join(subscriber));

        assert.lengthOf(observed, 1);
        assert.strictEqual(
          observed[0]?.message.address,
          CANONICAL_GROUP_ADDRESS,
        );
        assert.strictEqual(observed[0]?.message.kind, "group");
        if (observed[0]?.message.kind === "group") {
          assert.deepStrictEqual(observed[0].message.members, [
            ALPHA_ADDRESS,
            ENDPOINT_ADDRESS,
            ZETA_ADDRESS,
          ]);
        }
      }),
    ),
  ));

it("exposes terminal completion and receive failure to later subscribers", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fabric = yield* makeLinkFabric();
        const completedNetwork = yield* makeNetworkService({
          acquireEndpoint: cachingEndpointAcquirer(Stream.empty)
            .acquireEndpoint,
          routerOrigin: PROXY_ORIGIN,
          interceptor: fabric.interceptor,
        });
        const completed = yield* completedNetwork.endpoint(ENDPOINT_NAME);
        const completedDeliveries = yield* Stream.runCollect(
          completed.messages(),
        );

        const failure = NetworkError.make({
          operation: "receive",
          detail: "ingress stopped",
        });
        const failureFabric = yield* makeLinkFabric();
        const failedNetwork = yield* makeNetworkService({
          acquireEndpoint: cachingEndpointAcquirer(Stream.fail(failure))
            .acquireEndpoint,
          routerOrigin: PROXY_ORIGIN,
          interceptor: failureFabric.interceptor,
        });
        const failed = yield* failedNetwork.endpoint(
          Schema.decodeSync(AgentName)("failed-observer"),
        );
        const observedFailure = yield* Stream.runDrain(failed.messages()).pipe(
          Effect.flip,
        );

        assert.isEmpty(Array.from(completedDeliveries));
        assert.strictEqual(observedFailure, failure);
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
