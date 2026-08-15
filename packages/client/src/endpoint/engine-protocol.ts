/** @file Authenticated START ingress and closed unsupported-packet handling. */

import {
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Effect, Schema } from "effect";
import type {
  EngineActionFold,
  EngineConversation,
  EngineRuntime,
} from "./engine-types.js";
import type { EndpointStoreError } from "./store.js";
import {
  adoptActionCertifiedRecord,
  completeActionRecord,
  maybeCertifyAction,
  maybePromote,
  persistEvidence,
  resumeActionFold,
  retainCertifiedVotes,
  sameCanonical,
  stageEngineRecord,
} from "./engine-durability.js";
import {
  canonicalStartIntent,
  queueOuterEvidence,
  signLocalAction,
} from "./engine-start.js";
import {
  ActionBinding,
  type ActionCertifiedRecord,
  type CertifiedRecord,
  ClientRepresentationError,
  decodeCanonical,
  type DecodedOuterBody,
  encodeCanonical,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  GenesisAnchor,
  makeActionBinding,
  memberCard,
  Membership,
  type StartProposal,
  type VerifiedMembership,
  verifyActionCertifiedRecord,
  verifyCertifiedRecord,
  verifyOuterMessage,
  verifyStableEvidence,
  verifyStartProposal,
} from "./representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "./router-worker.js";

const accepted: RouterIngressDisposition = "accepted";
const ignored: RouterIngressDisposition = "ignored";
const blocked = (): RouterWorkerPersistenceError =>
  new RouterWorkerPersistenceError();

type DirectPacket = Extract<
  DecodedOuterBody,
  { readonly kind: "direct" }
>["packet"];

interface VerifiedIngressEvidence {
  readonly message: SignedMessageValue;
  readonly statement: EvidenceStatementValue;
}

const durableStoreFailure = (error: EndpointStoreError): boolean =>
  error.reason === "closed" ||
  error.reason === "corrupt" ||
  error.reason === "incompatible" ||
  error.reason === "persistence";

const closeStoreError = (
  error: EndpointStoreError,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  durableStoreFailure(error) ? Effect.fail(blocked()) : Effect.succeed(ignored);

const actionMatchesConversation = (
  conversation: EngineActionFold,
  record: ActionCertifiedRecord,
): Effect.Effect<boolean, ClientRepresentationError> =>
  Effect.gen(function* () {
    if (
      record.membership.conversationId !== conversation.conversationId ||
      record.anchorHash !== conversation.action.anchorHash
    ) {
      return false;
    }
    return yield* sameCanonical(
      ActionBinding,
      yield* makeActionBinding(record.action),
      yield* makeActionBinding(conversation.action),
    );
  });

const foldForAction = (
  runtime: EngineRuntime,
  action: ActionCertifiedRecord["action"],
): EngineActionFold | undefined =>
  action.kind === "start_action"
    ? runtime.conversations.get(action.conversationId)
    : runtime.multicastFolds.get(action.beginDigest);

const persistStartFoundation = (
  runtime: EngineRuntime,
  proposal: StartProposal,
  membership: VerifiedMembership,
  canonicalIntent: Uint8Array,
) =>
  Effect.gen(function* () {
    yield* runtime.input.store.bindStartIntent({
      conversationId: proposal.action.conversationId,
      canonicalIntent,
    });
    yield* runtime.input.store.putConversationFoundation({
      conversationId: proposal.action.conversationId,
      membershipHash: membership.hash,
      canonicalMembership: yield* encodeCanonical(
        Membership,
        membership.membership,
      ),
      anchorHash: proposal.action.anchorHash,
      canonicalAnchor: yield* encodeCanonical(
        GenesisAnchor,
        proposal.genesisAnchor,
      ),
    });
  });

const newStartConversation = (
  proposal: StartProposal,
  membership: VerifiedMembership,
  canonicalIntent: Uint8Array,
): EngineConversation => ({
  foldKind: "start",
  conversationId: proposal.action.conversationId,
  canonicalIntent,
  membership,
  genesisAnchor: proposal.genesisAnchor,
  currentAnchor: proposal.genesisAnchor,
  action: proposal.action,
  actionSignatures: new Map(),
  durabilityVotes: new Map(),
  actionSignatureQueued: false,
  durabilityVoteQueued: false,
  certifiedBroadcastQueued: false,
});

const installStartConversation = (
  runtime: EngineRuntime,
  proposal: StartProposal,
  membership: VerifiedMembership,
  canonicalIntent: Uint8Array,
): Effect.Effect<EngineConversation | undefined, ClientRepresentationError> => {
  const retained = runtime.conversations.get(proposal.action.conversationId);
  if (retained === undefined) {
    const created = newStartConversation(proposal, membership, canonicalIntent);
    runtime.conversations.set(proposal.action.conversationId, created);
    return Effect.succeed(created);
  }
  return Effect.gen(function* () {
    const retainedBinding = yield* makeActionBinding(retained.action);
    const proposalBinding = yield* makeActionBinding(proposal.action);
    return (yield* sameCanonical(
      ActionBinding,
      retainedBinding,
      proposalBinding,
    ))
      ? retained
      : undefined;
  });
};

const enqueueStartSignature = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const signature = yield* signLocalAction(runtime, conversation).pipe(
      Effect.mapError(blocked),
    );
    yield* queueOuterEvidence(runtime, conversation, signature).pipe(
      Effect.mapError(blocked),
    );
    yield* Effect.sync(() => {
      conversation.actionSignatureQueued = true;
    });
  });

