/** @file Pins the runtime state the endpoint store keeps across restart and across the schema version 2 to 3 upgrade. */

import { Effect, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { digest } from "../__tests__/agent-card-fixtures.js";
import {
  bytes,
  databasePath,
  downgradeToSchemaV2,
  stateDirectory,
  withStore,
} from "../__tests__/store-schema-fixtures.js";
import { DeliveryToken } from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Store mutation outcomes and the schema version are the contract under test. */

const token = Schema.decodeUnknownSync(DeliveryToken)(digest("dlv_", 1));

function retainsInvocationAndEventState() {
  const path = stateDirectory();
  const input = bytes('{"input":{"text":"hello","to":"agent:bob"}}');
  const outcome = bytes('{"kind":"success","result":{}}');
  const eventState = bytes('{"subscription":"private"}');
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* withStore(path, (store) =>
        Effect.gen(function* () {
          expect(yield* store.beginSendAttempt("finished", input)).toBe(
            "inserted",
          );
          yield* store.finishSendAttempt("finished", outcome);
          yield* store.beginSendAttempt("interrupted", input);
          yield* store.writeEventState(eventState);
        }),
      );
      yield* withStore(path, (store) =>
        Effect.gen(function* () {
          expect(yield* store.beginSendAttempt("finished", input)).toBe(
            "existing",
          );
          expect(yield* store.readSendAttempt("finished")).toEqual({
            canonicalInput: input,
            canonicalOutcome: outcome,
          });
          expect(yield* store.readSendAttempt("interrupted")).toEqual({
            canonicalInput: input,
          });
          expect(yield* store.readEventState()).toEqual(eventState);
          const conflict = yield* store
            .beginSendAttempt("finished", outcome)
            .pipe(Effect.flip);
          expect(conflict.reason).toBe("conflict");
        }),
      );
    }),
  );
}

function upgradesSchemaVersion2WithoutReplacingTheIdentity() {
  const path = stateDirectory();
  const identity = {
    agentId: "agent:alice",
    canonicalAgentCard: new Uint8Array([1, 2, 3]),
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* withStore(path, (store) => store.bindIdentity(identity));
      yield* downgradeToSchemaV2(path);
      yield* withStore(path, (store) =>
        Effect.gen(function* () {
          expect(yield* store.readIdentity()).toEqual(identity);
          expect(yield* store.readInboxSummary()).toEqual({
            pendingCount: 0,
            newestSequence: 0,
          });
          expect(
            yield* store.putInboxItem({
              deliveryToken: token,
              canonicalItem: bytes('{"kind":"operationFailed"}'),
            }),
          ).toBe("inserted");
        }),
      );
      yield* Effect.sync(() => {
        const database = new DatabaseSync(databasePath(path), {
          readOnly: true,
        });
        expect(database.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: 3,
        });
        database.close();
      });
    }),
  );
}

describe("endpoint runtime state", () => {
  it(
    "retains completed and interrupted invocations and event state across restart",
    retainsInvocationAndEventState,
  );
  it(
    "upgrades schema version 2 without replacing the configured identity",
    upgradesSchemaVersion2WithoutReplacingTheIdentity,
  );
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore repository defaults. */
