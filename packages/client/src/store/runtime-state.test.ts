/** @file Pins the runtime state the endpoint store keeps across restart and across the schema version 2 to 3 upgrade. */

import { Effect, Encoding, Schema } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- These persistence tests reopen real SQLite databases across independent Effect scopes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { downgradeToSchemaV2 } from "../__tests__/store-schema-fixtures.js";
import { DeliveryToken, openEndpointStore } from "./index.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Store mutation outcomes and the schema version are the contract under test. */

const directories: string[] = [];
const directory = (): string => {
  const path = mkdtempSync(join(tmpdir(), "moltzap-runtime-state-"));
  directories.push(path);
  return path;
};
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const token = Schema.decodeUnknownSync(DeliveryToken)(
  `dlv_${Encoding.encodeBase64Url(new Uint8Array(32).fill(1))}`,
);

afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function retainsInvocationAndEventState() {
  const path = directory();
  const input = bytes('{"input":{"text":"hello","to":"agent:bob"}}');
  const outcome = bytes('{"kind":"success","result":{}}');
  const eventState = bytes('{"subscription":"private"}');
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
          expect(yield* store.beginSendAttempt("finished", input)).toBe(
            "inserted",
          );
          yield* store.finishSendAttempt("finished", outcome);
          yield* store.beginSendAttempt("interrupted", input);
          yield* store.writeEventState(eventState);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
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
  const path = directory();
  const identity = {
    agentId: "agent:alice",
    canonicalAgentCard: new Uint8Array([1, 2, 3]),
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.scoped(
        openEndpointStore(path).pipe(
          Effect.flatMap((store) => store.bindIdentity(identity)),
        ),
      );
      yield* downgradeToSchemaV2(path);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* openEndpointStore(path);
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
        const database = new DatabaseSync(join(path, "moltzapd.sqlite3"), {
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
