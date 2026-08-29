/** @file Exact preflight, proposal-lock, certification, and delivery tests. */

import { Effect, FastCheck as fc } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Tests create and inspect exact real-SQLite permission fixtures around the scoped Effect resource.
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CertifiedRecord,
  type ConversationFoundation,
  type DisseminationObligation,
  type EmptyConversationRestart,
  type EndpointRecovery,
  type EndpointStore,
  EndpointStoreError,
  type InboundDeliveryInput,
  openEndpointStore,
  type OutboundMessageInput,
  type PostIntent,
  type ProposalLock,
  type ProtocolEvidence,
  type RestartedEmptyConversation,
  type StagedRecord,
  type StoredOutboundMessage,
  type StoreMutation,
} from "./store.js";

const DATABASE_FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const EXISTING_MUTATION: StoreMutation = "existing";
const INSERTED_MUTATION: StoreMutation = "inserted";
const LEGACY_DATABASE_FILE_MODE = 0o644;
const LEGACY_DIRECTORY_MODE = 0o755;
const LOCAL_AGENT_ID = "agent:local";
const PROPERTY_RUNS = 8;
const EMPTY_SCHEMA_ROW = Object.freeze({ user_version: 0 });
const LEGACY_SCHEMA_ROW = Object.freeze({ user_version: 1 });
const V2_SCHEMA_ROW = Object.freeze({ user_version: 2 });
const DELETE_JOURNAL_ROW = Object.freeze({ journal_mode: "delete" });
const LEGACY_TABLE_ROW = Object.freeze({ name: "legacy_state" });
const POST_INTENTS_TABLE_ROW = Object.freeze({ name: "post_intents" });
const UNEXPECTED_TABLE_ROW = Object.freeze({ name: "unexpected_state" });

const temporaryDirectories: string[] = [];

function initializesEmptyV0Database() {
  const directory = stateDirectory();
  const initialize = withStore(directory, (store) =>
    store.recover().pipe(
      Effect.tap((recovery) => {
        expect(recovery.certifiedRecords).toEqual([]);
        return Effect.void;
      }),
    ),
  );
  return Effect.runPromise(
    initialize.pipe(
      Effect.zipRight(withStore(directory, (store) => store.recover())),
      Effect.tap(() =>
        Effect.sync(() => {
          assertInitializedDatabase(directory);
        }),
      ),
    ),
  );
}

function rejectsV1WithoutMutation() {
  const directory = stateDirectory();
  const path = databasePath(directory);
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE legacy_state (value TEXT) STRICT");
  database.exec("PRAGMA user_version = 1");
  database.close();
  chmodSync(directory, 0o755);
  chmodSync(path, 0o644);

  return Effect.runPromise(
    expectReason(
      Effect.scoped(openEndpointStore(directory)),
      "incompatible",
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assertLegacyDatabaseUnchanged(directory, path);
        }),
      ),
    ),
  );
}

function rejectsNonemptyV0WithoutInitialization() {
  const directory = stateDirectory();
  const path = databasePath(directory);
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE unexpected_state (value TEXT) STRICT");
  database.close();

  return Effect.runPromise(
    expectReason(
      Effect.scoped(openEndpointStore(directory)),
      "incompatible",
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          assertNonemptyDatabaseUnchanged(path);
        }),
      ),
    ),
  );
}

function retainsFirstProposalAcrossRestart() {
  const directory = stateDirectory();
  const conversationId = "conversation:lock";
  const first = proposal(conversationId, `ach_${conversationId}:0`);
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* bindLocalIdentity(store);
        yield* store.putConversationFoundation(foundation(conversationId));
        const localSignature = localActionEvidence(
          conversationId,
          first.actionHash,
        );
        yield* expectReason(store.mergeEvidence(localSignature), "not-found");
        expect(yield* store.lockProposal(first)).toBe(INSERTED_MUTATION);
        expect(yield* store.mergeEvidence(localSignature)).toBe(
          INSERTED_MUTATION,
        );
        expect(yield* store.lockProposal(first)).toBe(EXISTING_MUTATION);
        yield* expectReason(
          store.lockProposal(proposal(conversationId, "ach_competing")),
          "conflict",
        );
      }),
    ).pipe(
      Effect.zipRight(
        withStore(directory, (store) =>
          store.recover().pipe(
            Effect.tap((recovery) => {
              expect(recovery.proposalLocks).toEqual([first]);
              return Effect.void;
            }),
          ),
        ),
      ),
    ),
  );
}

