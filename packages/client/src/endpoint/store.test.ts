/** @file Crash, atomicity, idempotency, recovery, and management tests for the endpoint store. */

import { Effect } from "effect";
import { spawnSync } from "node:child_process";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests inspect and clean exact temporary permission fixtures around the scoped Effect resource.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CertifiedRecord,
  type CompletedReanchor,
  type ConversationFoundation,
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  openEndpointStore,
  type StagedRecord,
} from "./store.js";

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Exact modes, closed reasons, and mutation outcomes are the regression contract under test. */

const temporaryDirectories: string[] = [];
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const stateDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "moltzap-store-"));
  temporaryDirectories.push(directory);
  return directory;
};

const foundation = (conversationId: string): ConversationFoundation => ({
  conversationId,
  membershipHash: `mbr_${conversationId}`,
  canonicalMembership: bytes(`membership:${conversationId}`),
  anchorHash: `anc_${conversationId}:0`,
  canonicalAnchor: bytes(`anchor:${conversationId}:0`),
});

const record = (
  conversationId: string,
  index: number,
  anchorHash?: string,
): CertifiedRecord => ({
  conversationId,
  recordHash: `rch_${conversationId}:${index}`,
  ...(index === 0
    ? {}
    : { previousRecordHash: `rch_${conversationId}:${index - 1}` }),
  membershipHash: foundation(conversationId).membershipHash,
  anchorHash: anchorHash ?? foundation(conversationId).anchorHash,
  canonicalRecord: bytes(`record:${conversationId}:${index}`),
  canonicalCertifiedRecord: bytes(`certified:${conversationId}:${index}`),
});

const reanchor = (
  conversationId: string,
  index: number,
  previousAnchorHash: string,
): CompletedReanchor => ({
  conversationId,
  anchorHash: `anc_${conversationId}:${index}`,
  previousAnchorHash,
  routerInstanceId: `router:${index}`,
  selectedRecordHash: `rch_${conversationId}:${index - 1}`,
  canonicalBody: bytes(`reanchor-body:${conversationId}:${index}`),
  canonicalCompletedReanchor: bytes(
    `completed-reanchor:${conversationId}:${index}`,
  ),
});

const withStore = <Value>(
  directory: string,
  use: (store: EndpointStore) => Effect.Effect<Value, EndpointStoreError>,
): Effect.Effect<Value, EndpointStoreError> =>
  Effect.scoped(openEndpointStore(directory).pipe(Effect.flatMap(use)));

const initializeConversation = (store: EndpointStore, conversationId: string) =>
  Effect.gen(function* () {
    yield* store.bindStartIntent({
      conversationId,
      canonicalIntent: bytes(`intent:${conversationId}`),
    });
    yield* store.putConversationFoundation(foundation(conversationId));
  });

const certify = (store: EndpointStore, certifiedRecord: CertifiedRecord) =>
  store.stageRecord(certifiedRecord).pipe(
    Effect.zipRight(
      store.mergeEvidence({
        conversationId: certifiedRecord.conversationId,
        kind: "durability",
        subjectId: certifiedRecord.recordHash,
        evidenceKey: "agent:a",
        canonicalEvidence: bytes(`vote:${certifiedRecord.recordHash}:a`),
      }),
    ),
    Effect.zipRight(store.promoteRecord(certifiedRecord)),
  );

const expectReason = <Value>(
  effect: Effect.Effect<Value, EndpointStoreError>,
  reason: EndpointStoreError["reason"],
): Effect.Effect<void> =>
  Effect.flip(effect).pipe(
    Effect.orDie,
    Effect.tap((failure) => {
      expect(failure).toBeInstanceOf(EndpointStoreError);
      expect(failure.reason).toBe(reason);
      expect(Object.hasOwn(failure, "cause")).toBe(false);
      return Effect.void;
    }),
    Effect.asVoid,
  );

const ownsDatabasePrivately = () => {
  const directory = stateDirectory();
  const program = Effect.scoped(
    Effect.gen(function* () {
      yield* openEndpointStore(directory);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, "moltzapd.sqlite3")).mode & 0o777).toBe(
        0o600,
      );
      const occupied = yield* Effect.flip(openEndpointStore(directory));
      expect(occupied.reason).toBe("persistence");
    }),
  ).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        const database = new DatabaseSync(join(directory, "moltzapd.sqlite3"));
        expect(database.prepare("PRAGMA journal_mode").get()).toEqual({
          journal_mode: "wal",
        });
        expect(database.prepare("PRAGMA user_version").get()).toEqual({
          user_version: 1,
        });
        database.close();
      }),
    ),
  );
  return Effect.runPromise(program);
};

