/** @file Store assembly behind the store's index.ts entrypoint. */

import { Effect, type Scope } from "effect";
import type { EndpointStore } from "./types.js";
import {
  applyCatchUpReanchor,
  bindIdentity,
  bindPostIntent,
  completeReanchor,
  lockGenesisProposal,
  lockProposal,
  putConversationFoundation,
  restartEmptyConversation,
  stageReanchor,
} from "./anchors.js";
import {
  closeStoreState,
  EndpointStoreError,
  inspectStoreState,
  openStoreState,
  runStoreOperation,
  type StoreOpening,
  type StoreState,
} from "./database/index.js";
import {
  acknowledgeInboxItem,
  beginSendAttempt,
  completeWebhookDelivery,
  finishSendAttempt,
  putInboxItem,
  readEventState,
  readInbox,
  readInboxItem,
  readInboxSummary,
  readSendAttempt,
  replaceInboxItem,
  writeEventState,
} from "./inbox.js";
import {
  acknowledgeDelivery,
  beginOutbound,
  completeOutbound,
  discardOutbound,
  enqueueDisseminationOutbound,
  enqueueOutbound,
  enqueueOutboundInTransaction,
  readPendingDeliveries,
} from "./queues/index.js";
import {
  readStoredConversation,
  recoverStoredState,
  releaseStoredContinuation,
  searchStoredConversations,
} from "./reads.js";
import {
  applyCatchUpRecord,
  mergeEvidence,
  promoteRecord,
  promoteRecordForDissemination,
  stageCertifiedRecord,
  stageRecord,
  stageRecordForDissemination,
  supersedeProposalLock,
} from "./records.js";

/** Closed endpoint-store failures without SQLite implementation details. */
export { EndpointStoreError };

/**
 * Reads, without writing, whether opening the store in a state directory
 * creates an empty store, which leaves the daemon unregistered, or reopens the
 * current one.
 *
 * @param stateDirectory Exclusive persistent state directory.
 * @returns How `openEndpointStore` will open the store.
 * @failure EndpointStoreError when the database is incompatible or corrupt.
 */
export const inspectEndpointStore = (
  stateDirectory: string,
): Effect.Effect<StoreOpening, EndpointStoreError> =>
  inspectStoreState(stateDirectory).pipe(
    Effect.withSpan("inspectEndpointStore"),
  );

/**
 * Opens the one SQLite store owned by a daemon state directory.
 *
 * @param stateDirectory Exclusive persistent state directory.
 * @returns A scoped private endpoint-store capability.
 * @failure EndpointStoreError when the directory or database cannot be owned.
 */
export const openEndpointStore = (
  stateDirectory: string,
): Effect.Effect<EndpointStore, EndpointStoreError, Scope.Scope> =>
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned Scope requirement binds SQLite ownership to daemon acquisition.
  Effect.acquireRelease(openStoreState(stateDirectory), closeStoreState).pipe(
    Effect.map(makeEndpointStore),
    Effect.withSpan("openEndpointStore"),
  );

function makeEndpointStore(state: StoreState): EndpointStore {
  const run = makeStoreRunner(state);
  const store: EndpointStore = {
    ...makeHistoryOperations(state, run),
    ...makeTransportOperations(state, run),
    ...makeManagementOperations(state, run),
    ...makeInboxOperations(state, run),
  };
  return Object.freeze(store);
}

function makeInboxOperations(state: StoreState, run: StoreRunner) {
  return {
    readInboxItem: (token) => run(() => readInboxItem(state.database, token)),
    completeWebhookDelivery: (token, value) =>
      run(() => {
        completeWebhookDelivery(state.database, token, value);
      }),
    putInboxItem: (item) => run(() => putInboxItem(state.database, item)),
    readInbox: (input) => run(() => readInbox(state.database, input)),
    readInboxSummary: () => run(() => readInboxSummary(state.database)),
    acknowledgeInboxItem: (token) =>
      run(() => {
        acknowledgeInboxItem(state.database, token);
      }),
    replaceInboxItem: (token, replacement) =>
      run(() => {
        replaceInboxItem(state.database, token, replacement);
      }),
    beginSendAttempt: (key, input) =>
      run(() => beginSendAttempt(state.database, key, input)),
    finishSendAttempt: (key, outcome) =>
      run(() => {
        finishSendAttempt(state.database, key, outcome);
      }),
    readSendAttempt: (key) => run(() => readSendAttempt(state.database, key)),
    readEventState: () => run(() => readEventState(state.database)),
    writeEventState: (value) =>
      run(() => {
        writeEventState(state.database, value);
      }),
  } satisfies Partial<EndpointStore>;
}