function atomicallyBindsFirstIntentWithItsFoundation() {
  const directory = stateDirectory();
  const firstConversationId = "conversation:intent:first";
  const competingConversationId = "conversation:intent:competing";
  const firstIntent = postIntent(firstConversationId, "pst_atomic");
  const competingIntent = postIntent(competingConversationId, "pst_atomic");
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* bindLocalIdentity(store);
        expect(
          yield* store.bindPostIntent({
            kind: "new-conversation",
            foundation: foundation(firstConversationId),
            intent: firstIntent,
          }),
        ).toBe(INSERTED_MUTATION);
        expect(
          yield* store.bindPostIntent({
            kind: "new-conversation",
            foundation: foundation(firstConversationId),
            intent: firstIntent,
          }),
        ).toBe(EXISTING_MUTATION);
        yield* expectReason(
          store.bindPostIntent({
            kind: "new-conversation",
            foundation: foundation(competingConversationId),
            intent: competingIntent,
          }),
          "conflict",
        );
        const recovery = yield* store.recover();
        expect(recovery.postIntents).toEqual([firstIntent]);
        expect(recovery.memberships.map((item) => item.conversationId)).toEqual(
          [firstConversationId],
        );
      }),
    ),
  );
}

function atomicallyLocksVerifiedGenesisFoundation() {
  const directory = stateDirectory();
  const conversationId = "conversation:genesis-lock";
  const retainedFoundation = foundation(conversationId);
  const first = proposal(conversationId, "ach_genesis:first");
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        expect(
          yield* store.lockGenesisProposal(retainedFoundation, first),
        ).toBe(INSERTED_MUTATION);
        expect(
          yield* store.lockGenesisProposal(retainedFoundation, first),
        ).toBe(EXISTING_MUTATION);
        yield* expectReason(
          store.lockGenesisProposal(
            retainedFoundation,
            proposal(conversationId, "ach_genesis:competing"),
          ),
          "conflict",
        );
        const recovery = yield* store.recover();
        expect(recovery.memberships).toHaveLength(1);
        expect(recovery.anchors).toHaveLength(1);
        expect(recovery.proposalLocks).toEqual([first]);
      }),
    ),
  );
}

function retainsIdempotentProposalForSeed(seed: number) {
  const directory = stateDirectory();
  const conversationId = `conversation:property:${seed}`;
  const first = proposal(conversationId, `ach_property:${seed}`);
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* store.putConversationFoundation(foundation(conversationId));
        expect(yield* store.lockProposal(first)).toBe(INSERTED_MUTATION);
        expect(yield* store.lockProposal(first)).toBe(EXISTING_MUTATION);
      }),
    ),
  );
}

function promotesRemoteRecordWithStableDelivery() {
  const directory = stateDirectory();
  const conversationId = "conversation:remote";
  const record = certifiedRecord(conversationId, "agent:remote");
  const delivery: InboundDeliveryInput = {
    recipientAgentId: LOCAL_AGENT_ID,
    canonicalMessage: bytes("message:remote"),
  };
  return Effect.runPromise(
    withStore(directory, (store) =>
      writeRemoteDelivery(store, record, delivery),
    ).pipe(
      Effect.flatMap((retainedToken) =>
        withStore(directory, (store) =>
          verifyRemoteDeliveryRecovery(store, record, retainedToken),
        ),
      ),
    ),
  );
}

function rollsBackRemoteRecordWithoutDelivery() {
  const directory = stateDirectory();
  const conversationId = "conversation:atomic";
  const record = certifiedRecord(conversationId, "agent:remote");
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* bindLocalIdentity(store);
        yield* store.putConversationFoundation(foundation(conversationId));
        yield* expectReason(store.applyCatchUpRecord(record), "invalid-input");
        const recovery = yield* store.recover();
        expect(recovery.positions[0]?.headRecordHash).toBeUndefined();
        expect(recovery.stagedRecords).toEqual([]);
        expect(recovery.certifiedRecords).toEqual([]);
        expect(recovery.evidence).toEqual([]);
        expect(recovery.pendingDeliveries).toEqual([]);
      }),
    ),
  );
}

