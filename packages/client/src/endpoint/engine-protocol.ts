/** @file Authenticated START ingress and closed unsupported-packet handling. */

import {
  SignedMessage,
  type SignedMessage as SignedMessageValue,
} from "@moltzap/identity";
import { Effect, Schema } from "effect";
import {
  ActionBinding,
  type ActionCertifiedRecord,
  type CertifiedRecord,
  ClientRepresentationError,
  decodeCanonical,
  encodeCanonical,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  GenesisAnchor,
  makeActionBinding,
  memberCard,
  Membership,
  type StartProposal,
  verifyActionCertifiedRecord,
  verifyCertifiedRecord,
  verifyOuterMessage,
  verifyStableEvidence,
  verifyStartProposal,
} from "./representation.js";
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
import type { EngineActionFold, EngineRuntime } from "./engine-types.js";
import type { DecodedOuterBody } from "./representation.js";
import {
  type RouterIngressDisposition,
  type RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "./router-worker.js";
import { EndpointStoreError } from "./store.js";

const accepted = "accepted" as const;
const ignored = "ignored" as const;
const blocked = (): RouterWorkerPersistenceError =>
  new RouterWorkerPersistenceError();

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
    let conversation = runtime.conversations.get(
      proposal.action.conversationId,
    );
    if (conversation === undefined) {
      conversation = {
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
      };
      runtime.conversations.set(proposal.action.conversationId, conversation);
    } else if (
      !(yield* sameCanonical(
        ActionBinding,
        yield* makeActionBinding(conversation.action),
        yield* makeActionBinding(proposal.action),
      ))
    ) {
      return ignored;
    }
    if (!conversation.actionSignatureQueued) {
      const signature = yield* signLocalAction(runtime, conversation).pipe(
        Effect.mapError(blocked),
      );
      yield* queueOuterEvidence(runtime, conversation, signature).pipe(
        Effect.mapError(blocked),
      );
      conversation.actionSignatureQueued = true;
    }
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
    conversation.actionCertifiedRecord = certified.actionCertifiedRecord;
    conversation.recordHash = certified.recordHash;
    runtime.recordFolds.set(certified.recordHash, conversation);
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
      return Effect.gen(function* () {
        yield* verifyOuterMessage({
          message: ingress.message,
          membership: conversation.membership,
        });
        const representation = yield* Schema.encode(SignedMessage)(
          message,
        ).pipe(Effect.mapError(() => new ClientRepresentationError()));
        const verified = yield* verifyStableEvidence({
          representation,
          membership: conversation.membership,
        });
        switch (verified.statement.kind) {
          case "action_signature":
            return yield* acceptActionSignature(
              runtime,
              conversation,
              verified.message,
              verified.statement,
            );
          case "durability_vote":
            return yield* acceptDurabilityVote(
              runtime,
              conversation,
              verified.message,
              verified.statement,
            );
          case "ack":
          case "catch_up_attestation":
          case "reanchor_vote":
            return ignored;
          default: {
            const exhaustive: never = verified.statement;
            return exhaustive;
          }
        }
      }).pipe(
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

/** Apply one already outer-authenticated Router payload in order. */
export const acceptEngineIngress = (
  runtime: EngineRuntime,
  ingress: RouterWorkerIngress<DecodedOuterBody>,
): Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError> =>
  runtime.gate.withPermits(1)(
    ingress.payload.kind === "evidence"
      ? routeEvidence(runtime, ingress, ingress.payload.message)
      : (() => {
          switch (ingress.payload.packet.kind) {
            case "start_proposal":
              return acceptStartProposal(
                runtime,
                ingress,
                ingress.payload.packet,
              );
            case "action_certified_record":
              return acceptActionCertifiedRecord(
                runtime,
                ingress,
                ingress.payload.packet,
              );
            case "certified_record":
              return acceptCertifiedRecord(
                runtime,
                ingress,
                ingress.payload.packet,
              );
            case "begin":
            case "multicast_proposal":
              return (
                runtime.openFloor?.acceptIngress(ingress) ??
                Effect.succeed(ignored)
              );
            case "catch_up_request":
            case "catch_up_page":
            case "catch_up_incomplete":
            case "completed_reanchor":
              return Effect.succeed(ignored);
            default: {
              const exhaustive: never = ingress.payload.packet;
              return Effect.succeed(exhaustive);
            }
          }
        })(),
  );
