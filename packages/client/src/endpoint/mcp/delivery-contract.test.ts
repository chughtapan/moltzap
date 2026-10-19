/** @file Durable delivery behaviour through the loopback MCP tools and native endpoint. */

import { scopedLive as it } from "@effect/vitest";
import { Effect, Option, Schema, Scope, Stream } from "effect";
import { describe, expect } from "vitest";
import { digest } from "../../__tests__/agent-card-fixtures.js";
import { makeToolCallRequest } from "../../__tests__/daemon-runtime-harness.js";
import { loopbackMcpEndpoint } from "../../__tests__/mcp-http-fixtures.js";
import { pendingMessage } from "../../__tests__/pending-delivery-fixtures.js";
import { stateDirectory } from "../../__tests__/store-schema-fixtures.js";
import { makeHostDelivery } from "../../delivery/host-delivery.js";
import { decodeHarnessReadInboxResult } from "../../delivery/operations.js";
import { openEndpointStore } from "../../store/index.js";
import {
  CollectiveEmitError,
  CollectiveId,
} from "../../transport/collectives/forms.js";
import {
  type CollectiveOperations,
  makeCollectiveOperations,
} from "../../transport/collectives/index.js";
import { encodeCollectiveContent } from "../../transport/collectives/part/index.js";
import { AgentAddress } from "../../transport/wire/index.js";
import { acquireHarnessEndpoint } from "../harness-endpoint/index.js";
import { makeHarnessMcpHttpHandler } from "./tools.js";

const unreachable = () =>
  Effect.dieMessage("operation is outside the delivery contract");
const pending = pendingMessage(1);

/** Only delivery operations are reachable from these MCP transcripts. */
const deliveryHandler = (
  operations: Parameters<typeof makeHarnessMcpHttpHandler>[0]["operations"],
) =>
  makeHarnessMcpHttpHandler({
    implementation: { name: "delivery-contract", version: "1" },
    operations,
  });

const callTool =
  (handler: Parameters<typeof loopbackMcpEndpoint>[0]) =>
  (name: string, args: Readonly<Record<string, unknown>> = {}) =>
    Effect.tryPromise(() =>
      handler.fetch(
        makeToolCallRequest({ id: "delivery", name, toolArguments: args }),
      ),
    ).pipe(
      Effect.flatMap((response) => Effect.tryPromise(() => response.json())),
      Effect.flatMap(
        Schema.decodeUnknown(
          Schema.Struct({
            result: Schema.Struct({ structuredContent: Schema.Unknown }),
          }),
        ),
      ),
      Effect.map((response) => response.result),
    );

/** Real delivery, collective classification and storage behind the MCP boundary. */
const fixture = Effect.gen(function* () {
  const store = yield* openEndpointStore(stateDirectory());
  const scope = yield* Scope.Scope;
  const slot: { active?: CollectiveOperations } = {};
  const delivery = yield* makeHostDelivery({
    store,
    scope,
    historyExport: { record: () => Effect.void },
    collectives: () => slot.active,
  });
  const collectives = makeCollectiveOperations({
    self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
    lookupMember: () => Effect.void,
    sendPost: unreachable,
    emit: (item) =>
      delivery
        .queueLocalItem(item)
        .pipe(
          Effect.catchTag("EndpointStoreError", () =>
            Effect.fail(new CollectiveEmitError()),
          ),
        ),
    scope,
  });
  slot.active = collectives;
  const handler = yield* deliveryHandler({
    ...delivery.operations,
    protocolActive: () => true,
    readStatus: unreachable,
    register: unreachable,
    searchAgents: unreachable,
    searchConversations: unreachable,
    readConversation: unreachable,
  });
  const url = yield* loopbackMcpEndpoint(handler);
  const call = callTool(handler);
  const inbox = call("read_inbox").pipe(
    Effect.flatMap((result) =>
      decodeHarnessReadInboxResult(result.structuredContent),
    ),
  );
  const deliver = (message = pending) =>
    delivery.runPass(() => ({
      readPending: Effect.succeed([message]),
      engine: { acknowledgeMessage: () => Effect.void },
      classify: collectives.classify,
    }));
  return { url, call, inbox, deliver };
});

const consumesAnswers = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    const content = yield* encodeCollectiveContent({
      kind: "response",
      id: Schema.decodeUnknownSync(CollectiveId)(digest("col_", 2)),
      action: "decline",
    });
    yield* test.deliver({
      ...pending,
      message: { ...pending.message, content },
    });
    expect((yield* test.inbox).items).toEqual([]);
    yield* test.deliver();
    expect((yield* test.inbox).items).toEqual([
      {
        deliveryToken: pending.deliveryToken,
        item: { kind: "multicast", message: pending.message },
      },
    ]);
  });

const replaysUntilAcknowledged = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    yield* test.deliver();
    const page = yield* test.inbox;
    expect(page.items).toEqual([
      {
        deliveryToken: pending.deliveryToken,
        item: { kind: "multicast", message: pending.message },
      },
    ]);
    expect(yield* test.inbox).toEqual(page);
    yield* test.call("acknowledge_delivery", {
      deliveryToken: pending.deliveryToken,
    });
    expect((yield* test.inbox).items).toEqual([]);
  });

const readsFailure = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    const endpoint = yield* acquireHarnessEndpoint(test.url);
    yield* endpoint.send(
      {
        to: Schema.decodeUnknownSync(AgentAddress)("agent:bob"),
        collectiveResponse: { action: "decline" },
      },
      { failureDelivery: "inbound" },
    );
    const page = yield* test.inbox;
    expect(page.items.map((entry) => entry.item)).toEqual([
      expect.objectContaining({ kind: "operationFailed", to: "agent:bob" }),
    ]);
    expect(yield* test.inbox).toEqual(page);
  });

const retainsFailedHandoff = () =>
  Effect.gen(function* () {
    const test = yield* fixture;
    yield* test.deliver();
    const endpoint = yield* acquireHarnessEndpoint(test.url);
    const failure = new Error("host refused handoff");
    const outcome = yield* endpoint.messages.pipe(
      Stream.mapEffect(() => Effect.fail(failure)),
      Stream.runDrain,
      Effect.flip,
    );
    expect(outcome).toBe(failure);
    const replay = yield* endpoint.messages.pipe(Stream.runHead);
    expect(Option.map(replay, (entry) => entry.item)).toEqual(
      Option.some({ kind: "multicast", message: pending.message }),
    );
    expect((yield* test.inbox).items).toEqual([
      {
        deliveryToken: pending.deliveryToken,
        item: { kind: "multicast", message: pending.message },
      },
    ]);
  });

// @agent-code-guard/regression-only: MCP conformance requires explicit delivery and failure transcripts.
describe("MCP delivery contract", () => {
  it(
    "consumes protocol answers without exposing them in the inbox",
    consumesAnswers,
  );
  it(
    "replays the same item until its token is acknowledged",
    replaysUntilAcknowledged,
  );
  it(
    "makes an inbound operation failure readable without acknowledging it",
    readsFailure,
  );
  it(
    "retains an item when the native host handoff fails",
    retainsFailedHandoff,
  );
});
