/** @file Host operations over one service's delivery: registration gating, the send export, and local-item reads and acknowledgment. */

import { Effect, Encoding, Exit, Schema, Scope } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- The store opens a real SQLite database in a temporary directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CollectiveOperations } from "../transport/collectives/index.js";
import type { HistoryExportRecord } from "./history-export.js";
import {
  DeliveryToken,
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
} from "../store/index.js";
import {
  CollectiveEmitError,
  CollectiveId,
  SendInput,
} from "../transport/collectives/forms.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import { SendError } from "../transport/messaging/errors.js";
import { InboundMessage } from "../transport/messaging/message.js";
import { PostId, RecordHash } from "../transport/wire/index.js";
import { makeHostDelivery } from "./host-delivery.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Closed error reasons and export record kinds are the contract under test. */

type Collectives = Pick<CollectiveOperations, "send">;

const directories: string[] = [];

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

const identifier = (prefix: string, fill: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(fill))}`;

const input = Schema.decodeUnknownSync(SendInput)({
  to: "agent:bob",
  text: "one operation",
});
const operationId = Schema.decodeUnknownSync(CollectiveId)(
  identifier("col_", 3),
);
const postId = Schema.decodeUnknownSync(PostId)(identifier("pst_", 4));
const failure = Schema.decodeUnknownSync(InboundItem)({
  kind: "operationFailed",
  id: identifier("col_", 1),
  to: "agent:bob",
  error: "request unavailable",
});
const unboundToken = Schema.decodeUnknownSync(DeliveryToken)(
  identifier("dlv_", 9),
);

/**
 * Build one delivery over a fresh store, optionally adjusted, whose active
 * collective layer the test sets and replaces through the returned slot.
 */
const makeFixture = (adjust: (store: EndpointStore) => EndpointStore) =>
  Effect.gen(function* () {
    const path = mkdtempSync(join(tmpdir(), "moltzap-host-delivery-"));
    directories.push(path);
    const store = adjust(yield* openEndpointStore(path));
    const records: HistoryExportRecord[] = [];
    const slot: { collectives?: Collectives } = {};
    const delivery = yield* makeHostDelivery({
      store,
      historyExport: {
        record: (record) =>
          Effect.sync(() => {
            records.push(record);
          }),
      },
      collectives: () => slot.collectives,
      scope: yield* Scope.Scope,
    });
    return { delivery, records, slot };
  });

const deliveryFixture = makeFixture((store) => store);

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect));

/**
 * An unregistered service refuses every host operation with its closed
 * reason and records nothing; the active layer is read on each call, so a
 * layer installed after construction serves the next send.
 */
const refusesUntilRegistered = () =>
  run(
    Effect.gen(function* () {
      const { delivery, records, slot } = yield* deliveryFixture;
      const { operations } = delivery;
      expect(yield* Effect.flip(operations.send({ input }))).toEqual(
        new SendError({ reason: "not-registered" }),
      );
      expect(yield* Effect.flip(operations.readInbox({}))).toEqual({
        reason: "not-registered",
      });
      expect(
        yield* Effect.flip(operations.readEvent({ eventId: "evt_absent" })),
      ).toEqual({ reason: "not-registered" });
      expect(
        (yield* Effect.flip(operations.acknowledgeDelivery(unboundToken)))
          .reason,
      ).toBe("unknown-delivery");
      expect(records).toEqual([]);
      slot.collectives = {
        send: () => Effect.succeed({ operationId, postIds: [postId] }),
      };
      expect(yield* operations.send({ input })).toEqual({ operationId });
    }),
  );

/**
 * The host's failure routing reaches the collective layer, which defaults it
 * to returning the error as the send's result.
 */
const forwardsFailureRouting = () =>
  run(
    Effect.gen(function* () {
      const { delivery, slot } = yield* deliveryFixture;
      const routed: string[] = [];
      slot.collectives = {
        send: (...[, failureDelivery]) =>
          Effect.sync(() => {
            routed.push(failureDelivery);
            return { postIds: [postId] };
          }),
      };
      yield* delivery.operations.send({ input, failureDelivery: "inbound" });
      yield* delivery.operations.send({ input });
      expect(routed).toEqual(["inbound", "result"]);
    }),
  );

/**
 * Each completed send lands in the history export with how it ended: the
 * certified posts and operation id, or the returned error's message. A
 * multicast returns an empty result.
 */
const exportsEachSend = () =>
  run(
    Effect.gen(function* () {
      const { delivery, records, slot } = yield* deliveryFixture;
      const { operations } = delivery;
      const outcomes: Array<
        Effect.Effect<
          Effect.Effect.Success<ReturnType<Collectives["send"]>>,
          SendError
        >
      > = [
        Effect.succeed({ operationId, postIds: [postId] }),
        Effect.succeed({ postIds: [postId] }),
        Effect.fail(new SendError({ reason: "content-invalid" })),
      ];
      slot.collectives = {
        send: () => outcomes.shift() ?? Effect.dieMessage("unexpected send"),
      };
      expect(yield* operations.send({ input })).toEqual({ operationId });
      expect(yield* operations.send({ input })).toEqual({});
      const refused = yield* Effect.exit(operations.send({ input }));
      expect(refused).toEqual(
        Exit.fail(new SendError({ reason: "content-invalid" })),
      );
      expect(
        records.map((record) =>
          record.kind === "outbound"
            ? { input: record.input, outcome: record.outcome }
            : record,
        ),
      ).toEqual([
        { input, outcome: { kind: "sent", operationId, postIds: [postId] } },
        { input, outcome: { kind: "sent", postIds: [postId] } },
        {
          input,
          outcome: {
            kind: "failed",
            error: new SendError({ reason: "content-invalid" }).message,
          },
        },
      ]);
    }),
  );

/**
 * A queued local item is durable and readable, exported on its first read
 * only, and gone from the inbox once acknowledged.
 */
const exportsLocalItemOnceAndForgetsIt = () =>
  run(
    Effect.gen(function* () {
      const { delivery, records, slot } = yield* deliveryFixture;
      const { operations } = delivery;
      slot.collectives = { send: () => Effect.dieMessage("unexpected send") };
      yield* delivery.queueLocalItem(failure);
      const [queued] = (yield* operations.readInbox({})).items;
      if (queued === undefined) {
        throw new Error("queued item is not in the inbox");
      }
      const { deliveryToken } = queued;
      const expected = { items: [{ deliveryToken, item: failure }] };
      expect(yield* operations.readInbox({})).toEqual(expected);
      expect(yield* operations.readInbox({})).toEqual(expected);
      expect(
        records.map((record) =>
          record.kind === "inbound"
            ? { kind: record.kind, item: record.item }
            : record,
        ),
      ).toEqual([{ kind: "inbound", item: failure }]);
      yield* operations.acknowledgeDelivery(deliveryToken);
      expect(yield* operations.readInbox({})).toEqual({ items: [] });
      expect(
        (yield* Effect.flip(operations.acknowledgeDelivery(unboundToken)))
          .reason,
      ).toBe("unknown-delivery");
    }),
  );

/**
 * A store failure while retiring a delivery reports persistence-failed, not
 * unknown-delivery, so the host keeps the item and retries rather than
 * treating it as already gone; the caches keep it too.
 */
const reportsAcknowledgmentPersistenceFailure = () =>
  run(
    Effect.gen(function* () {
      const { delivery, slot } = yield* makeFixture((store) => ({
        ...store,
        acknowledgeInboxItem: () =>
          Effect.fail(new EndpointStoreError({ reason: "corrupt" })),
      }));
      slot.collectives = { send: () => Effect.dieMessage("unexpected send") };
      yield* delivery.queueLocalItem(failure);
      const [queued] = (yield* delivery.operations.readInbox({})).items;
      if (queued === undefined) {
        throw new Error("queued item is not in the inbox");
      }
      const { deliveryToken } = queued;
      expect(
        (yield* Effect.flip(
          delivery.operations.acknowledgeDelivery(deliveryToken),
        )).reason,
      ).toBe("persistence-failed");
      expect((yield* delivery.operations.readInbox({})).items).toEqual([
        { deliveryToken, item: failure },
      ]);
    }),
  );

/**
 * A pass whose classification fails because an emitted item could not be
 * kept ends with that failure and releases the delivery gate, so a host read
 * that waits on the gate still completes.
 */
const releasesTheGateWhenAPassFails = () =>
  run(
    Effect.gen(function* () {
      const { delivery, slot } = yield* deliveryFixture;
      slot.collectives = { send: () => Effect.dieMessage("unexpected send") };
      const pending = {
        deliveryToken: unboundToken,
        recordHash: Schema.decodeUnknownSync(RecordHash)(identifier("rch_", 5)),
        message: Schema.decodeUnknownSync(InboundMessage)({
          kind: "direct",
          postId: identifier("pst_", 5),
          address: "agent:bob",
          sender: "agent:bob",
          content: [{ type: "text", text: "pending" }],
        }),
      };
      const failure = yield* Effect.flip(
        delivery.runPass(() => ({
          readPending: Effect.succeed([pending]),
          engine: { acknowledgeMessage: () => Effect.void },
          classify: () => Effect.fail(new CollectiveEmitError()),
        })),
      );
      const page = yield* delivery.operations
        .readInbox({})
        .pipe(Effect.timeout("1 second"));

      expect(failure).toEqual(new CollectiveEmitError());
      expect(page.items).toEqual([]);
    }),
  );

describe("host delivery", () => {
  it(
    "refuses host operations until a collective layer is active",
    refusesUntilRegistered,
  );
  it("records each completed send in the history export", exportsEachSend);
  it(
    "forwards the host's failure routing to the collective layer",
    forwardsFailureRouting,
  );
  it(
    "exports a queued local item once and forgets it on acknowledgment",
    exportsLocalItemOnceAndForgetsIt,
  );
  it(
    "reports a store failure while acknowledging as persistence-failed",
    reportsAcknowledgmentPersistenceFailure,
  );
  it(
    "releases the delivery gate when a pass fails",
    releasesTheGateWhenAPassFails,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults after the host delivery tests. */
