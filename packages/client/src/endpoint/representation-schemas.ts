/** @file Exact closed schemas for every Client endpoint protocol value. */

import {
  AgentCard,
  AgentId,
  MOLTZAP_VERSION,
  SignedMessage,
} from "@moltzap/identity";
import { RouterInstanceId } from "@moltzap/router";
import canonicalize from "canonicalize";
import { Either, Encoding, Schema } from "effect";
import {
  ConversationId,
  type JsonValue,
  type Content as SemanticContent,
} from "../contract.js";

/* eslint-disable jsdoc/require-jsdoc -- These package-private Schema names are the exact closed value documentation. */

export const maximumContentBytes = 32_768;
export const maximumMembers = 32;
const HASH_BYTE_LENGTH = 32;
const utf8Encoder = new TextEncoder();

const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({ parseOptions: exactOptions });

const versionAndKind = <const Kind extends string>(kind: Kind) => ({
  moltzapVersion: Schema.Literal(MOLTZAP_VERSION),
  kind: Schema.Literal(kind),
});

const decodeCanonicalBase64Url = (value: string): Uint8Array | undefined =>
  Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => undefined,
    onRight: (bytes) =>
      Encoding.encodeBase64Url(bytes) === value ? bytes : undefined,
  });

const canonicalIdentifier = <const Name extends string>(
  name: Name,
  prefix: string,
) =>
  Schema.String.pipe(
    Schema.filter(
      (value) =>
        value.startsWith(prefix) &&
        decodeCanonicalBase64Url(value.slice(prefix.length))?.byteLength ===
          HASH_BYTE_LENGTH,
      { identifier: name, description: `${name} canonical representation` },
    ),
    Schema.brand(name),
    Schema.annotations({
      identifier: name,
      description: `${name} canonical representation`,
    }),
  );

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Private Effect Schemas share their domain names with the values they decode. */

export const MembershipHash = canonicalIdentifier("MembershipHash", "mbr_");
export type MembershipHash = typeof MembershipHash.Type;
export const AnchorHash = canonicalIdentifier("AnchorHash", "anc_");
export type AnchorHash = typeof AnchorHash.Type;
export const ActionHash = canonicalIdentifier("ActionHash", "ach_");
export type ActionHash = typeof ActionHash.Type;
export const RecordHash = canonicalIdentifier("RecordHash", "rch_");
export type RecordHash = typeof RecordHash.Type;
export const BeginDigest = canonicalIdentifier("BeginDigest", "bgn_");
export type BeginDigest = typeof BeginDigest.Type;
export const ContentHash = canonicalIdentifier("ContentHash", "cnt_");
export type ContentHash = typeof ContentHash.Type;
export const ReplyFingerprint = canonicalIdentifier("ReplyFingerprint", "rpf_");
export type ReplyFingerprint = typeof ReplyFingerprint.Type;

const isLeadingSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xd800 && codeUnit <= 0xdbff;

const isTrailingSurrogate = (codeUnit: number): boolean =>
  codeUnit >= 0xdc00 && codeUnit <= 0xdfff;

const hasWellFormedUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (isTrailingSurrogate(codeUnit)) {
      return false;
    }
    if (!isLeadingSurrogate(codeUnit)) {
      continue;
    }
    index += 1;
    if (!isTrailingSurrogate(value.charCodeAt(index))) {
      return false;
    }
  }
  return true;
};

const wellFormedString = Schema.String.pipe(
  Schema.filter(hasWellFormedUnicode),
);

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.JsonNumber,
    wellFormedString,
    Schema.Array(JsonValueSchema),
    Schema.Record({ key: wellFormedString, value: JsonValueSchema }),
  ),
).annotations({ identifier: "ClientJsonValue" });

const ContentPart = Schema.Union(
  exactStruct({ type: Schema.Literal("text"), text: wellFormedString }),
  exactStruct({ type: Schema.Literal("data"), value: JsonValueSchema }),
);

const ContentStructure: Schema.Schema<SemanticContent> =
  Schema.NonEmptyArray(ContentPart);

const contentFits = (content: SemanticContent): boolean => {
  try {
    const text = canonicalize(content);
    return (
      text !== undefined &&
      utf8Encoder.encode(text).byteLength <= maximumContentBytes
    );
    // eslint-disable-next-line agent-code-guard/bare-catch -- A Schema predicate converts hostile canonicalization into ordinary validation failure. #ignore-sloppy-code-next-line[bare-catch]: The predicate returns false.
  } catch {
    return false;
  }
};