const queueStartSignature = (
  runtime: EngineRuntime,
  conversation: EngineConversation,
): Effect.Effect<void, RouterWorkerPersistenceError> =>
  conversation.actionSignatureQueued
    ? Effect.void
    : enqueueStartSignature(runtime, conversation);

const acceptStartProposal = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  proposal: StartProposal,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const membership = yield* verifyStartProposal({
      proposal,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    });
    yield* verifyOuterMessage({ message: ingress.message, membership });
    if (
      ingress.message.senderAgentId !== proposal.action.authorAgentId ||
      memberCard(membership, runtime.input.localAgentCard.agentId) === undefined
    ) {
      return ignored;
    }
    const canonicalIntent = yield* canonicalStartIntent(
      runtime,
      membership,
      proposal.action.content,
    );
    yield* persistStartFoundation(
      runtime,
      proposal,
      membership,
      canonicalIntent,
    );
    const conversation = yield* installStartConversation(
      runtime,
      proposal,
      membership,
      canonicalIntent,
    );
    if (conversation === undefined) {
      return ignored;
    }
    yield* queueStartSignature(runtime, conversation);
    yield* resumeActionFold(runtime, conversation);
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
    Effect.catchTag("EndpointStoreError", closeStoreError),
  );

const acceptActionCertifiedRecord = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  record: ActionCertifiedRecord,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> => {
  const conversation = foldForAction(runtime, record.action);
  if (conversation === undefined) {
    return Effect.succeed(ignored);
  }
  return Effect.gen(function* () {
    const verified = yield* verifyActionCertifiedRecord({
      record,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    });
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: verified.membership,
    });
    if (
      verified.membership.hash !== conversation.membership.hash ||
      memberCard(verified.membership, runtime.input.localAgentCard.agentId) ===
        undefined ||
      !(yield* actionMatchesConversation(conversation, record))
    ) {
      return ignored;
    }
    yield* adoptActionCertifiedRecord(
      runtime,
      conversation,
      record,
      verified.recordHash,
    );
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
    Effect.catchTag("EndpointStoreError", closeStoreError),
  );
};

const retainCertifiedAction = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  certified: CertifiedRecord,
): Effect.Effect<void> =>
  Effect.sync(() => {
    conversation.actionCertifiedRecord = certified.actionCertifiedRecord;
    conversation.recordHash = certified.recordHash;
    runtime.recordFolds.set(certified.recordHash, conversation);
  });

const acceptCertifiedRecord = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  certified: CertifiedRecord,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> => {
  const conversation = foldForAction(
    runtime,
    certified.actionCertifiedRecord.action,
  );
  if (conversation === undefined) {
    return Effect.succeed(ignored);
  }
  return Effect.gen(function* () {
    const membership = yield* verifyCertifiedRecord({
      record: certified,
      registrySignerPublicKey: runtime.input.registrySignerPublicKey,
    });
    yield* verifyOuterMessage({ message: ingress.message, membership });
    if (
      membership.hash !== conversation.membership.hash ||
      memberCard(membership, runtime.input.localAgentCard.agentId) ===
        undefined ||
      !(yield* actionMatchesConversation(
        conversation,
        certified.actionCertifiedRecord,
      ))
    ) {
      return ignored;
    }
    yield* stageEngineRecord(
      runtime,
      conversation,
      certified.actionCertifiedRecord,
      certified.recordHash,
    );
    yield* retainCertifiedAction(runtime, conversation, certified);
    yield* retainCertifiedVotes(runtime, conversation, certified);
    yield* completeActionRecord(runtime, conversation, certified);
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
    Effect.catchTag("EndpointStoreError", closeStoreError),
  );
};

const foldForEvidence = (
  runtime: EngineRuntime,
  statement: EvidenceStatementValue,
): EngineActionFold | undefined => {
  switch (statement.kind) {
    case "action_signature":
      return statement.action.beginDigest === null
        ? runtime.conversations.get(statement.action.conversationId)
        : runtime.multicastFolds.get(statement.action.beginDigest);
    case "durability_vote":
      return runtime.recordFolds.get(statement.recordHash);
    case "ack":
    case "catch_up_attestation":
    case "reanchor_vote":
      return undefined;
    default: {
      const exhaustive: never = statement;
      return exhaustive;
    }
  }
};

const acceptActionSignature = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  message: SignedMessageValue,
  statement: Extract<
    EvidenceStatementValue,
    { readonly kind: "action_signature" }
  >,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    const expected = yield* makeActionBinding(conversation.action);
    if (!(yield* sameCanonical(ActionBinding, statement.action, expected))) {
      return ignored;
    }
    yield* persistEvidence(
      runtime,
      conversation.conversationId,
      "action",
      conversation.action.beginDigest ?? conversation.action.anchorHash,
      statement.signerAgentId,
      message,
    );
    conversation.actionSignatures.set(statement.signerAgentId, message);
    yield* maybeCertifyAction(runtime, conversation);
    return accepted;
  }).pipe(
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
    Effect.catchTag("EndpointStoreError", closeStoreError),
  );

