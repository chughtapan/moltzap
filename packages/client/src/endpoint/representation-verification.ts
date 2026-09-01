/** @file Cryptographic and cross-field verification for Client protocol values. */

import {
  AgentCard,
  type AgentId,
  type Ed25519PublicKey,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
  type VerifiedAgentCard,
  type VerifiedSignedMessage,
} from "@moltzap/identity";
import { Effect, Schema } from "effect";
import {
  type ClientRepresentationError,
  decodeCanonical,
  encodeCanonical,
  representationFailure,
  sameBytes,
} from "./representation-canonical.js";
import {
  compareAgentIds,
  deriveConversationId,
  deriveEvidenceMessageId,
  hashAction,
  hashAnchor,
  hashMembershipDescriptor,
  hashPostIntent,
  hashRecord,
  type OuterMembership,
} from "./representation-codec.js";
import {
  type ActionCertifiedRecord,
  type ActionCore,
  type ActionHash,
  type ActionProposal,
  type AnchorHash,
  type CatchUpAttestationStatement,
  type CatchUpIncomplete,
  type CatchUpPage,
  CatchUpRequest,
  type CatchUpRequest as CatchUpRequestValue,
  type CertifiedRecord,
  type CompletedReanchor,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  GenesisAnchorBody,
  MembershipDescriptor,
  type MembershipDescriptor as MembershipDescriptorValue,
  type MembershipHash,
  ReanchorBody,
  type RecordCore,
  type RecordHash,
} from "./representation-schemas.js";

/* eslint-disable jsdoc/require-jsdoc -- The package-private representation facade documents these closed verification operations. */

const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

const sortedDistinct = (agentIds: readonly AgentId[]): boolean => {
  for (let index = 1; index < agentIds.length; index += 1) {
    const previous = agentIds[index - 1];
    const current = agentIds[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareAgentIds(previous, current) >= 0
    ) {
      return false;
    }
  }
  return true;
};

const equalCanonical = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  left: A,
  right: A,
): Effect.Effect<boolean, ClientRepresentationError, R> =>
  Effect.all([
    encodeCanonical(schema, left),
    encodeCanonical(schema, right),
  ]).pipe(
    Effect.map(([leftBytes, rightBytes]) => sameBytes(leftBytes, rightBytes)),
  );

export interface VerifiedMembership extends OuterMembership {
  readonly descriptor: MembershipDescriptorValue;
  readonly hash: MembershipHash;
}

export const verifyMembershipDescriptor = (
  descriptor: MembershipDescriptorValue,
  registrySignerPublicKey: Ed25519PublicKey,
): Effect.Effect<VerifiedMembership, ClientRepresentationError> =>
  Effect.gen(function* () {
    const verified = yield* Effect.forEach(
      descriptor.members,
      (representation) =>
        Schema.decodeUnknown(AgentCard)(representation, exactOptions).pipe(
          Effect.flatMap((agentCard) =>
            AgentCard.verify({ agentCard, registrySignerPublicKey }),
          ),
          Effect.mapError(representationFailure),
        ),
      { concurrency: "inherit" },
    );
    const agentIds = verified.map((card) => card.agentId);
    const agentNames = new Set(verified.map((card) => card.agentName));
    const first = verified[0];
    const second = verified[1];
    if (
      first === undefined ||
      second === undefined ||
      !sortedDistinct(agentIds) ||
      agentNames.size !== verified.length
    ) {
      return yield* representationFailure();
    }
    const memberAgentIds: readonly [AgentId, AgentId, ...AgentId[]] = [
      first.agentId,
      second.agentId,
      ...verified.slice(2).map((card) => card.agentId),
    ];
    const conversationId = yield* deriveConversationId(memberAgentIds);
    if (conversationId !== descriptor.conversationId) {
      return yield* representationFailure();
    }
    const members: OuterMembership["members"] = [
      first,
      second,
      ...verified.slice(2),
    ];
    return {
      descriptor,
      hash: yield* hashMembershipDescriptor(descriptor),
      members,
    };
  }).pipe(Effect.withSpan("verifyMembershipDescriptor"));

