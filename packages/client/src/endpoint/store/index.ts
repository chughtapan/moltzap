/** @file Internal store assembly behind the stable endpoint/store.ts facade. */

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
  openStoreState,
  runStoreOperation,
  type StoreState,
} from "./database/index.js";
import { acknowledgeDelivery, readPendingDeliveries } from "./deliveries.js";
import { enqueueDisseminationOutbound } from "./dissemination.js";
import {
  readStoredConversation,
  recoverStoredState,
  releaseStoredContinuation,
  searchStoredConversations,
} from "./management.js";
import {
  beginOutbound,
  completeOutbound,
  discardOutbound,
  enqueueOutbound,
  replaceOutbound,
} from "./outbound.js";
import {
  applyCatchUpRecord,
  mergeEvidence,
  promoteRecord,
  promoteRecordForDissemination,
  stageRecord,
  stageRecordForDissemination,
} from "./records.js";

/** Closed endpoint-store failures without SQLite implementation details. */
export { EndpointStoreError };

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
  };
  return Object.freeze(store);
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
    stageRecord: (record) => run(() => stageRecord(state.database, record)),
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
        enqueueDisseminationOutbound(state.database, obligation, message),
      ),
    beginOutbound: (outboundId) =>
      run(() => beginOutbound(state.database, outboundId)),
    replaceOutbound: (current, replacement) =>
      run(() => replaceOutbound(state.database, current, replacement)),
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