function completesLocalPostWithoutSelfDelivery() {
  const directory = stateDirectory();
  const conversationId = "conversation:local";
  const record = certifiedRecord(conversationId, LOCAL_AGENT_ID);
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* bindLocalIdentity(store);
        yield* store.bindPostIntent({
          kind: "new-conversation",
          foundation: foundation(conversationId),
          intent: {
            conversationId,
            membershipHash: record.membershipHash,
            authorAgentId: record.authorAgentId,
            postId: record.postId,
            canonicalIntent: bytes("intent:local"),
          },
        });
        yield* store.lockProposal(proposal(conversationId, record.actionHash));
        yield* store.applyCatchUpRecord(record);
        const recovery = yield* store.recover();
        expect(recovery.postIntents[0]?.completedRecordHash).toBe(
          record.recordHash,
        );
        expect(recovery.pendingDeliveries).toEqual([]);
      }),
    ),
  );
}

interface OutboundLifecycleFixture {
  readonly directory: string;
  readonly conversationId: string;
  readonly initial: OutboundMessageInput;
  readonly replacement: OutboundMessageInput;
}

function persistsExactOutboundLifecycleAcrossRestart() {
  const fixture: OutboundLifecycleFixture = {
    directory: stateDirectory(),
    conversationId: "conversation:outbound",
    initial: outboundMessage(
      "conversation:outbound",
      "msg_initial",
      "outer:first",
    ),
    replacement: outboundMessage(
      "conversation:outbound",
      "msg_replacement",
      "outer:replacement",
    ),
  };
  return Effect.runPromise(
    stageInitialOutbound(fixture).pipe(
      Effect.zipRight(replaceRetriedOutbound(fixture)),
      Effect.zipRight(completeReplacementOutbound(fixture)),
      Effect.zipRight(verifyOutboundComplete(fixture.directory)),
    ),
  );
}

function stageInitialOutbound(fixture: OutboundLifecycleFixture) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      yield* store.putConversationFoundation(
        foundation(fixture.conversationId),
      );
      const staged = yield* store.enqueueOutbound(fixture.initial);
      expect(staged.outboundId).toBe(fixture.initial.messageId);
      expect(yield* store.beginOutbound(staged.outboundId)).toEqual({
        kind: "pending",
        mode: "initial",
        outbound: staged,
      });
    }),
  );
}

function replaceRetriedOutbound(fixture: OutboundLifecycleFixture) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      const replay = yield* recoverOnlyOutbound(store);
      expect(replay.canonicalSignedMessage).toEqual(
        fixture.initial.canonicalSignedMessage,
      );
      expect(yield* store.beginOutbound(replay.outboundId)).toEqual({
        kind: "pending",
        mode: "retry",
        outbound: replay,
      });
      const replaced = yield* store.replaceOutbound(
        replay,
        fixture.replacement,
      );
      expect(replaced).toEqual({
        outboundId: fixture.initial.messageId,
        ...fixture.replacement,
      });
    }),
  );
}

function completeReplacementOutbound(fixture: OutboundLifecycleFixture) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      const replacementReplay = yield* recoverOnlyOutbound(store);
      expect(replacementReplay).toEqual({
        outboundId: fixture.initial.messageId,
        ...fixture.replacement,
      });
      expect(yield* store.beginOutbound(replacementReplay.outboundId)).toEqual({
        kind: "pending",
        mode: "initial",
        outbound: replacementReplay,
      });
      expect(yield* store.completeOutbound(replacementReplay)).toBe(
        INSERTED_MUTATION,
      );
      expect(yield* store.completeOutbound(replacementReplay)).toBe(
        EXISTING_MUTATION,
      );
    }),
  );
}

function verifyOutboundComplete(directory: string) {
  return withStore(directory, (store) =>
    store.recover().pipe(
      Effect.tap((recovery) => {
        expect(recovery.outboundMessages).toEqual([]);
        return Effect.void;
      }),
    ),
  );
}

