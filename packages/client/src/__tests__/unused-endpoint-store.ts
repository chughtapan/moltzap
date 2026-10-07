/** @file An endpoint store whose every operation dies, for tests that override the few they use. */

import { Effect } from "effect";
import type { EndpointStore } from "../store/index.js";

/**
 * A store whose every operation dies naming `label`, so a test spreads it and
 * overrides only the operations its subject should reach; any other call
 * fails the test with the label.
 * @param label The test that owns the store, named in the defect.
 * @returns A complete store with no usable operation.
 */
export function unusedEndpointStore(label: string): EndpointStore {
  const unused = () => Effect.dieMessage(`store operation outside ${label}`);
  return {
    readLegacyPendingDeliveries: unused,
    readInboxItem: unused,
    completeWebhookDelivery: unused,
    putInboxItem: unused,
    readInbox: unused,
    readInboxSummary: unused,
    acknowledgeInboxItem: unused,
    replaceInboxItem: unused,
    beginSendAttempt: unused,
    finishSendAttempt: unused,
    readSendAttempt: unused,
    readEventState: unused,
    writeEventState: unused,
    readIdentity: unused,
    bindIdentity: unused,
    bindPostIntent: unused,
    putConversationFoundation: unused,
    lockProposal: unused,
    lockGenesisProposal: unused,
    supersedeProposalLock: unused,
    stageRecord: unused,
    stageCertifiedRecord: unused,
    stageRecordForDissemination: unused,
    mergeEvidence: unused,
    promoteRecord: unused,
    applyCatchUpRecord: unused,
    stageReanchor: unused,
    completeReanchor: unused,
    applyCatchUpReanchor: unused,
    readPendingDeliveries: unused,
    acknowledgeDelivery: unused,
    enqueueOutbound: unused,
    enqueueDisseminationOutbound: unused,
    beginOutbound: unused,
    completeOutbound: unused,
    discardOutbound: unused,
    restartEmptyConversation: unused,
    searchConversations: unused,
    readConversation: unused,
    releaseContinuation: unused,
    recover: unused,
  };
}