export const Content = ContentStructure.pipe(
  Schema.filter(contentFits),
  Schema.annotations({ identifier: "ClientContent" }),
);

const encodedAgentCard = Schema.encodedSchema(AgentCard);
const encodedSignedMessage = Schema.encodedSchema(SignedMessage);
const MembershipMembers = Schema.Tuple(
  [encodedAgentCard, encodedAgentCard],
  encodedAgentCard,
).pipe(Schema.maxItems(maximumMembers));
const EvidenceMessages = Schema.NonEmptyArray(encodedSignedMessage).pipe(
  Schema.maxItems(maximumMembers),
);

export const Membership = exactStruct({
  ...versionAndKind("membership"),
  conversationId: ConversationId,
  membershipEpoch: Schema.Literal(0),
  members: MembershipMembers,
});
export type Membership = typeof Membership.Type;

export const GenesisAnchor = exactStruct({
  ...versionAndKind("genesis_anchor"),
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  routerInstanceId: RouterInstanceId,
});
export type GenesisAnchor = typeof GenesisAnchor.Type;

export const ReanchorBody = exactStruct({
  ...versionAndKind("reanchor_body"),
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  previousAnchorHash: AnchorHash,
  selectedRecordHash: RecordHash,
  routerInstanceId: RouterInstanceId,
});
export type ReanchorBody = typeof ReanchorBody.Type;

export const StartAction = exactStruct({
  ...versionAndKind("start_action"),
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  anchorHash: AnchorHash,
  previousRecordHash: Schema.Null,
  beginDigest: Schema.Null,
  actionId: Schema.Literal("START"),
  authorAgentId: AgentId,
  content: Content,
  replyFingerprint: Schema.Null,
});
export type StartAction = typeof StartAction.Type;

export const MulticastAction = exactStruct({
  ...versionAndKind("multicast_action"),
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  anchorHash: AnchorHash,
  previousRecordHash: RecordHash,
  beginDigest: BeginDigest,
  actionId: Schema.Literal("MULTICAST"),
  authorAgentId: AgentId,
  content: Content,
  replyFingerprint: ReplyFingerprint,
});
export type MulticastAction = typeof MulticastAction.Type;
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private codecs and verifiers compose this exact action union.
export const Action = Schema.Union(StartAction, MulticastAction);
export type Action = typeof Action.Type;

export const ActionBinding = exactStruct({
  ...versionAndKind("action_binding"),
  actionKind: Schema.Literal("START", "MULTICAST"),
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  anchorHash: AnchorHash,
  previousRecordHash: Schema.NullOr(RecordHash),
  beginDigest: Schema.NullOr(BeginDigest),
  actionId: Schema.Literal("START", "MULTICAST"),
  authorAgentId: AgentId,
  contentHash: ContentHash,
  replyFingerprint: Schema.NullOr(ReplyFingerprint),
});
export type ActionBinding = typeof ActionBinding.Type;

export const StartProposal = exactStruct({
  ...versionAndKind("start_proposal"),
  membership: Membership,
  genesisAnchor: GenesisAnchor,
  action: StartAction,
});
export type StartProposal = typeof StartProposal.Type;

export const Begin = exactStruct({
  ...versionAndKind("begin"),
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  anchorHash: AnchorHash,
  previousRecordHash: RecordHash,
  actionId: Schema.Literal("MULTICAST"),
  contenderAgentId: AgentId,
});
export type Begin = typeof Begin.Type;

export const AckStatement = exactStruct({
  ...versionAndKind("ack"),
  signerAgentId: AgentId,
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  previousRecordHash: RecordHash,
  beginDigest: BeginDigest,
});
export type AckStatement = typeof AckStatement.Type;

export const MulticastProposal = exactStruct({
  ...versionAndKind("multicast_proposal"),
  action: MulticastAction,
});
export type MulticastProposal = typeof MulticastProposal.Type;

export const ActionSignatureStatement = exactStruct({
  ...versionAndKind("action_signature"),
  signerAgentId: AgentId,
  action: ActionBinding,
});
export type ActionSignatureStatement = typeof ActionSignatureStatement.Type;

export const ActionCertificate = exactStruct({
  ...versionAndKind("action_certificate"),
  action: ActionBinding,
  signatures: EvidenceMessages,
});
export type ActionCertificate = typeof ActionCertificate.Type;