const closesScopedHandle = () => {
  const directory = stateDirectory();
  return Effect.runPromise(
    Effect.gen(function* () {
      let retained: EndpointStore | undefined;
      yield* withStore(directory, (store) => {
        retained = store;
        return Effect.void;
      });
      if (retained === undefined) {
        return yield* Effect.die("store acquisition did not run");
      }
      yield* expectReason(retained.recover(), "closed");
    }),
  );
};

const bindsOneIdentity = () => {
  const directory = stateDirectory();
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        const identity = {
          agentId: "agent:local",
          canonicalAgentCard: bytes("card:local"),
        };
        expect(yield* store.bindIdentity(identity)).toBe("inserted");
        expect(yield* store.bindIdentity(identity)).toBe("existing");
        yield* expectReason(
          store.bindIdentity({ ...identity, agentId: "agent:other" }),
          "conflict",
        );
      }),
    ),
  );
};

const bindsOneStartIntent = () => {
  const directory = stateDirectory();
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        const intent = {
          conversationId: "conversation:intent",
          canonicalIntent: bytes("intent:original"),
        };
        expect(yield* store.bindStartIntent(intent)).toBe("inserted");
        expect(yield* store.bindStartIntent(intent)).toBe("existing");
        yield* expectReason(
          store.bindStartIntent({
            ...intent,
            canonicalIntent: bytes("intent:changed"),
          }),
          "conflict",
        );
      }),
    ),
  );
};

const requiresStagingBeforeVote = () => {
  const directory = stateDirectory();
  const conversationId = "conversation:vote";
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* initializeConversation(store, conversationId);
        const genesis = record(conversationId, 0);
        const evidence = {
          conversationId,
          kind: "durability" as const,
          subjectId: genesis.recordHash,
          evidenceKey: "agent:a",
          canonicalEvidence: bytes("vote:a"),
        };
        yield* expectReason(store.mergeEvidence(evidence), "not-found");
        expect(yield* store.stageRecord(genesis)).toBe("inserted");
        expect(yield* store.stageRecord(genesis)).toBe("existing");
        expect(yield* store.mergeEvidence(evidence)).toBe("inserted");
        expect(yield* store.mergeEvidence(evidence)).toBe("existing");
        yield* expectReason(
          store.mergeEvidence({
            ...evidence,
            canonicalEvidence: bytes("vote:conflict"),
          }),
          "conflict",
        );
      }),
    ),
  );
};

const refusesConflictingChild = () => {
  const directory = stateDirectory();
  const conversationId = "conversation:child";
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* initializeConversation(store, conversationId);
        const genesis = record(conversationId, 0);
        expect(yield* store.applyCatchUpRecord(genesis)).toBe("inserted");
        expect(yield* store.applyCatchUpRecord(genesis)).toBe("existing");
        const firstChild = record(conversationId, 1);
        yield* store.stageRecord(firstChild);
        const conflictingChild: StagedRecord = {
          ...firstChild,
          recordHash: "rch_conflicting",
          canonicalRecord: bytes("record:conflicting"),
        };
        yield* expectReason(store.stageRecord(conflictingChild), "conflict");
      }),
    ),
  );
};

const assertRecoveredState =
  (conversationId: string) => (recovery: EndpointRecovery) => {
    expect(recovery.identity?.agentId).toBe("agent:local");
    expect(recovery.startIntents[0]?.completedRecordHash).toBe(
      record(conversationId, 0).recordHash,
    );
    expect(recovery.memberships).toHaveLength(1);
    expect(recovery.anchors).toHaveLength(1);
    expect(recovery.certifiedRecords).toHaveLength(1);
    expect(recovery.stagedRecords).toHaveLength(2);
    expect(recovery.evidence).toHaveLength(2);
    expect(recovery.consumedAttention).toEqual([
      { conversationId, recordHash: record(conversationId, 0).recordHash },
    ]);
    return Effect.void;
  };

const recoversProtocolState = () => {
  const directory = stateDirectory();
  const conversationId = "conversation:recovery";
  const write = withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* store.bindIdentity({
        agentId: "agent:local",
        canonicalAgentCard: bytes("card:local"),
      });
      yield* initializeConversation(store, conversationId);
      yield* certify(store, record(conversationId, 0));
      yield* store.consumeAttention({
        conversationId,
        recordHash: record(conversationId, 0).recordHash,
      });
      yield* store.stageRecord(record(conversationId, 1));
      yield* store.mergeEvidence({
        conversationId,
        kind: "durability",
        subjectId: record(conversationId, 1).recordHash,
        evidenceKey: "agent:b",
        canonicalEvidence: bytes("vote:b"),
      });
    }),
  );
  return Effect.runPromise(
    write.pipe(
      Effect.zipRight(
        withStore(directory, (store) =>
          store
            .recover()
            .pipe(Effect.tap(assertRecoveredState(conversationId))),
        ),
      ),
    ),
  );
};

