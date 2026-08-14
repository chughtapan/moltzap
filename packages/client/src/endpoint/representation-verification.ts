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
  deriveEvidenceMessageId,
  hashActionCertificate,
  hashActionCertifiedRecord,
  hashAnchor,
  hashMembership,
  makeActionBinding,
  type OuterMembership,
} from "./representation-codec.js";
import {
  ActionBinding,
  type ActionCertificate,
  type ActionCertifiedRecord,
  type AnchorHash,
  type CatchUpAttestation as CatchUpAttestationValue,
  type CatchUpIncomplete,
  type CatchUpPage,
  CatchUpRequest,
  type CatchUpRequest as CatchUpRequestValue,
  type CertifiedRecord,
  type CompletedReanchor,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  type Membership,
  type MembershipHash,
  ReanchorBody,
  type RecordHash,
  type StartProposal,
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
  readonly membership: Membership;
  readonly hash: MembershipHash;
}

export const verifyMembership = (
  membership: Membership,
  registrySignerPublicKey: Ed25519PublicKey,
): Effect.Effect<VerifiedMembership, ClientRepresentationError> =>
  Effect.gen(function* () {
    const verified = yield* Effect.forEach(
      membership.members,
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
    if (!sortedDistinct(agentIds)) {
      return yield* representationFailure();
    }
    const first = verified[0];
    const second = verified[1];
    if (first === undefined || second === undefined) {
      return yield* representationFailure();
    }
    const members: OuterMembership["members"] = [
      first,
      second,
      ...verified.slice(2),
    ];
    return {
      membership,
      hash: yield* hashMembership(membership),
      members,
    };
  }).pipe(Effect.withSpan("verifyMembership"));

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

interface VerifiedEvidence {
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

const evidenceCountMatches = (input: {
  readonly actual: number;
  readonly exact?: number;
  readonly minimum?: number;
}): boolean => {
  const wrongExact = input.exact !== undefined && input.actual !== input.exact;
  const belowMinimum =
    input.minimum !== undefined && input.actual < input.minimum;
  return !wrongExact && !belowMinimum;
};

const verifyEvidenceSet = (input: {
  readonly representations: readonly unknown[];
  readonly expectedKind: EvidenceKind;
  readonly membership: VerifiedMembership;
  readonly exactCount?: number;
  readonly minimumCount?: number;
  readonly statementMatches: (
    statement: EvidenceStatementValue,
  ) => Effect.Effect<boolean, ClientRepresentationError>;
}): Effect.Effect<
  readonly EvidenceStatementValue[],
  ClientRepresentationError
> =>
  Effect.gen(function* () {
    if (
      !evidenceCountMatches({
        actual: input.representations.length,
        exact: input.exactCount,
        minimum: input.minimumCount,
      })
    ) {
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
    return verified.map(({ statement }) => statement);
  });

export const durabilityThreshold = (memberCount: number): number =>
  memberCount < 4
    ? memberCount
    : memberCount - Math.floor((memberCount - 1) / 3);

export const verifyStartProposal = (input: {
  readonly proposal: StartProposal;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedMembership, ClientRepresentationError> =>
  Effect.gen(function* () {
    const membership = yield* verifyMembership(
      input.proposal.membership,
      input.registrySignerPublicKey,
    );
    const anchorHash = yield* hashAnchor(input.proposal.genesisAnchor);
    const action = input.proposal.action;
    const expectedConversationId = input.proposal.membership.conversationId;
    const bindings = [
      [input.proposal.genesisAnchor.conversationId, expectedConversationId],
      [input.proposal.genesisAnchor.membershipHash, membership.hash],
      [action.conversationId, expectedConversationId],
      [action.membershipHash, membership.hash],
      [action.anchorHash, anchorHash],
    ] as const;
    if (
      !bindings.every(([actual, expected]) => actual === expected) ||
      memberCard(membership, action.authorAgentId) === undefined
    ) {
      return yield* representationFailure();
    }
    return membership;
  }).pipe(Effect.withSpan("verifyStartProposal"));

export const verifyActionCertificate = (input: {
  readonly certificate: ActionCertificate;
  readonly action: ActionCertifiedRecord["action"];
  readonly membership: VerifiedMembership;
}): Effect.Effect<
  ActionCertifiedRecord["actionHash"],
  ClientRepresentationError
> =>
  Effect.gen(function* () {
    if (
      memberCard(input.membership, input.action.authorAgentId) === undefined
    ) {
      return yield* representationFailure();
    }
    const expectedBinding = yield* makeActionBinding(input.action);
    if (
      !(yield* equalCanonical(
        ActionBinding,
        input.certificate.action,
        expectedBinding,
      ))
    ) {
      return yield* representationFailure();
    }
    yield* verifyEvidenceSet({
      representations: input.certificate.signatures,
      expectedKind: "action_signature",
      membership: input.membership,
      exactCount: input.membership.members.length,
      statementMatches: (statement) =>
        statement.kind === "action_signature"
          ? equalCanonical(ActionBinding, statement.action, expectedBinding)
          : Effect.succeed(false),
    });
    return yield* hashActionCertificate(input.certificate);
  }).pipe(Effect.withSpan("verifyActionCertificate"));

export interface VerifiedActionCertifiedRecord {
  readonly membership: VerifiedMembership;
  readonly recordHash: RecordHash;
}

export const verifyActionCertifiedRecord = (input: {
  readonly record: ActionCertifiedRecord;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedActionCertifiedRecord, ClientRepresentationError> =>
  Effect.gen(function* () {
    const membership = yield* verifyMembership(
      input.record.membership,
      input.registrySignerPublicKey,
    );
    if (
      input.record.action.membershipHash !== membership.hash ||
      input.record.action.anchorHash !== input.record.anchorHash ||
      input.record.action.conversationId !==
        input.record.membership.conversationId
    ) {
      return yield* representationFailure();
    }
    const actionHash = yield* verifyActionCertificate({
      certificate: input.record.actionCertificate,
      action: input.record.action,
      membership,
    });
    if (actionHash !== input.record.actionHash) {
      return yield* representationFailure();
    }
    return {
      membership,
      recordHash: yield* hashActionCertifiedRecord(input.record),
    };
  }).pipe(Effect.withSpan("verifyActionCertifiedRecord"));

export const verifyCompletedReanchor = (input: {
  readonly completed: CompletedReanchor;
  readonly membership: VerifiedMembership;
}): Effect.Effect<AnchorHash, ClientRepresentationError> =>
  Effect.gen(function* () {
    const expectedAnchorHash = yield* hashAnchor(input.completed.reanchor);
    if (
      expectedAnchorHash !== input.completed.anchorHash ||
      input.completed.reanchor.membershipHash !== input.membership.hash ||
      input.completed.reanchor.conversationId !==
        input.membership.membership.conversationId
    ) {
      return yield* representationFailure();
    }
    yield* verifyEvidenceSet({
      representations: input.completed.votes,
      expectedKind: "reanchor_vote",
      membership: input.membership,
      minimumCount: durabilityThreshold(input.membership.members.length),
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

export const verifyCertifiedRecord = (input: {
  readonly record: CertifiedRecord;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedMembership, ClientRepresentationError> =>
  Effect.gen(function* () {
    const verified = yield* verifyActionCertifiedRecord({
      record: input.record.actionCertifiedRecord,
      registrySignerPublicKey: input.registrySignerPublicKey,
    });
    if (verified.recordHash !== input.record.recordHash) {
      return yield* representationFailure();
    }
    const routerAnchor = input.record.routerAnchor;
    const anchorHash =
      routerAnchor.kind === "genesis_anchor"
        ? yield* hashAnchor(routerAnchor)
        : yield* verifyCompletedReanchor({
            completed: routerAnchor,
            membership: verified.membership,
          });
    if (
      anchorHash !== input.record.actionCertifiedRecord.anchorHash ||
      (routerAnchor.kind === "genesis_anchor" &&
        (routerAnchor.conversationId !==
          verified.membership.membership.conversationId ||
          routerAnchor.membershipHash !== verified.membership.hash))
    ) {
      return yield* representationFailure();
    }
    yield* verifyEvidenceSet({
      representations: input.record.durabilityVotes,
      expectedKind: "durability_vote",
      membership: verified.membership,
      minimumCount: durabilityThreshold(verified.membership.members.length),
      statementMatches: (statement) =>
        Effect.succeed(
          statement.kind === "durability_vote" &&
            statement.conversationId ===
              verified.membership.membership.conversationId &&
            statement.membershipHash === verified.membership.hash &&
            statement.recordHash === input.record.recordHash,
        ),
    });
    return verified.membership;
  }).pipe(Effect.withSpan("verifyCertifiedRecord"));

const verifyCatchUpRequest = (input: {
  readonly request: CatchUpRequestValue;
  readonly membership: VerifiedMembership;
}): Effect.Effect<void, ClientRepresentationError> =>
  input.request.conversationId === input.membership.membership.conversationId &&
  input.request.membershipHash === input.membership.hash &&
  memberCard(input.membership, input.request.requesterAgentId) !== undefined
    ? Effect.void
    : Effect.fail(representationFailure());

const catchUpAttestationMatches = (input: {
  readonly statement: CatchUpAttestationValue;
  readonly request: CatchUpRequestValue;
  readonly itemKind: CatchUpAttestationValue["itemKind"];
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
  readonly request: CatchUpRequestValue;
  readonly itemKind: CatchUpAttestationValue["itemKind"];
  readonly itemHash: RecordHash | AnchorHash | null;
  readonly hasMore: boolean;
}): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    const evidence = yield* verifyStableEvidence(input);
    if (
      evidence.statement.kind !== "catch_up_attestation" ||
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
  readonly itemKind: CatchUpAttestationValue["itemKind"];
  readonly itemHash: RecordHash | AnchorHash;
}

const isGenesisCatchUpRecord = (record: CertifiedRecord): boolean =>
  record.actionCertifiedRecord.action.kind === "start_action" &&
  record.actionCertifiedRecord.action.previousRecordHash === null &&
  record.routerAnchor.kind === "genesis_anchor";

const verifyCatchUpItem = (input: {
  readonly page: CatchUpPage;
  readonly membership: VerifiedMembership;
  readonly registrySignerPublicKey: Ed25519PublicKey;
}): Effect.Effect<VerifiedCatchUpItem, ClientRepresentationError> =>
  Effect.gen(function* () {
    const item = input.page.item;
    if (item.kind === "certified_record") {
      const itemMembership = yield* verifyCertifiedRecord({
        record: item,
        registrySignerPublicKey: input.registrySignerPublicKey,
      });
      const isInvalidGenesisPosition =
        input.page.request.knownRecordHash === null &&
        !isGenesisCatchUpRecord(item);
      if (
        itemMembership.hash !== input.membership.hash ||
        isInvalidGenesisPosition
      ) {
        return yield* representationFailure();
      }
      return { itemKind: "certified_record", itemHash: item.recordHash };
    }
    if (input.page.request.knownRecordHash === null) {
      return yield* representationFailure();
    }
    yield* verifyCompletedReanchor({
      completed: item,
      membership: input.membership,
    });
    return { itemKind: "completed_reanchor", itemHash: item.anchorHash };
  });

export const verifyCatchUpPage = (input: {
  readonly page: CatchUpPage;
  readonly membership: VerifiedMembership;
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
      request: input.page.request,
      itemKind: verifiedItem.itemKind,
      itemHash: verifiedItem.itemHash,
      hasMore: input.page.hasMore,
    });
  }).pipe(Effect.withSpan("verifyCatchUpPage"));

export const verifyCatchUpIncomplete = (input: {
  readonly incomplete: CatchUpIncomplete;
  readonly membership: VerifiedMembership;
}): Effect.Effect<void, ClientRepresentationError> =>
  Effect.gen(function* () {
    yield* verifyCatchUpRequest({
      request: input.incomplete.request,
      membership: input.membership,
    });
    yield* verifyCatchUpAttestation({
      representation: input.incomplete.attestation,
      membership: input.membership,
      request: input.incomplete.request,
      itemKind: "incomplete",
      itemHash: null,
      hasMore: false,
    });
  }).pipe(Effect.withSpan("verifyCatchUpIncomplete"));

/* eslint-enable jsdoc/require-jsdoc -- Restore package documentation rules. */