function recoverOnlyOutbound(
  store: EndpointStore,
): Effect.Effect<StoredOutboundMessage, EndpointStoreError> {
  return store.recover().pipe(
    Effect.flatMap((recovery) => {
      const outbound = recovery.outboundMessages[0];
      return outbound === undefined
        ? Effect.die("pending outbound was not recovered")
        : Effect.succeed(outbound);
    }),
  );
}

interface DisseminationLifecycleFixture {
  readonly directory: string;
  readonly conversationId: string;
  readonly record: CertifiedRecord;
  readonly actionObligation: DisseminationObligation;
  readonly certifiedObligation: DisseminationObligation;
  readonly actionEnvelope: OutboundMessageInput;
}

function retainsRecordDisseminationAcrossCrashWindows() {
  const directory = stateDirectory();
  const conversationId = "conversation:dissemination";
  const record = certifiedRecord(conversationId, LOCAL_AGENT_ID);
  const fixture: DisseminationLifecycleFixture = {
    directory,
    conversationId,
    record,
    actionObligation: disseminationObligation(
      "action-certified-record",
      record,
    ),
    certifiedObligation: disseminationObligation("certified-record", record),
    actionEnvelope: outboundMessage(
      conversationId,
      "msg_action_certified",
      "outer:action-certified",
    ),
  };
  return Effect.runPromise(
    stageDisseminationObligation(fixture).pipe(
      Effect.zipRight(reconcileDisseminationCrashWindows(fixture)),
    ),
  );
}

function stageDisseminationObligation(fixture: DisseminationLifecycleFixture) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      yield* bindLocalIdentity(store);
      yield* store.bindPostIntent({
        kind: "new-conversation",
        foundation: foundation(fixture.conversationId),
        intent: {
          conversationId: fixture.conversationId,
          membershipHash: fixture.record.membershipHash,
          authorAgentId: fixture.record.authorAgentId,
          postId: fixture.record.postId,
          canonicalIntent: bytes("intent:dissemination"),
        },
      });
      yield* store.lockProposal(
        proposal(fixture.conversationId, fixture.record.actionHash),
      );
      yield* expectReason(
        store.enqueueDisseminationOutbound(
          fixture.actionObligation,
          fixture.actionEnvelope,
        ),
        "not-found",
      );
      expect((yield* store.recover()).outboundMessages).toEqual([]);
      expect(
        yield* store.stageRecordForDissemination(stagedRecord(fixture.record)),
      ).toBe(INSERTED_MUTATION);
      expect((yield* store.recover()).disseminationObligations).toEqual([
        fixture.actionObligation,
      ]);
    }),
  );
}

function reconcileDisseminationCrashWindows(
  fixture: DisseminationLifecycleFixture,
) {
  return withStore(fixture.directory, (store) =>
    Effect.gen(function* () {
      const outbound = yield* store.enqueueDisseminationOutbound(
        fixture.actionObligation,
        fixture.actionEnvelope,
      );
      const attached = yield* store.recover();
      expect(attached.disseminationObligations).toEqual([]);
      expect(attached.outboundMessages).toEqual([outbound]);
      expect(yield* store.promoteRecordForDissemination(fixture.record)).toBe(
        INSERTED_MUTATION,
      );
      expect((yield* store.recover()).disseminationObligations).toEqual([
        fixture.certifiedObligation,
      ]);
      expect(yield* store.discardOutbound([outbound])).toBe(INSERTED_MUTATION);
      expect((yield* store.recover()).disseminationObligations).toEqual([
        fixture.actionObligation,
        fixture.certifiedObligation,
      ]);
    }),
  );
}

interface EmptyRestartFixture {
  readonly directory: string;
  readonly conversationId: string;
  readonly newFoundation: ConversationFoundation;
  readonly intent: PostIntent;
  readonly staged: StagedRecord;
  readonly lock: ProposalLock;
  readonly restart: EmptyConversationRestart;
}

function restartsOnlyAnEmptyConversationAtomically() {
  const directory = stateDirectory();
  const conversationId = "conversation:empty-restart";
  const oldFoundation = foundation(conversationId);
  const newFoundation: ConversationFoundation = {
    ...oldFoundation,
    anchorHash: `anc_${conversationId}:1`,
    canonicalAnchor: bytes(`anchor:${conversationId}:1`),
  };
  const intent = postIntent(conversationId, "pst_restart");
  const staged = stagedRecord(certifiedRecord(conversationId, LOCAL_AGENT_ID));
  const fixture: EmptyRestartFixture = {
    directory,
    conversationId,
    newFoundation,
    intent,
    staged,
    lock: proposal(conversationId, staged.actionHash),
    restart: {
      expectedFoundation: oldFoundation,
      replacementFoundation: newFoundation,
    },
  };
  return Effect.runPromise(restartEmptyConversation(fixture));
}