type StoreRunner = <Value>(
  operation: () => Value,
) => Effect.Effect<Value, EndpointStoreError>;

function makeStoreRunner(state: StoreState): StoreRunner {
  return <Value>(operation: () => Value) => runStoreOperation(state, operation);
}

function makeHistoryOperations(state: StoreState, run: StoreRunner) {
  return {
    readIdentity: () => run(() => bindIdentity.read(state.database)),
    bindIdentity: (binding) =>
      run(() => bindIdentity.write(state.database, binding)),
    bindPostIntent: (binding) =>
      run(() => bindPostIntent(state.database, binding)),
    putConversationFoundation: (foundation) =>
      run(() => putConversationFoundation(state.database, foundation)),
    lockProposal: (proposal) =>
      run(() => lockProposal(state.database, proposal)),
    lockGenesisProposal: (foundation, proposal) =>
      run(() => lockGenesisProposal(state.database, foundation, proposal)),
    supersedeProposalLock: (lock, certificate) =>
      run(() => supersedeProposalLock(state.database, lock, certificate)),
    stageRecord: (record) => run(() => stageRecord(state.database, record)),
    stageCertifiedRecord: (record) =>
      run(() => stageCertifiedRecord(state.database, record)),
    stageRecordForDissemination: (record) =>
      run(() => stageRecordForDissemination(state.database, record)),
    mergeEvidence: (evidence) =>
      run(() => mergeEvidence(state.database, evidence)),
    promoteRecord: (record, delivery) =>
      run(() => promoteRecord(state.database, record, delivery)),
    promoteRecordForDissemination: (record, delivery) =>
      run(() =>
        promoteRecordForDissemination(state.database, record, delivery),
      ),
    applyCatchUpRecord: (record, delivery) =>
      run(() => applyCatchUpRecord(state.database, record, delivery)),
    stageReanchor: (reanchor) =>
      run(() => stageReanchor(state.database, reanchor)),
    completeReanchor: (reanchor) =>
      run(() => completeReanchor(state.database, reanchor)),
    applyCatchUpReanchor: (reanchor) =>
      run(() => applyCatchUpReanchor(state.database, reanchor)),
  } satisfies Partial<EndpointStore>;
}

function makeTransportOperations(state: StoreState, run: StoreRunner) {
  return {
    readPendingDeliveries: () =>
      run(() => readPendingDeliveries(state.database)),
    acknowledgeDelivery: (deliveryToken) =>
      run(() => acknowledgeDelivery(state.database, deliveryToken)),
    enqueueOutbound: (message) =>
      run(() => enqueueOutbound(state.database, message)),
    enqueueDisseminationOutbound: (obligation, message) =>
      run(() =>
        enqueueDisseminationOutbound(
          state.database,
          obligation,
          message,
          enqueueOutboundInTransaction,
        ),
      ),
    beginOutbound: (outboundId) =>
      run(() => beginOutbound(state.database, outboundId)),
    completeOutbound: (outbound) =>
      run(() => completeOutbound(state.database, outbound)),
    discardOutbound: (outbounds) =>
      run(() => discardOutbound(state.database, outbounds)),
    restartEmptyConversation: (restart) =>
      run(() => restartEmptyConversation(state.database, restart)),
  } satisfies Partial<EndpointStore>;
}

function makeManagementOperations(state: StoreState, run: StoreRunner) {
  return {
    searchConversations: (input = {}) =>
      run(() => searchStoredConversations(state.database, input)),
    readConversation: (request) =>
      run(() => readStoredConversation(state, request)),
    releaseContinuation: (continuation) =>
      run(() => {
        releaseStoredContinuation(state, continuation);
      }),
    recover: () => run(() => recoverStoredState(state.database)),
  } satisfies Partial<EndpointStore>;
}