export const memberCard = (
  membership: VerifiedMembership,
  agentId: AgentId,
): VerifiedAgentCard | undefined =>
  membership.members.find((card) => card.agentId === agentId);

export const verifyOuterMessage = (input: {
  readonly message: SignedMessageValue;
  readonly membership: VerifiedMembership;
}): Effect.Effect<VerifiedSignedMessage, ClientRepresentationError> =>
  Effect.gen(function* () {
    const card = memberCard(input.membership, input.message.senderAgentId);
    const expected = input.membership.members.map((member) => member.agentId);
    if (
      card === undefined ||
      input.message.recipientAgentIds.length !== expected.length ||
      input.message.recipientAgentIds.some(
        (recipient, index) => recipient !== expected[index],
      )
    ) {
      return yield* representationFailure();
    }
    return yield* SignedMessage.verify({
      signedMessage: input.message,
      agentCard: card,
    }).pipe(Effect.mapError(representationFailure));
  }).pipe(Effect.withSpan("verifyOuterMessage"));

export interface VerifiedEvidence {
  readonly message: VerifiedSignedMessage;
  readonly statement: EvidenceStatementValue;
}

export const verifyStableEvidence = (input: {
  readonly representation: unknown;
  readonly membership: VerifiedMembership;
}): Effect.Effect<VerifiedEvidence, ClientRepresentationError> =>
  Effect.gen(function* () {
    const message = yield* Schema.decodeUnknown(SignedMessage)(
      input.representation,
      exactOptions,
    ).pipe(Effect.mapError(representationFailure));
    const card = memberCard(input.membership, message.senderAgentId);
    if (
      card === undefined ||
      message.recipientAgentIds.length !== 1 ||
      message.recipientAgentIds[0] !== message.senderAgentId
    ) {
      return yield* representationFailure();
    }
    const verifiedMessage = yield* SignedMessage.verify({
      signedMessage: message,
      agentCard: card,
    }).pipe(Effect.mapError(representationFailure));
    const statement = yield* decodeCanonical(EvidenceStatement, message.body);
    const expectedMessageId = yield* deriveEvidenceMessageId(statement);
    if (
      statement.signerAgentId !== message.senderAgentId ||
      expectedMessageId !== message.messageId
    ) {
      return yield* representationFailure();
    }
    return { message: verifiedMessage, statement };
  }).pipe(Effect.withSpan("verifyStableEvidence"));

type EvidenceKind = EvidenceStatementValue["kind"];

const verifyEvidenceSet = (input: {
  readonly representations: readonly unknown[];
  readonly expectedKind: EvidenceKind;
  readonly membership: VerifiedMembership;
  readonly exactCount?: number;
  readonly minimumCount?: number;
  readonly statementMatches: (
    statement: EvidenceStatementValue,
  ) => Effect.Effect<boolean, ClientRepresentationError>;
}): Effect.Effect<readonly VerifiedEvidence[], ClientRepresentationError> =>
  Effect.gen(function* () {
    const length = input.representations.length;
    if (length > input.membership.members.length) {
      return yield* representationFailure();
    }
    if (input.exactCount !== undefined && length !== input.exactCount) {
      return yield* representationFailure();
    }
    if (input.minimumCount !== undefined && length < input.minimumCount) {
      return yield* representationFailure();
    }
    const verified = yield* Effect.forEach(
      input.representations,
      (representation) =>
        verifyStableEvidence({ representation, membership: input.membership }),
      { concurrency: "inherit" },
    );
    const signers = verified.map(({ statement }) => statement.signerAgentId);
    if (!sortedDistinct(signers)) {
      return yield* representationFailure();
    }
    const matches = yield* Effect.forEach(
      verified,
      ({ statement }) =>
        statement.kind === input.expectedKind
          ? input.statementMatches(statement)
          : Effect.succeed(false),
      { concurrency: "inherit" },
    );
    if (matches.some((matchesStatement) => !matchesStatement)) {
      return yield* representationFailure();
    }
    return verified;
  });