const acceptDurabilityVote = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  message: SignedMessageValue,
  statement: Extract<
    EvidenceStatementValue,
    { readonly kind: "durability_vote" }
  >,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  Effect.gen(function* () {
    if (
      conversation.recordHash === undefined ||
      statement.membershipHash !== conversation.membership.hash ||
      statement.recordHash !== conversation.recordHash
    ) {
      return ignored;
    }
    yield* persistEvidence(
      runtime,
      conversation.conversationId,
      "durability",
      statement.recordHash,
      statement.signerAgentId,
      message,
    );
    conversation.durabilityVotes.set(statement.signerAgentId, message);
    yield* maybePromote(runtime, conversation);
    return accepted;
  }).pipe(Effect.catchTag("EndpointStoreError", closeStoreError));

const verifyIngressEvidence = (
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  conversation: EngineActionFold,
  message: SignedMessageValue,
): Effect.Effect<VerifiedIngressEvidence, ClientRepresentationError> =>
  Effect.gen(function* () {
    yield* verifyOuterMessage({
      message: ingress.message,
      membership: conversation.membership,
    });
    const representation = yield* Schema.encode(SignedMessage)(message).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new ClientRepresentationError()),
      ),
    );
    return yield* verifyStableEvidence({
      representation,
      membership: conversation.membership,
    });
  });

const dispatchEvidence = (
  runtime: EngineRuntime,
  conversation: EngineActionFold,
  verified: VerifiedIngressEvidence,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> => {
  switch (verified.statement.kind) {
    case "action_signature":
      return acceptActionSignature(
        runtime,
        conversation,
        verified.message,
        verified.statement,
      );
    case "durability_vote":
      return acceptDurabilityVote(
        runtime,
        conversation,
        verified.message,
        verified.statement,
      );
    case "ack":
    case "catch_up_attestation":
    case "reanchor_vote":
      return Effect.succeed(ignored);
    default: {
      const exhaustive: never = verified.statement;
      return Effect.succeed(exhaustive);
    }
  }
};

const acceptEvidence = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessageValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  decodeCanonical(EvidenceStatement, message.body).pipe(
    Effect.flatMap((decoded) => {
      const conversation = foldForEvidence(runtime, decoded);
      if (conversation === undefined) {
        return Effect.succeed(ignored);
      }
      return verifyIngressEvidence(ingress, conversation, message).pipe(
        Effect.flatMap((verified) =>
          dispatchEvidence(runtime, conversation, verified),
        ),
        Effect.catchTag("ClientRepresentationError", () =>
          Effect.succeed(ignored),
        ),
      );
    }),
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );

const routeEvidence = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  message: SignedMessageValue,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  decodeCanonical(EvidenceStatement, message.body).pipe(
    Effect.flatMap((statement) =>
      statement.kind === "ack" && runtime.openFloor !== undefined
        ? runtime.openFloor.acceptIngress(ingress)
        : acceptEvidence(runtime, ingress, message),
    ),
    Effect.catchTag("ClientRepresentationError", () => Effect.succeed(ignored)),
  );

type IngressEffect = Effect.Effect<
  RouterIngressDisposition,
  RouterWorkerPersistenceError
>;

const routeCertifiedPacket = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: DirectPacket,
): IngressEffect | undefined => {
  if (packet.kind === "start_proposal") {
    return acceptStartProposal(runtime, ingress, packet);
  }
  if (packet.kind === "action_certified_record") {
    return acceptActionCertifiedRecord(runtime, ingress, packet);
  }
  if (packet.kind === "certified_record") {
    return acceptCertifiedRecord(runtime, ingress, packet);
  }
  return undefined;
};

const routeDirectPacket = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
  packet: DirectPacket,
): IngressEffect => {
  const certified = routeCertifiedPacket(runtime, ingress, packet);
  if (certified !== undefined) {
    return certified;
  }
  if (packet.kind === "begin" || packet.kind === "multicast_proposal") {
    return runtime.openFloor?.acceptIngress(ingress) ?? Effect.succeed(ignored);
  }
  return Effect.succeed(ignored);
};

/**
 * Apply one already outer-authenticated Router payload in order.
 * @param runtime Endpoint state and durable dependencies.
 * @param ingress Outer-authenticated Router payload and ordering anchor.
 * @returns The worker disposition after applying or ignoring the payload.
 */
export const acceptEngineIngress = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  runtime.gate.withPermits(1)(
    ingress.payload.kind === "evidence"
      ? routeEvidence(runtime, ingress, ingress.payload.message)
      : routeDirectPacket(runtime, ingress, ingress.payload.packet),
  );