const completesReanchorWithoutAttention = () => {
  const directory = stateDirectory();
  const conversationId = "conversation:catch-up";
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* initializeConversation(store, conversationId);
        const genesis = record(conversationId, 0);
        yield* store.applyCatchUpRecord(genesis);
        expect(
          yield* store.hasConsumedAttention({
            conversationId,
            recordHash: genesis.recordHash,
          }),
        ).toBe(false);
        const completed = reanchor(
          conversationId,
          1,
          foundation(conversationId).anchorHash,
        );
        yield* store.stageReanchor(completed);
        yield* store.mergeEvidence({
          conversationId,
          kind: "reanchor",
          subjectId: completed.anchorHash,
          evidenceKey: "agent:a",
          canonicalEvidence: bytes("reanchor-vote:a"),
        });
        expect(yield* store.completeReanchor(completed)).toBe("inserted");
        expect(yield* store.completeReanchor(completed)).toBe("existing");
        const recovery = yield* store.recover();
        expect(recovery.positions[0]?.currentAnchorHash).toBe(
          completed.anchorHash,
        );
        expect(recovery.stagedReanchors[0]?.canonicalCompletedReanchor).toEqual(
          completed.canonicalCompletedReanchor,
        );
      }),
    ),
  );
};

const assertRecoveredReanchor = (
  store: EndpointStore,
  completed: CompletedReanchor,
  conversationId: string,
) =>
  Effect.gen(function* () {
    const recovery = yield* store.recover();
    expect(recovery.positions[0]?.currentAnchorHash).toBe(completed.anchorHash);
    expect(recovery.stagedReanchors).toEqual([
      expect.objectContaining({
        anchorHash: completed.anchorHash,
        canonicalCompletedReanchor: completed.canonicalCompletedReanchor,
      }),
    ]);
    expect(
      recovery.evidence.filter(({ kind }) => kind === "reanchor"),
    ).toHaveLength(1);
    expect(yield* store.completeReanchor(completed)).toBe("existing");
    expect(
      yield* store.hasConsumedAttention({
        conversationId,
        recordHash: record(conversationId, 0).recordHash,
      }),
    ).toBe(false);
  });

const recoversCompletedReanchorAfterRestart = () => {
  const directory = stateDirectory();
  const conversationId = "conversation:reanchor-restart";
  const completed = reanchor(
    conversationId,
    1,
    foundation(conversationId).anchorHash,
  );
  const write = withStore(directory, (store) =>
    Effect.gen(function* () {
      yield* initializeConversation(store, conversationId);
      yield* store.applyCatchUpRecord(record(conversationId, 0));
      yield* store.stageReanchor(completed);
      yield* store.mergeEvidence({
        conversationId,
        kind: "reanchor",
        subjectId: completed.anchorHash,
        evidenceKey: "agent:a",
        canonicalEvidence: bytes("reanchor-vote:a"),
      });
      expect(yield* store.completeReanchor(completed)).toBe("inserted");
    }),
  );
  return Effect.runPromise(
    write.pipe(
      Effect.zipRight(
        withStore(directory, (store) =>
          assertRecoveredReanchor(store, completed, conversationId),
        ),
      ),
    ),
  );
};

const crashIdentityTransaction = (databasePath: string): void => {
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.argv[1]);
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    database.prepare("INSERT INTO identity_binding (singleton, agent_id, canonical_agent_card) VALUES (1, ?, ?)").run("agent:crashed", new Uint8Array([1]));
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    script,
    databasePath,
  ]);
  expect(child.status).toBe(0);
};

const rollsBackCrashedTransaction = () => {
  const directory = stateDirectory();
  const databasePath = join(directory, "moltzapd.sqlite3");
  return Effect.runPromise(
    withStore(directory, () => Effect.void).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          crashIdentityTransaction(databasePath);
        }),
      ),
      Effect.zipRight(
        withStore(directory, (store) =>
          store.readIdentity().pipe(
            Effect.tap((identity) => {
              expect(identity).toBeUndefined();
              return Effect.void;
            }),
          ),
        ),
      ),
    ),
  );
};