function restartEmptyConversation(fixture: EmptyRestartFixture) {
  return withStore(fixture.directory, (store) =>
    prepareEmptyRestartState(store, fixture).pipe(
      Effect.zipRight(store.restartEmptyConversation(fixture.restart)),
      Effect.tap((restarted) =>
        Effect.sync(() => {
          assertRestartedEmptyConversation(restarted, fixture);
        }),
      ),
      Effect.zipRight(store.recover()),
      Effect.tap((recovery) =>
        Effect.sync(() => {
          assertEmptyRestartRecovery(recovery, fixture);
        }),
      ),
    ),
  );
}

function prepareEmptyRestartState(
  store: EndpointStore,
  fixture: EmptyRestartFixture,
) {
  return Effect.gen(function* () {
    yield* bindLocalIdentity(store);
    yield* store.bindPostIntent({
      kind: "new-conversation",
      foundation: fixture.restart.expectedFoundation,
      intent: fixture.intent,
    });
    yield* store.lockProposal(fixture.lock);
    yield* store.stageRecordForDissemination(fixture.staged);
    yield* store.mergeEvidence({
      conversationId: fixture.conversationId,
      kind: "action",
      subjectId: fixture.staged.actionHash,
      evidenceKey: LOCAL_AGENT_ID,
      canonicalEvidence: bytes("action:stale"),
    });
    yield* store.mergeEvidence({
      conversationId: fixture.conversationId,
      kind: "durability",
      subjectId: fixture.staged.recordHash,
      evidenceKey: LOCAL_AGENT_ID,
      canonicalEvidence: bytes("durability:stale"),
    });
    yield* store.enqueueOutbound(
      outboundMessage(fixture.conversationId, "msg_stale", "outer:stale"),
    );
  });
}

function assertRestartedEmptyConversation(
  restarted: RestartedEmptyConversation,
  fixture: EmptyRestartFixture,
): void {
  expect(restarted).toEqual({
    foundation: fixture.newFoundation,
    postIntents: [fixture.intent],
  });
}

function assertEmptyRestartRecovery(
  recovery: EndpointRecovery,
  fixture: EmptyRestartFixture,
): void {
  expect(recovery.anchors).toEqual([
    {
      conversationId: fixture.conversationId,
      anchorHash: fixture.newFoundation.anchorHash,
      canonicalAnchor: fixture.newFoundation.canonicalAnchor,
    },
  ]);
  expect(recovery.positions).toEqual([
    {
      conversationId: fixture.conversationId,
      membershipHash: fixture.newFoundation.membershipHash,
      currentAnchorHash: fixture.newFoundation.anchorHash,
    },
  ]);
  expect(recovery.postIntents).toEqual([fixture.intent]);
  expect(recovery.proposalLocks).toEqual([]);
  expect(recovery.stagedRecords).toEqual([]);
  expect(recovery.evidence).toEqual([]);
  expect(recovery.disseminationObligations).toEqual([]);
  expect(recovery.outboundMessages).toEqual([]);
}

function refusesEmptyRestartAfterCertification() {
  const directory = stateDirectory();
  const conversationId = "conversation:certified-restart";
  const oldFoundation = foundation(conversationId);
  const record = certifiedRecord(conversationId, LOCAL_AGENT_ID);
  const replacement: ConversationFoundation = {
    ...oldFoundation,
    anchorHash: `anc_${conversationId}:1`,
    canonicalAnchor: bytes(`anchor:${conversationId}:1`),
  };
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* bindLocalIdentity(store);
        yield* store.bindPostIntent({
          kind: "new-conversation",
          foundation: oldFoundation,
          intent: {
            conversationId,
            membershipHash: record.membershipHash,
            authorAgentId: LOCAL_AGENT_ID,
            postId: record.postId,
            canonicalIntent: bytes("intent:certified-restart"),
          },
        });
        yield* store.lockProposal(proposal(conversationId, record.actionHash));
        yield* store.applyCatchUpRecord(record);
        yield* expectReason(
          store.restartEmptyConversation({
            expectedFoundation: oldFoundation,
            replacementFoundation: replacement,
          }),
          "conflict",
        );
        const recovery = yield* store.recover();
        expect(recovery.positions[0]?.headRecordHash).toBe(record.recordHash);
        expect(recovery.positions[0]?.currentAnchorHash).toBe(
          oldFoundation.anchorHash,
        );
      }),
    ),
  );
}

