/** @file Client protocol hashing, deterministic evidence, and Router envelopes. */

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
import type { Content as SemanticContent } from "../contract.js";
import {
  type ClientRepresentationError,
  decodeCanonical,
  encodeCanonical,
  representationFailure,
} from "./representation-canonical.js";
import {
  Action,
  type ActionBinding as ActionBindingValue,
  ActionCertificate,
  type ActionCertificate as ActionCertificateValue,
  ActionCertifiedRecord,
  type ActionCertifiedRecord as ActionCertifiedRecordValue,
  ActionHash,
  type ActionHash as ActionHashValue,
  type Action as ActionValue,
  AnchorHash,
  type AnchorHash as AnchorHashValue,
  BeginDigest,
  type BeginDigest as BeginDigestValue,
  Content,
  ContentHash,
  type ContentHash as ContentHashValue,
  DirectPacket,
  type DirectPacket as DirectPacketValue,
  EvidenceStatement,
  type EvidenceStatement as EvidenceStatementValue,
  GenesisAnchor,
  type GenesisAnchor as GenesisAnchorValue,
  Membership,
  MembershipHash,
  type MembershipHash as MembershipHashValue,
  ReanchorBody,
  type ReanchorBody as ReanchorBodyValue,
  RecordHash,
  type RecordHash as RecordHashValue,
  ReplyFingerprint,
  type ReplyFingerprint as ReplyFingerprintValue,
  ReplyInput,
} from "./representation-schemas.js";

/* eslint-disable jsdoc/require-jsdoc -- The package-private representation facade documents this closed protocol vocabulary. */

const HASH_BYTE_LENGTH = 32;
const MESSAGE_ID_BYTE_LENGTH = 16;
const CLIENT_DOMAIN = "moltzap/client/v1/";
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

export const hashMembership = (
  membership: Membership,
): Effect.Effect<MembershipHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "membership",
    prefix: "mbr_",
    schema: Membership,
    value: membership,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(MembershipHash)),
    Effect.mapError(representationFailure),
  );

export const hashAnchor = (
  anchor: GenesisAnchorValue | ReanchorBodyValue,
): Effect.Effect<AnchorHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "anchor",
    prefix: "anc_",
    schema: Schema.Union(GenesisAnchor, ReanchorBody),
    value: anchor,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(AnchorHash)),
    Effect.mapError(representationFailure),
  );

export const hashActionCertificate = (
  certificate: ActionCertificateValue,
): Effect.Effect<ActionHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "action",
    prefix: "ach_",
    schema: ActionCertificate,
    value: certificate,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(ActionHash)),
    Effect.mapError(representationFailure),
  );

export const hashActionCertifiedRecord = (
  record: ActionCertifiedRecordValue,
): Effect.Effect<RecordHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "record",
    prefix: "rch_",
    schema: ActionCertifiedRecord,
    value: record,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(RecordHash)),
    Effect.mapError(representationFailure),
  );

export const hashBeginMessage = (
  beginMessage: SignedMessageValue,
): Effect.Effect<BeginDigestValue, ClientRepresentationError> =>
  domainHash({
    artifact: "begin",
    prefix: "bgn_",
    schema: SignedMessage,
    value: beginMessage,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(BeginDigest)),
    Effect.mapError(representationFailure),
  );

export const hashContent = (
  content: SemanticContent,
): Effect.Effect<ContentHashValue, ClientRepresentationError> =>
  domainHash({
    artifact: "content",
    prefix: "cnt_",
    schema: Content,
    value: content,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(ContentHash)),
    Effect.mapError(representationFailure),
  );

export const fingerprintReply = (
  content: SemanticContent,
): Effect.Effect<ReplyFingerprintValue, ClientRepresentationError> => {
  const replyInput: typeof ReplyInput.Type = {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "reply_input",
    content,
  };
  return domainHash({
    artifact: "reply",
    prefix: "rpf_",
    schema: ReplyInput,
    value: replyInput,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknown(ReplyFingerprint)),
    Effect.mapError(representationFailure),
  );
};

export const compareAgentIds = (left: AgentId, right: AgentId): number => {
  const leftBytes = decodeCanonicalBase64Url(left.slice(4));
  const rightBytes = decodeCanonicalBase64Url(right.slice(4));
  if (leftBytes === undefined || rightBytes === undefined) {
    return 0;
  }
  for (let index = 0; index < MESSAGE_ID_BYTE_LENGTH; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const decodeAgentIdBytes = (
  agentId: AgentId,
): Effect.Effect<Uint8Array, ClientRepresentationError> => {
  const bytes = decodeCanonicalBase64Url(agentId.slice(4));
  return bytes?.byteLength === MESSAGE_ID_BYTE_LENGTH
    ? Effect.succeed(bytes)
    : Effect.fail(representationFailure());
};

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

export const makeActionBinding = (
  action: ActionValue,
): Effect.Effect<ActionBindingValue, ClientRepresentationError> =>
  Effect.gen(function* () {
    const contentHash = yield* hashContent(action.content);
    const binding: ActionBindingValue = {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_binding",
      actionKind: action.actionId,
      conversationId: action.conversationId,
      membershipHash: action.membershipHash,
      anchorHash: action.anchorHash,
      previousRecordHash: action.previousRecordHash,
      beginDigest: action.beginDigest,
      actionId: action.actionId,
      authorAgentId: action.authorAgentId,
      contentHash,
      replyFingerprint: action.replyFingerprint,
    };
    return binding;
  }).pipe(Effect.withSpan("makeActionBinding"));

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

export const signOuterBody = (input: {
  readonly body: Uint8Array;
  readonly membership: OuterMembership;
  readonly agentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
}): Effect.Effect<VerifiedSignedMessage, ClientRepresentationError> =>
  Effect.gen(function* () {
    if (
      !input.membership.members.some(
        (member) => member.agentId === input.agentCard.agentId,
      )
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
      recipientAgentIds: new Set(
        input.membership.members.map((member) => member.agentId),
      ),
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

export const encodeAction = (
  action: ActionValue,
): Effect.Effect<Uint8Array, ClientRepresentationError> =>
  encodeCanonical(Action, action);

/* eslint-enable jsdoc/require-jsdoc -- Restore package documentation rules. */