export const ActionCertifiedRecord = exactStruct({
  ...versionAndKind("action_certified_record"),
  membership: Membership,
  anchorHash: AnchorHash,
  action: Action,
  actionHash: ActionHash,
  actionCertificate: ActionCertificate,
});
export type ActionCertifiedRecord = typeof ActionCertifiedRecord.Type;

export const DurabilityVoteStatement = exactStruct({
  ...versionAndKind("durability_vote"),
  signerAgentId: AgentId,
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  recordHash: RecordHash,
});
export type DurabilityVoteStatement = typeof DurabilityVoteStatement.Type;

export const CatchUpRequest = exactStruct({
  ...versionAndKind("catch_up_request"),
  conversationId: ConversationId,
  membershipHash: MembershipHash,
  requesterAgentId: AgentId,
  knownRecordHash: Schema.NullOr(RecordHash),
  knownAnchorHash: Schema.NullOr(AnchorHash),
}).pipe(
  Schema.filter(
    (request) =>
      (request.knownRecordHash === null) === (request.knownAnchorHash === null),
  ),
);
export type CatchUpRequest = typeof CatchUpRequest.Type;

export const CatchUpAttestation = exactStruct({
  ...versionAndKind("catch_up_attestation"),
  signerAgentId: AgentId,
  request: CatchUpRequest,
  itemKind: Schema.Literal(
    "certified_record",
    "completed_reanchor",
    "incomplete",
  ),
  itemHash: Schema.NullOr(Schema.Union(RecordHash, AnchorHash)),
  hasMore: Schema.Boolean,
});
export type CatchUpAttestation = typeof CatchUpAttestation.Type;

export const ReanchorVoteStatement = exactStruct({
  ...versionAndKind("reanchor_vote"),
  signerAgentId: AgentId,
  anchorHash: AnchorHash,
  reanchor: ReanchorBody,
});
export type ReanchorVoteStatement = typeof ReanchorVoteStatement.Type;

export const CompletedReanchor = exactStruct({
  ...versionAndKind("completed_reanchor"),
  anchorHash: AnchorHash,
  reanchor: ReanchorBody,
  votes: EvidenceMessages,
});
export type CompletedReanchor = typeof CompletedReanchor.Type;

export const CertifiedRecord = exactStruct({
  ...versionAndKind("certified_record"),
  recordHash: RecordHash,
  actionCertifiedRecord: ActionCertifiedRecord,
  routerAnchor: Schema.Union(GenesisAnchor, CompletedReanchor),
  durabilityVotes: EvidenceMessages,
});
export type CertifiedRecord = typeof CertifiedRecord.Type;

// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private catch-up codecs compose this exact item union.
export const CatchUpItem = Schema.Union(CertifiedRecord, CompletedReanchor);
export type CatchUpItem = typeof CatchUpItem.Type;

export const CatchUpPage = exactStruct({
  ...versionAndKind("catch_up_page"),
  request: CatchUpRequest,
  item: CatchUpItem,
  hasMore: Schema.Boolean,
  attestation: encodedSignedMessage,
});
export type CatchUpPage = typeof CatchUpPage.Type;

export const CatchUpIncomplete = exactStruct({
  ...versionAndKind("catch_up_incomplete"),
  request: CatchUpRequest,
  attestation: encodedSignedMessage,
});
export type CatchUpIncomplete = typeof CatchUpIncomplete.Type;

// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private evidence signing and verification compose this exact statement union.
export const EvidenceStatement = Schema.Union(
  AckStatement,
  ActionSignatureStatement,
  DurabilityVoteStatement,
  CatchUpAttestation,
  ReanchorVoteStatement,
);
export type EvidenceStatement = typeof EvidenceStatement.Type;

// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private Router-envelope codecs compose this exact packet union.
export const DirectPacket = Schema.Union(
  StartProposal,
  Begin,
  MulticastProposal,
  ActionCertifiedRecord,
  CertifiedRecord,
  CatchUpRequest,
  CatchUpPage,
  CatchUpIncomplete,
  CompletedReanchor,
);
export type DirectPacket = typeof DirectPacket.Type;

export const ReplyInput = exactStruct({
  ...versionAndKind("reply_input"),
  content: Content,
});

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules. */

/* eslint-enable jsdoc/require-jsdoc -- Restore package documentation rules. */