function discardsOnlyAnExactCurrentOutboundSet() {
  const directory = stateDirectory();
  const conversationId = "conversation:discard-outbound";
  const first = outboundMessage(conversationId, "msg_discard_a", "outer:a");
  const second = outboundMessage(conversationId, "msg_discard_b", "outer:b");
  return Effect.runPromise(
    withStore(directory, (store) =>
      Effect.gen(function* () {
        yield* store.putConversationFoundation(foundation(conversationId));
        const retainedFirst = yield* store.enqueueOutbound(first);
        const retainedSecond = yield* store.enqueueOutbound(second);
        yield* expectReason(
          store.discardOutbound([
            retainedFirst,
            {
              ...retainedSecond,
              canonicalSignedMessage: bytes("outer:changed"),
            },
          ]),
          "conflict",
        );
        expect((yield* store.recover()).outboundMessages).toEqual([
          retainedFirst,
          retainedSecond,
        ]);
        expect(
          yield* store.discardOutbound([retainedFirst, retainedSecond]),
        ).toBe(INSERTED_MUTATION);
        expect(
          yield* store.discardOutbound([retainedFirst, retainedSecond]),
        ).toBe(EXISTING_MUTATION);
        expect((yield* store.recover()).outboundMessages).toEqual([]);
      }),
    ),
  );
}

function assertInitializedDatabase(directory: string): void {
  const path = databasePath(directory);
  const database = new DatabaseSync(path);
  expect(database.prepare("PRAGMA user_version").get()).toEqual(V2_SCHEMA_ROW);
  expect(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'post_intents'")
      .get(),
  ).toEqual(POST_INTENTS_TABLE_ROW);
  database.close();
  expect(statSync(directory).mode & 0o777).toBe(DIRECTORY_MODE);
  expect(statSync(path).mode & 0o777).toBe(DATABASE_FILE_MODE);
}

function assertLegacyDatabaseUnchanged(directory: string, path: string): void {
  expect(statSync(directory).mode & 0o777).toBe(LEGACY_DIRECTORY_MODE);
  expect(statSync(path).mode & 0o777).toBe(LEGACY_DATABASE_FILE_MODE);
  const retained = new DatabaseSync(path);
  expect(retained.prepare("PRAGMA user_version").get()).toEqual(
    LEGACY_SCHEMA_ROW,
  );
  expect(retained.prepare("PRAGMA journal_mode").get()).toEqual(
    DELETE_JOURNAL_ROW,
  );
  expect(
    retained
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'legacy_state'")
      .get(),
  ).toEqual(LEGACY_TABLE_ROW);
  retained.close();
}

function assertNonemptyDatabaseUnchanged(path: string): void {
  const retained = new DatabaseSync(path);
  expect(retained.prepare("PRAGMA user_version").get()).toEqual(
    EMPTY_SCHEMA_ROW,
  );
  expect(
    retained
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'post_intents'")
      .get(),
  ).toBeUndefined();
  expect(
    retained
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'unexpected_state'")
      .get(),
  ).toEqual(UNEXPECTED_TABLE_ROW);
  retained.close();
}