export const quorumThreshold = (memberCount: number): number =>
  memberCount < 4
    ? memberCount
    : memberCount - Math.floor((memberCount - 1) / 3);

export interface VerifiedActionCore {
  readonly actionHash: ActionHash;
  readonly anchorHash: AnchorHash;
}

const actionReferencesMembership = (input: {
  readonly action: ActionCore;
  readonly membership: VerifiedMembership;
}): boolean => {
  const intent = input.action.postIntent;
  if (
    input.action.conversationId !==
      input.membership.descriptor.conversationId ||
    intent.conversationId !== input.membership.descriptor.conversationId
  ) {
    return false;
  }
  if (
    intent.membershipHash !== input.membership.hash ||
    memberCard(input.membership, intent.authorAgentId) === undefined
  ) {
    return false;
  }
  return true;
};

export const verifyActionCore = (input: {
  readonly action: ActionCore;
  readonly membership: VerifiedMembership;
}): Effect.Effect<VerifiedActionCore, ClientRepresentationError> =>
  Effect.gen(function* () {
    const action = input.action;
    const intent = action.postIntent;
    if (!actionReferencesMembership(input)) {
      return yield* representationFailure();
    }
    if ((yield* hashPostIntent(intent)) !== action.postIntentHash) {
      return yield* representationFailure();
    }
    if (action.kind === "GENESIS") {
      if (
        !(yield* equalCanonical(
          MembershipDescriptor,
          action.membership,
          input.membership.descriptor,
        )) ||
        action.anchor.conversationId !== action.conversationId ||
        action.anchor.membershipHash !== input.membership.hash
      ) {
        return yield* representationFailure();
      }
      return {
        actionHash: yield* hashAction(action),
        anchorHash: yield* hashAnchor(action.anchor),
      };
    }
    if (action.membershipHash !== input.membership.hash) {
      return yield* representationFailure();
    }
    return {
      actionHash: yield* hashAction(action),
      anchorHash: action.anchorHash,
    };
  }).pipe(Effect.withSpan("verifyActionCore"));

export const verifyActionProposal = (input: {
  readonly proposal: ActionProposal;
  readonly membership: VerifiedMembership;
  readonly outerSenderAgentId: AgentId;
}): Effect.Effect<VerifiedActionCore, ClientRepresentationError> =>
  Effect.gen(function* () {
    const verifiedAction = yield* verifyActionCore({
      action: input.proposal.action,
      membership: input.membership,
    });
    const authorAgentId = input.proposal.action.postIntent.authorAgentId;
    if (input.outerSenderAgentId !== authorAgentId) {
      return yield* representationFailure();
    }
    return verifiedAction;
  }).pipe(Effect.withSpan("verifyActionProposal"));

export const verifyActionCertificate = (input: {
  readonly certificate: ActionCertifiedRecord["actionCertificate"];
  readonly action: ActionCore;
  readonly membership: VerifiedMembership;
}): Effect.Effect<ActionHash, ClientRepresentationError> =>
  Effect.gen(function* () {
    const verifiedAction = yield* verifyActionCore({
      action: input.action,
      membership: input.membership,
    });
    if (input.certificate.actionHash !== verifiedAction.actionHash) {
      return yield* representationFailure();
    }
    const requiredCount =
      input.action.kind === "GENESIS"
        ? input.membership.members.length
        : quorumThreshold(input.membership.members.length);
    const evidence = yield* verifyEvidenceSet({
      representations: input.certificate.signatures,
      expectedKind: "action_signature",
      membership: input.membership,
      ...(input.action.kind === "GENESIS"
        ? { exactCount: requiredCount }
        : { minimumCount: requiredCount }),
      statementMatches: (statement) =>
        Effect.succeed(
          statement.kind === "action_signature" &&
            statement.actionHash === verifiedAction.actionHash,
        ),
    });
    const authorAgentId = input.action.postIntent.authorAgentId;
    if (
      !evidence.some(
        ({ statement }) => statement.signerAgentId === authorAgentId,
      )
    ) {
      return yield* representationFailure();
    }
    return verifiedAction.actionHash;
  }).pipe(Effect.withSpan("verifyActionCertificate"));

