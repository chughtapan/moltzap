/** @file Client protocol hashes, deterministic evidence, and Router envelopes. */

import {
  type AgentId,
  type AgentSigningAuthority,
  MessageId,
  type MessageId as MessageIdValue,
  MOLTZAP_VERSION,
  SignedMessage,
  type SignedMessage as SignedMessageValue,
  type VerifiedAgentCard,
  type VerifiedSignedMessage,
} from "@moltzap/identity";
import { Effect, Either, Encoding, Schema } from "effect";
import { createHash, randomBytes } from "node:crypto";
import { PostId, type PostId as PostIdValue } from "../contract.js";
import {
  type ClientRepresentationError,
  decodeCanonical,
  encodeCanonical,
  representationFailure,
} from "./representation-canonical.js";
import {
  ActionCore,
  ActionHash,
  type ActionHash as ActionHashValue,
  AnchorBody,
  AnchorHash,
  type AnchorHash as AnchorHashValue,
  ConversationId,
  ConversationIdentityInput,
  type ConversationId as ConversationIdValue,
  DirectPacket,
  type DirectPacket as DirectPacketValue,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  type GenesisAnchorBody,
  MembershipDescriptor,
  type MembershipDescriptor as MembershipDescriptorValue,
  MembershipHash,
  type MembershipHash as MembershipHashValue,
  PostIntent,
  PostIntentHash,
  type PostIntentHash as PostIntentHashValue,
  type ReanchorBody,
  RecordCore,
  RecordHash,
  type RecordHash as RecordHashValue,
} from "./representation-schemas.js";

/* eslint-disable jsdoc/require-jsdoc -- The package-private representation facade documents this closed protocol vocabulary. */

const HASH_BYTE_LENGTH = 32;
const AGENT_ID_BYTE_LENGTH = 16;
const MESSAGE_ID_BYTE_LENGTH = 16;
const CLIENT_DOMAIN = "moltzap/client/v2/";
const EVIDENCE_MESSAGE_ID_DOMAIN = `${CLIENT_DOMAIN}evidence-message-id\0`;
const utf8Encoder = new TextEncoder();

const decodeCanonicalBase64Url = (value: string): Uint8Array | undefined =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => undefined,
    onRight: (bytes) =>
      Encoding.encodeBase64Url(bytes) === value ? bytes : undefined,
  });

const domainHash = <A, I, R>(input: {
  readonly artifact: string;
  readonly prefix: string;
  readonly schema: Schema.Schema<A, I, R>;
  readonly value: A;
}): Effect.Effect<string, ClientRepresentationError, R> =>
  encodeCanonical(input.schema, input.value).pipe(
    Effect.map((bytes) =>
      createHash("sha256")
        .update(utf8Encoder.encode(`${CLIENT_DOMAIN}${input.artifact}\0`))
        .update(bytes)
        .digest(),
    ),
    Effect.flatMap((digest) =>
      digest.byteLength === HASH_BYTE_LENGTH
        ? Effect.succeed(`${input.prefix}${Encoding.encodeBase64Url(digest)}`)
        : Effect.fail(representationFailure()),
    ),
  );

export const compareAgentIds = (left: AgentId, right: AgentId): number => {
  const leftBytes = decodeCanonicalBase64Url(left.slice(4));
  const rightBytes = decodeCanonicalBase64Url(right.slice(4));
  if (leftBytes === undefined || rightBytes === undefined) {
    return 0;
  }
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.byteLength - rightBytes.byteLength;
};

const sortedDistinctAgentIds = (agentIds: readonly AgentId[]): boolean => {
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

const decodeAgentIdBytes = (
  agentId: AgentId,
): Effect.Effect<Uint8Array, ClientRepresentationError> => {
  const bytes = decodeCanonicalBase64Url(agentId.slice(4));
  return bytes?.byteLength === AGENT_ID_BYTE_LENGTH
    ? Effect.succeed(bytes)
    : Effect.fail(representationFailure());
};

export const deriveConversationId = (
  memberAgentIds: ConversationIdentityInput["memberAgentIds"],
): Effect.Effect<ConversationIdValue, ClientRepresentationError> => {
  if (!sortedDistinctAgentIds(memberAgentIds)) {
    return Effect.fail(representationFailure());
  }
  const input: ConversationIdentityInput = {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "conversation_identity",
    memberAgentIds,
  };
  return domainHash({
    artifact: "conversation",
    prefix: "cnv_",
    schema: ConversationIdentityInput,
    value: input,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(ConversationId)),
    Effect.mapError(representationFailure),
  );
};

export const hashMembershipDescriptor = (
  membership: MembershipDescriptorValue,
): Effect.Effect<MembershipHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "membership",
    prefix: "mbr_",
    schema: MembershipDescriptor,
    value: membership,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(MembershipHash)),
    Effect.mapError(representationFailure),
  );

export const mintPostId = (): Effect.Effect<
  PostIdValue,
  ClientRepresentationError
> =>
  Effect.try({
    try: () => `pst_${randomBytes(HASH_BYTE_LENGTH).toString("base64url")}`,
    catch: representationFailure,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(PostId)),
    Effect.mapError(representationFailure),
  );

export const hashPostIntent = (
  intent: PostIntent,
): Effect.Effect<PostIntentHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "post-intent",
    prefix: "pit_",
    schema: PostIntent,
    value: intent,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(PostIntentHash)),
    Effect.mapError(representationFailure),
  );

export const hashAnchor = (
  anchor: GenesisAnchorBody | ReanchorBody,
): Effect.Effect<AnchorHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "anchor",
    prefix: "anc_",
    schema: AnchorBody,
    value: anchor,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(AnchorHash)),
    Effect.mapError(representationFailure),
  );