function writeRemoteDelivery(
  store: EndpointStore,
  record: CertifiedRecord,
  delivery: InboundDeliveryInput,
) {
  return Effect.gen(function* () {
    yield* bindLocalIdentity(store);
    yield* store.putConversationFoundation(foundation(record.conversationId));
    expect(yield* store.applyCatchUpRecord(record, delivery)).toBe(
      INSERTED_MUTATION,
    );
    const firstReplay = yield* store.readPendingDeliveries();
    expect(firstReplay).toHaveLength(1);
    const firstDelivery = firstReplay[0];
    if (firstDelivery === undefined) {
      return yield* Effect.die("pending delivery did not retain a row");
    }
    expect(firstDelivery.deliveryToken).toMatch(/^dlv_[A-Za-z0-9_-]{43}$/u);
    expect(yield* store.applyCatchUpRecord(record, delivery)).toBe(
      EXISTING_MUTATION,
    );
    expect((yield* store.readPendingDeliveries())[0]?.deliveryToken).toBe(
      firstDelivery.deliveryToken,
    );
    yield* expectReason(
      store.applyCatchUpRecord(record, {
        ...delivery,
        canonicalMessage: bytes("message:collision"),
      }),
      "conflict",
    );
    expect(yield* store.acknowledgeDelivery(firstDelivery.deliveryToken)).toBe(
      INSERTED_MUTATION,
    );
    expect(yield* store.acknowledgeDelivery(firstDelivery.deliveryToken)).toBe(
      EXISTING_MUTATION,
    );
    expect(yield* store.readPendingDeliveries()).toEqual([]);
    return firstDelivery.deliveryToken;
  });
}

function verifyRemoteDeliveryRecovery(
  store: EndpointStore,
  record: CertifiedRecord,
  retainedToken: string,
) {
  return Effect.gen(function* () {
    expect(yield* store.readPendingDeliveries()).toEqual([]);
    const recovery = yield* store.recover();
    expect(recovery.positions[0]?.headRecordHash).toBe(record.recordHash);
    expect(recovery.certifiedRecords[0]?.actionEvidence).toEqual(
      record.actionEvidence,
    );
    expect(recovery.certifiedRecords[0]?.durabilityEvidence).toEqual(
      record.durabilityEvidence,
    );
    expect(recovery.pendingDeliveries).toHaveLength(1);
    expect(recovery.pendingDeliveries[0]).toMatchObject({
      deliveryToken: retainedToken,
      acknowledged: true,
      recordHash: record.recordHash,
    });
  });
}

function certifiedRecord(
  conversationId: string,
  authorAgentId: string,
): CertifiedRecord {
  const actionHash = `ach_${conversationId}:0`;
  const recordHash = `rch_${conversationId}:0`;
  const conversationFoundation = foundation(conversationId);
  return {
    conversationId,
    recordHash,
    membershipHash: conversationFoundation.membershipHash,
    anchorHash: conversationFoundation.anchorHash,
    actionHash,
    authorAgentId,
    postId: `pst_${authorAgentId}`,
    canonicalRecordCore: bytes(`record:${conversationId}:0`),
    actionEvidence: [
      {
        conversationId,
        kind: "action",
        subjectId: actionHash,
        evidenceKey: authorAgentId,
        canonicalEvidence: bytes(`action-signature:${authorAgentId}`),
      },
    ],
    durabilityEvidence: [
      {
        conversationId,
        kind: "durability",
        subjectId: recordHash,
        evidenceKey: authorAgentId,
        canonicalEvidence: bytes(`durability-vote:${authorAgentId}`),
      },
    ],
  };
}

function stagedRecord(record: CertifiedRecord): StagedRecord {
  return {
    conversationId: record.conversationId,
    recordHash: record.recordHash,
    ...(record.previousRecordHash === undefined
      ? {}
      : { previousRecordHash: record.previousRecordHash }),
    membershipHash: record.membershipHash,
    anchorHash: record.anchorHash,
    actionHash: record.actionHash,
    authorAgentId: record.authorAgentId,
    postId: record.postId,
    canonicalRecordCore: record.canonicalRecordCore,
  };
}

function postIntent(conversationId: string, postId: string): PostIntent {
  return {
    conversationId,
    membershipHash: foundation(conversationId).membershipHash,
    authorAgentId: LOCAL_AGENT_ID,
    postId,
    canonicalIntent: bytes(`intent:${conversationId}:${postId}`),
  };
}

function foundation(conversationId: string): ConversationFoundation {
  return {
    conversationId,
    membershipHash: `mbr_${conversationId}`,
    canonicalMembership: bytes(`membership:${conversationId}`),
    anchorHash: `anc_${conversationId}:0`,
    canonicalAnchor: bytes(`anchor:${conversationId}:0`),
  };
}