export const verifyCompletedReanchor = (input: {
  readonly completed: CompletedReanchor;
  readonly membership: VerifiedMembership;
}): Effect.Effect<AnchorHash, ClientRepresentationError> =>
  Effect.gen(function* () {
    const expectedAnchorHash = yield* hashAnchor(input.completed.reanchor);
    if (
      expectedAnchorHash !== input.completed.anchorHash ||
      input.completed.certificate.anchorHash !== expectedAnchorHash ||
      input.completed.reanchor.membershipHash !== input.membership.hash ||
      input.completed.reanchor.conversationId !==
        input.membership.descriptor.conversationId
    ) {
      return yield* representationFailure();
    }
    yield* verifyEvidenceSet({
      representations: input.completed.certificate.votes,
      expectedKind: "reanchor_vote",
      membership: input.membership,
      minimumCount: quorumThreshold(input.membership.members.length),
      statementMatches: (statement) =>
        statement.kind === "reanchor_vote"
          ? equalCanonical(
              ReanchorBody,
              statement.reanchor,
              input.completed.reanchor,
            ).pipe(
              Effect.map(
                (sameReanchor) =>
                  sameReanchor && statement.anchorHash === expectedAnchorHash,
              ),
            )
          : Effect.succeed(false),
    });
    return expectedAnchorHash;
  }).pipe(Effect.withSpan("verifyCompletedReanchor"));

export interface VerifiedRecordCore {
  readonly membership: VerifiedMembership;
  readonly recordHash: RecordHash;
}

export const verifyRecordCore = (input: {
  readonly recordCore: RecordCore;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedRecordCore, ClientRepresentationError> =>
  Effect.gen(function* () {
    const membership = yield* verifyMembershipDescriptor(
      input.recordCore.membership,
      input.registrySignerPublicKey,
    );
    const verifiedAction = yield* verifyActionCore({
      action: input.recordCore.action,
      membership,
    });
    if (
      input.recordCore.actionHash !== verifiedAction.actionHash ||
      input.recordCore.anchorHash !== verifiedAction.anchorHash
    ) {
      return yield* representationFailure();
    }
    return {
      membership,
      recordHash: yield* hashRecord(input.recordCore),
    };
  }).pipe(Effect.withSpan("verifyRecordCore"));

export interface VerifiedActionCertifiedRecord {
  readonly membership: VerifiedMembership;
  readonly recordHash: RecordHash;
}

const verifyRecordRouterAnchor = (input: {
  readonly record: ActionCertifiedRecord;
  readonly membership: VerifiedMembership;
}): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    const routerAnchor = input.record.routerAnchor;
    const anchorHash =
      routerAnchor.kind === "genesis_anchor_body"
        ? yield* hashAnchor(routerAnchor)
        : yield* verifyCompletedReanchor({
            completed: routerAnchor,
            membership: input.membership,
          });
    if (anchorHash !== input.record.recordCore.anchorHash) {
      return yield* representationFailure();
    }
    if (routerAnchor.kind !== "genesis_anchor_body") {
      return;
    }
    if (
      routerAnchor.conversationId !==
        input.membership.descriptor.conversationId ||
      routerAnchor.membershipHash !== input.membership.hash
    ) {
      return yield* representationFailure();
    }
  });

const verifyGenesisRouterAnchor = (input: {
  readonly record: ActionCertifiedRecord;
}): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    const action = input.record.recordCore.action;
    if (action.kind !== "GENESIS") {
      return;
    }
    const routerAnchor = input.record.routerAnchor;
    if (routerAnchor.kind !== "genesis_anchor_body") {
      return yield* representationFailure();
    }
    if (
      !(yield* equalCanonical(GenesisAnchorBody, routerAnchor, action.anchor))
    ) {
      return yield* representationFailure();
    }
  });