const poisonCompletedIntent = (
  directory: string,
  conversationId: string,
): void => {
  const database = new DatabaseSync(join(directory, "moltzapd.sqlite3"));
  database.exec("PRAGMA foreign_keys=ON");
  database
    .prepare(
      `INSERT INTO start_intents
        (conversation_id, canonical_intent, completed_record_hash)
       VALUES (?, ?, ?)`,
    )
    .run(conversationId, bytes("intent:atomic"), "rch_other");
  database.close();
};

const rollsBackFailedPromotion = () => {
  const directory = stateDirectory();
  const conversationId = "conversation:atomic";
  const initialize = withStore(directory, () => Effect.void).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        poisonCompletedIntent(directory, conversationId);
      }),
    ),
  );
  return Effect.runPromise(
    initialize.pipe(
      Effect.zipRight(
        withStore(directory, (store) =>
          Effect.gen(function* () {
            yield* store.putConversationFoundation(foundation(conversationId));
            yield* expectReason(
              store.applyCatchUpRecord(record(conversationId, 0)),
              "conflict",
            );
            const recovery = yield* store.recover();
            expect(recovery.stagedRecords).toHaveLength(0);
            expect(recovery.certifiedRecords).toHaveLength(0);
            expect(recovery.positions[0]?.headRecordHash).toBeUndefined();
          }),
        ),
      ),
    ),
  );
};

const exerciseFrozenHistory = (
  store: EndpointStore,
  conversationId: string,
  retain: (continuation: string) => void,
) =>
  Effect.gen(function* () {
    yield* initializeConversation(store, conversationId);
    for (let index = 0; index < 51; index += 1) {
      yield* store.applyCatchUpRecord(record(conversationId, index));
    }
    const search = yield* store.searchConversations();
    expect(search).toEqual({
      conversationIds: [conversationId],
      hasMore: false,
    });
    const first = yield* store.readConversation({ conversationId });
    expect(first.records).toHaveLength(50);
    if (first.continuation === null) {
      return yield* Effect.die("expected a second frozen page");
    }
    retain(first.continuation);
    yield* store.applyCatchUpRecord(record(conversationId, 51));
    const second = yield* store.readConversation({
      continuation: first.continuation,
    });
    expect(second.records.map(({ recordHash }) => recordHash)).toEqual([
      record(conversationId, 50).recordHash,
    ]);
    expect(second.continuation).toBeNull();
    yield* expectReason(
      store.readConversation({ continuation: first.continuation }),
      "invalid-continuation",
    );
    const current = yield* store.readConversation({
      conversationId,
      afterRecordHash: record(conversationId, 50).recordHash,
    });
    expect(current.records.map(({ recordHash }) => recordHash)).toEqual([
      record(conversationId, 51).recordHash,
    ]);
  });

const pagesFrozenHistory = () => {
  const directory = stateDirectory();
  const conversationId = "conversation:pages";
  let continuation: string | undefined;
  const firstProcess = withStore(directory, (store) =>
    exerciseFrozenHistory(store, conversationId, (retained) => {
      continuation = retained;
    }),
  );
  return Effect.runPromise(
    firstProcess.pipe(
      Effect.zipRight(
        Effect.suspend(() => {
          if (continuation === undefined) {
            return Effect.die(
              "continuation was not retained for restart check",
            );
          }
          const expiredContinuation = continuation;
          return withStore(directory, (store) =>
            expectReason(
              store.readConversation({ continuation: expiredContinuation }),
              "invalid-continuation",
            ),
          );
        }),
      ),
    ),
  );
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("endpoint SQLite store", () => {
  it("uses private WAL state with one live owner", ownsDatabasePrivately);
  it("closes its scoped handle", closesScopedHandle);
  it("binds one identity idempotently", bindsOneIdentity);
  it("binds one canonical START intent idempotently", bindsOneStartIntent);
  it("requires durable staging before vote merge", requiresStagingBeforeVote);
  it("refuses a conflicting child of one head", refusesConflictingChild);
  it("recovers every protocol state class", recoversProtocolState);
  it(
    "completes re-anchor without attention",
    completesReanchorWithoutAttention,
  );
  it(
    "recovers a completed re-anchor idempotently after restart",
    recoversCompletedReanchorAfterRestart,
  );
  it(
    "rolls back an abruptly terminated transaction",
    rollsBackCrashedTransaction,
  );
  it(
    "rolls back a failed promotion and head advance",
    rollsBackFailedPromotion,
  );
  it("freezes pages and expires continuations on restart", pagesFrozenHistory);
});

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Restore the guard outside this regression suite. */