function proposal(conversationId: string, actionHash: string): ProposalLock {
  return {
    conversationId,
    actionHash,
    canonicalActionCore: bytes(`action:${actionHash}`),
  };
}

function outboundMessage(
  conversationId: string,
  messageId: string,
  canonical: string,
): OutboundMessageInput {
  return {
    conversationId,
    messageId,
    canonicalSignedMessage: bytes(canonical),
  };
}

function disseminationObligation(
  kind: DisseminationObligation["kind"],
  record: StagedRecord,
): DisseminationObligation {
  return {
    conversationId: record.conversationId,
    recordHash: record.recordHash,
    kind,
  };
}

function localActionEvidence(
  conversationId: string,
  actionHash: string,
): ProtocolEvidence {
  return {
    conversationId,
    kind: "action",
    subjectId: actionHash,
    evidenceKey: LOCAL_AGENT_ID,
    canonicalEvidence: bytes("action-signature:local"),
  };
}

function bindLocalIdentity(
  store: EndpointStore,
): Effect.Effect<StoreMutation, EndpointStoreError> {
  return store.bindIdentity({
    agentId: LOCAL_AGENT_ID,
    canonicalAgentCard: bytes("card:local"),
  });
}

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "moltzap-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function databasePath(directory: string): string {
  return join(directory, "moltzapd.sqlite3");
}

function withStore<Value>(
  directory: string,
  use: (store: EndpointStore) => Effect.Effect<Value, EndpointStoreError>,
): Effect.Effect<Value, EndpointStoreError> {
  return Effect.scoped(openEndpointStore(directory).pipe(Effect.flatMap(use)));
}

function expectReason<Value>(
  effect: Effect.Effect<Value, EndpointStoreError>,
  reason: EndpointStoreError["reason"],
): Effect.Effect<void> {
  return Effect.flip(effect).pipe(
    Effect.orDie,
    Effect.tap((failure) => {
      expect(failure).toBeInstanceOf(EndpointStoreError);
      expect(failure.reason).toBe(reason);
      expect(Object.hasOwn(failure, "cause")).toBe(false);
      return Effect.void;
    }),
    Effect.asVoid,
  );
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("endpoint SQLite preflight", () => {
  it("initializes an empty v0 database directly as v2 and reopens it", () =>
    initializesEmptyV0Database());

  it("rejects v1 without changing the database or its permissions", () =>
    rejectsV1WithoutMutation());

  it("rejects a nonempty v0 database without creating v2 objects", () =>
    rejectsNonemptyV0WithoutInitialization());
});

describe("endpoint proposal locking", () => {
  it("atomically binds the first post intent with its foundation", () =>
    atomicallyBindsFirstIntentWithItsFoundation());

  it("atomically locks a verified genesis with its foundation", () =>
    atomicallyLocksVerifiedGenesisFoundation());

  it("retains the first proposal lock across conflicts and restart", () =>
    retainsFirstProposalAcrossRestart());

  it("keeps identical generated proposal locks idempotent", () =>
    fc.assert(
      fc.asyncProperty(fc.integer(), (seed) =>
        retainsIdempotentProposalForSeed(seed),
      ),
      { numRuns: PROPERTY_RUNS },
    ));
});

describe("endpoint record certification and delivery", () => {
  it("atomically promotes remote catch-up and replays one stable delivery", () =>
    promotesRemoteRecordWithStableDelivery());

  it("rolls back remote certification when its delivery is absent", () =>
    rollsBackRemoteRecordWithoutDelivery());

  it("completes a local post intent without creating self-delivery", () =>
    completesLocalPostWithoutSelfDelivery());
});

describe("endpoint durable Router outbox", () => {
  it("replays, retries, replaces, and completes exact envelopes", () =>
    persistsExactOutboundLifecycleAcrossRestart());

  it("invalidates only an exact current envelope set atomically", () =>
    discardsOnlyAnExactCurrentOutboundSet());

  it("recovers record dissemination before and after outbox attachment", () =>
    retainsRecordDisseminationAcrossCrashWindows());
});

describe("endpoint empty-history Router restart", () => {
  it("retains intents while replacing only incomplete state", () =>
    restartsOnlyAnEmptyConversationAtomically());

  it("refuses to replace a foundation after certification", () =>
    refusesEmptyRestartAfterCertification());
});