export const verifyActionCertifiedRecord = (input: {
  readonly record: ActionCertifiedRecord;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedActionCertifiedRecord, ClientRepresentationError> =>
  Effect.gen(function* () {
    const verified = yield* verifyRecordCore({
      recordCore: input.record.recordCore,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
    if (input.record.recordHash !== verified.recordHash) {
      return yield* representationFailure();
    }
    yield* verifyActionCertificate({
      certificate: input.record.actionCertificate,
      action: input.record.recordCore.action,
      membership: verified.membership,
    });
    yield* verifyRecordRouterAnchor({
      record: input.record,
      membership: verified.membership,
    });
    yield* verifyGenesisRouterAnchor({ record: input.record });
    return verified;
  }).pipe(Effect.withSpan("verifyActionCertifiedRecord"));

export const verifyCertifiedRecord = (input: {
  readonly record: CertifiedRecord;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedMembership, ClientRepresentationError> =>
  Effect.gen(function* () {
    const verified = yield* verifyActionCertifiedRecord({
      record: input.record.actionCertifiedRecord,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
    const certificate = input.record.durabilityCertificate;
    if (certificate.recordHash !== verified.recordHash) {
      return yield* representationFailure();
    }
    yield* verifyEvidenceSet({
      representations: certificate.votes,
      expectedKind: "durability_vote",
      membership: verified.membership,
      minimumCount: quorumThreshold(verified.membership.members.length),
      statementMatches: (statement) =>
        Effect.succeed(
          statement.kind === "durability_vote" &&
            statement.conversationId ===
              verified.membership.descriptor.conversationId &&
            statement.membershipHash === verified.membership.hash &&
            statement.recordHash === verified.recordHash,
        ),
    });
    return verified.membership;
  }).pipe(Effect.withSpan("verifyCertifiedRecord"));

const verifyCatchUpRequest = (input: {
  readonly request: CatchUpRequestValue;
  readonly membership: VerifiedMembership;
}): Effect.Effect<void, ClientRepresentationError> =>
  input.request.conversationId === input.membership.descriptor.conversationId &&
  input.request.membershipHash === input.membership.hash &&
  memberCard(input.membership, input.request.requesterAgentId) !== undefined
    ? Effect.void
    : Effect.fail(representationFailure());

const catchUpAttestationMatches = (input: {
  readonly statement: CatchUpAttestationStatement;
  readonly request: CatchUpRequestValue;
  readonly itemKind: CatchUpAttestationStatement["itemKind"];
  readonly itemHash: RecordHash | AnchorHash | null;
  readonly hasMore: boolean;
}): Effect.Effect<boolean, ClientRepresentationError> =>
  equalCanonical(CatchUpRequest, input.statement.request, input.request).pipe(
    Effect.map(
      (sameRequest) =>
        sameRequest &&
        input.statement.itemKind === input.itemKind &&
        input.statement.itemHash === input.itemHash &&
        input.statement.hasMore === input.hasMore,
    ),
  );

const verifyCatchUpAttestation = (input: {
  readonly representation: unknown;
  readonly membership: VerifiedMembership;
  readonly responseSenderAgentId: AgentId;
  readonly request: CatchUpRequestValue;
  readonly itemKind: CatchUpAttestationStatement["itemKind"];
  readonly itemHash: RecordHash | AnchorHash | null;
  readonly hasMore: boolean;
}): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    const evidence = yield* verifyStableEvidence(input);
    if (
      evidence.statement.kind !== "catch_up_attestation" ||
      evidence.statement.signerAgentId !== input.responseSenderAgentId ||
      !(yield* catchUpAttestationMatches({
        statement: evidence.statement,
        request: input.request,
        itemKind: input.itemKind,
        itemHash: input.itemHash,
        hasMore: input.hasMore,
      }))
    ) {
      return yield* representationFailure();
    }
  });

interface VerifiedCatchUpItem {
  readonly itemKind: CatchUpAttestationStatement["itemKind"];
  readonly itemHash: RecordHash | AnchorHash;
}

const certifiedItemExtendsPosition = (input: {
  readonly request: CatchUpRequestValue;
  readonly record: CertifiedRecord;
}): boolean => {
  const action = input.record.actionCertifiedRecord.recordCore.action;
  if (input.request.knownRecordHash === null) {
    return (
      action.kind === "GENESIS" &&
      input.record.actionCertifiedRecord.routerAnchor.kind ===
        "genesis_anchor_body"
    );
  }
  return (
    action.kind === "POST" &&
    action.previousRecordHash === input.request.knownRecordHash &&
    action.anchorHash === input.request.knownAnchorHash
  );
};

const verifyCertifiedCatchUpItem = (input: {
  readonly page: CatchUpPage;
  readonly item: CertifiedRecord;
  readonly membership: VerifiedMembership;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedCatchUpItem, ClientRepresentationError> =>
  Effect.gen(function* () {
    const itemMembership = yield* verifyCertifiedRecord({
      record: input.item,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
    if (
      itemMembership.hash !== input.membership.hash ||
      !certifiedItemExtendsPosition({
        request: input.page.request,
        record: input.item,
      })
    ) {
      return yield* representationFailure();
    }
    return {
      itemKind: "certified_record",
      itemHash: input.item.actionCertifiedRecord.recordHash,
    };
  });

const verifyReanchorCatchUpItem = (input: {
  readonly page: CatchUpPage;
  readonly item: CompletedReanchor;
  readonly membership: VerifiedMembership;
}): Effect.Effect<VerifiedCatchUpItem, ClientRepresentationError> =>
  Effect.gen(function* () {
    if (
      input.page.request.knownRecordHash === null ||
      input.item.reanchor.selectedRecordHash !==
        input.page.request.knownRecordHash ||
      input.item.reanchor.previousAnchorHash !==
        input.page.request.knownAnchorHash
    ) {
      return yield* representationFailure();
    }
    yield* verifyCompletedReanchor({
      completed: input.item,
      membership: input.membership,
    });
    return {
      itemKind: "completed_reanchor",
      itemHash: input.item.anchorHash,
    };
  });

const verifyCatchUpItem = (input: {
  readonly page: CatchUpPage;
  readonly membership: VerifiedMembership;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedCatchUpItem, ClientRepresentationError> => {
  const item = input.page.item;
  return item.kind === "certified_record"
    ? verifyCertifiedCatchUpItem({ ...input, item })
    : verifyReanchorCatchUpItem({
        page: input.page,
        item,
        membership: input.membership,
      });
};

export const verifyCatchUpPage = (input: {
  readonly page: CatchUpPage;
  readonly membership: VerifiedMembership;
  readonly responseSenderAgentId: AgentId;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    yield* verifyCatchUpRequest({
      request: input.page.request,
      membership: input.membership,
    });
    const verifiedItem = yield* verifyCatchUpItem(input);
    yield* verifyCatchUpAttestation({
      representation: input.page.attestation,
      membership: input.membership,
      responseSenderAgentId: input.responseSenderAgentId,
      request: input.page.request,
      itemKind: verifiedItem.itemKind,
      itemHash: verifiedItem.itemHash,
      hasMore: input.page.hasMore,
    });
  }).pipe(Effect.withSpan("verifyCatchUpPage"));

export const verifyCatchUpIncomplete = (input: {
  readonly incomplete: CatchUpIncomplete;
  readonly membership: VerifiedMembership;
  readonly responseSenderAgentId: AgentId;
}): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    yield* verifyCatchUpRequest({
      request: input.incomplete.request,
      membership: input.membership,
    });
    yield* verifyCatchUpAttestation({
      representation: input.incomplete.attestation,
      membership: input.membership,
      responseSenderAgentId: input.responseSenderAgentId,
      request: input.incomplete.request,
      itemKind: "incomplete",
      itemHash: null,
      hasMore: false,
    });
  }).pipe(Effect.withSpan("verifyCatchUpIncomplete"));

/* eslint-enable jsdoc/require-jsdoc -- Restore package documentation rules. */