export const hashAction = (
  action: ActionCore,
): Effect.Effect<ActionHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "action",
    prefix: "ach_",
    schema: ActionCore,
    value: action,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(ActionHash)),
    Effect.mapError(representationFailure),
  );

export const hashRecord = (
  record: RecordCore,
): Effect.Effect<RecordHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "record",
    prefix: "rch_",
    schema: RecordCore,
    value: record,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(RecordHash)),
    Effect.mapError(representationFailure),
  );

export const deriveEvidenceMessageId = (
  statement: EvidenceStatementValue,
): Effect.Effect<MessageIdValue, ClientRepresentationError> =>
  Effect.gen(function* () {
    const signerBytes = yield* decodeAgentIdBytes(statement.signerAgentId);
    const statementBytes = yield* encodeCanonical(EvidenceStatement, statement);
    const digest = createHash("sha256")
      .update(utf8Encoder.encode(EVIDENCE_MESSAGE_ID_DOMAIN))
      .update(signerBytes)
      .update(statementBytes)
      .digest()
      .subarray(0, MESSAGE_ID_BYTE_LENGTH);
    return yield* Schema.decodeUnknown(MessageId)(
      `msg_${Encoding.encodeBase64Url(digest)}`,
    ).pipe(Effect.mapError(representationFailure));
  }).pipe(Effect.withSpan("deriveEvidenceMessageId"));

export const decodeDirectPacket = (
  bytes: Uint8Array,
): Effect.Effect<DirectPacketValue, ClientRepresentationError> =>
  decodeCanonical(DirectPacket, bytes);

export const decodeEvidenceMessage = (
  bytes: Uint8Array,
): Effect.Effect<SignedMessageValue, ClientRepresentationError> =>
  decodeCanonical(SignedMessage, bytes);

export type DecodedOuterBody =
  | Readonly<{ kind: "direct"; packet: DirectPacketValue }>
  | Readonly<{ kind: "evidence"; message: SignedMessageValue }>;

export const decodeOuterBody = (
  bytes: Uint8Array,
): Effect.Effect<DecodedOuterBody, ClientRepresentationError> =>
  decodeDirectPacket(bytes).pipe(
    Effect.map((packet): DecodedOuterBody => ({ kind: "direct", packet })),
    Effect.catchTag("ClientRepresentationError", () =>
      decodeEvidenceMessage(bytes).pipe(
        Effect.map(
          (message): DecodedOuterBody => ({ kind: "evidence", message }),
        ),
      ),
    ),
  );

export const signEvidenceMessage = (input: {
  readonly statement: EvidenceStatementValue;
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
}): Effect.Effect<VerifiedSignedMessage, ClientRepresentationError> =>
  Effect.gen(function* () {
    if (input.statement.signerAgentId !== input.agentCard.agentId) {
      return yield* representationFailure();
    }
    const messageId = yield* deriveEvidenceMessageId(input.statement);
    const body = yield* encodeCanonical(EvidenceStatement, input.statement);
    return yield* SignedMessage.sign({
      agentCard: input.agentCard,
      signingAuthority: input.signingAuthority,
      recipientAgentIds: new Set([input.agentCard.agentId]),
      messageId,
      body,
    }).pipe(Effect.mapError(representationFailure));
  }).pipe(Effect.withSpan("signEvidenceMessage"));

export interface OuterMembership {
  readonly members: readonly [
    VerifiedAgentCard,
    VerifiedAgentCard,
    ...VerifiedAgentCard[],
  ];
}

const signOuterBody = (input: {
  readonly body: Uint8Array;
  readonly membership: OuterMembership;
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
}): Effect.Effect<VerifiedSignedMessage, ClientRepresentationError> =>
  Effect.gen(function* () {
    const memberAgentIds = input.membership.members.map(
      (member) => member.agentId,
    );
    if (
      !sortedDistinctAgentIds(memberAgentIds) ||
      !memberAgentIds.includes(input.agentCard.agentId)
    ) {
      return yield* representationFailure();
    }
    const randomId = yield* Effect.try({
      try: () => randomBytes(MESSAGE_ID_BYTE_LENGTH),
      catch: representationFailure,
    });
    const messageId = yield* Schema.decodeUnknown(MessageId)(
      `msg_${Encoding.encodeBase64Url(randomId)}`,
    ).pipe(Effect.mapError(representationFailure));
    return yield* SignedMessage.sign({
      agentCard: input.agentCard,
      signingAuthority: input.signingAuthority,
      recipientAgentIds: new Set(memberAgentIds),
      messageId,
      body: input.body,
    }).pipe(Effect.mapError(representationFailure));
  }).pipe(Effect.withSpan("signOuterBody"));

export const signOuterPacket = (input: {
  readonly packet: DirectPacketValue;
  readonly membership: OuterMembership;
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
}): Effect.Effect<VerifiedSignedMessage, ClientRepresentationError> =>
  encodeCanonical(DirectPacket, input.packet).pipe(
    Effect.flatMap((body) => signOuterBody({ ...input, body })),
  );

export const signOuterEvidence = (input: {
  readonly evidence: SignedMessageValue;
  readonly membership: OuterMembership;
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
}): Effect.Effect<VerifiedSignedMessage, ClientRepresentationError> =>
  encodeCanonical(SignedMessage, input.evidence).pipe(
    Effect.flatMap((body) => signOuterBody({ ...input, body })),
  );

export const encodeActionCore = (
  action: ActionCore,
): Effect.Effect<Uint8Array, ClientRepresentationError> =>
  encodeCanonical(ActionCore, action);

/* eslint-enable jsdoc/require-jsdoc -- Restore package documentation rules. */
