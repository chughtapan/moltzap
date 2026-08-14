/** @file Internal store assembly behind the stable endpoint/store.ts facade. */

import { Effect, type Scope } from "effect";
import type { EndpointStore } from "./types.js";
import {
  applyCatchUpReanchor,
  bindIdentity,
  bindStartIntent,
  completeReanchor,
  putConversationFoundation,
  stageReanchor,
} from "./anchors.js";
import {
  closeStoreState,
  EndpointStoreError,
  openStoreState,
  runStoreOperation,
  type StoreState,
} from "./database/index.js";
import {
  readStoredConversation,
  recoverStoredState,
  releaseStoredContinuation,
  searchStoredConversations,
} from "./management.js";
import {
  applyCatchUpRecord,
  consumeAttention,
  hasConsumedAttention,
  mergeEvidence,
  promoteRecord,
  stageRecord,
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
  const run = <Value>(operation: () => Value) =>
    runStoreOperation(state, operation);
  const store: EndpointStore = {
    readIdentity: () => run(() => bindIdentity.read(state.database)),
    bindIdentity: (binding) =>
      run(() => bindIdentity.write(state.database, binding)),
    bindStartIntent: (intent) =>
      run(() => bindStartIntent(state.database, intent)),
    putConversationFoundation: (foundation) =>
      run(() => putConversationFoundation(state.database, foundation)),
    stageRecord: (record) => run(() => stageRecord(state.database, record)),
    mergeEvidence: (evidence) =>
      run(() => mergeEvidence(state.database, evidence)),
    promoteRecord: (record) => run(() => promoteRecord(state.database, record)),
    applyCatchUpRecord: (record) =>
      run(() => applyCatchUpRecord(state.database, record)),
    stageReanchor: (reanchor) =>
      run(() => stageReanchor(state.database, reanchor)),
    completeReanchor: (reanchor) =>
      run(() => completeReanchor(state.database, reanchor)),
    applyCatchUpReanchor: (reanchor) =>
      run(() => applyCatchUpReanchor(state.database, reanchor)),
    consumeAttention: (input) =>
      run(() => consumeAttention(state.database, input)),
    hasConsumedAttention: (input) =>
      run(() => hasConsumedAttention(state.database, input)),
    searchConversations: (input = {}) =>
      run(() => searchStoredConversations(state.database, input)),
    readConversation: (request) =>
      run(() => readStoredConversation(state, request)),
    releaseContinuation: (continuation) =>
      run(() => {
        releaseStoredContinuation(state, continuation);
      }),
    recover: () => run(() => recoverStoredState(state.database)),
  };
  return Object.freeze(store);
}
