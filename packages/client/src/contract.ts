/** @file Public runtime capability for one configured MoltZap endpoint. */

import { AgentName } from "@moltzap/identity";
import canonicalize from "canonicalize";
import {
  Data,
  type Effect,
  Either,
  Encoding,
  Schema,
  type Stream,
} from "effect";

// safer-arch-ignore shared-kernel-cohesion: This is the one public Client contract; adapters read its items, the collective layer its operations and answers, and the MCP wire its failures, so its consumers differ by design and splitting it would give one contract several homes.

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

const MAXIMUM_CONTENT_BYTES = 32_768;
const MAXIMUM_GROUP_MEMBERS = 32;
const HASH_BYTE_LENGTH = 32;
const AGENT_ADDRESS_PREFIX = "agent:";
const GROUP_ADDRESS_PREFIX = "group:";
const utf8Encoder = new TextEncoder();

const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({ parseOptions: exactOptions });

const isAgentName = Schema.is(AgentName);

function hasWellFormedUnicode(value: string): boolean {
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
}

function isLeadingSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isTrailingSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function parseAgentAddress(value: string): string | undefined {
  if (!value.startsWith(AGENT_ADDRESS_PREFIX)) {
    return undefined;
  }
  const name = value.slice(AGENT_ADDRESS_PREFIX.length);
  return isAgentName(name) ? name : undefined;
}

function isCanonicalGroupAddress(value: string): boolean {
  const names = parseGroupAddress(value);
  if (
    names === undefined ||
    names.length < 3 ||
    names.length > MAXIMUM_GROUP_MEMBERS
  ) {
    return false;
  }
  for (let index = 1; index < names.length; index += 1) {
    const previous = names[index - 1];
    const current = names[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareAscii(previous, current) >= 0
    ) {
      return false;
    }
  }
  return true;
}

function parseGroupAddress(value: string): readonly string[] | undefined {
  if (!value.startsWith(GROUP_ADDRESS_PREFIX)) {
    return undefined;
  }
  const names = value.slice(GROUP_ADDRESS_PREFIX.length).split(",");
  return names.length > 0 && names.every((name) => isAgentName(name))
    ? names
    : undefined;
}

function compareAscii(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

const addressInput = Schema.String.pipe(
  Schema.filter(
    (value) =>
      parseAgentAddress(value) !== undefined ||
      parseGroupAddress(value) !== undefined,
    {
      identifier: "MessageAddressInput",
      description: "An agent address or syntactically valid group input",
    },
  ),
  Schema.brand("MessageAddressInput"),
);

/** An explicit direct destination using one canonical Registry name. */
export const AgentAddress = addressInput.pipe(
  Schema.filter((value) => parseAgentAddress(value) !== undefined),
  Schema.brand("AgentAddress"),
  Schema.annotations({ identifier: "AgentAddress" }),
);
/** A validated direct destination. */
export type AgentAddress = typeof AgentAddress.Type;

/** A complete fixed-member group address in unsigned ASCII name order. */
export const GroupAddress = addressInput.pipe(
  Schema.filter(isCanonicalGroupAddress),
  Schema.brand("GroupAddress"),
  Schema.annotations({ identifier: "GroupAddress" }),
);
/** A validated canonical complete group destination. */
export type GroupAddress = typeof GroupAddress.Type;

/** Either accepted destination input, including noncanonical group order. */
export const MessageAddressInput = addressInput;
/** A validated explicit destination input. */
export type MessageAddressInput = typeof MessageAddressInput.Type;

function isCanonicalIdentifier(prefix: string, value: string): boolean {
  if (!value.startsWith(prefix)) {
    return false;
  }
  return Either.match(Encoding.decodeBase64Url(value.slice(prefix.length)), {
    onLeft: () => false,
    onRight: (bytes) =>
      bytes.byteLength === HASH_BYTE_LENGTH &&
      `${prefix}${Encoding.encodeBase64Url(bytes)}` === value,
  });
}

/** Opaque identity minted for one addressed-send invocation. */
export const PostId = Schema.String.pipe(
  Schema.filter((value) => isCanonicalIdentifier("pst_", value), {
    identifier: "PostId",
    description: "Canonical author-scoped post identity",
  }),
  Schema.brand("PostId"),
  Schema.annotations({ identifier: "PostId" }),
);
/** A validated author-scoped post identity. */
export type PostId = typeof PostId.Type;

const wellFormedString = Schema.String.pipe(
  Schema.filter(hasWellFormedUnicode, {
    identifier: "WellFormedUnicodeString",
  }),
);

/* eslint-disable agent-code-guard/no-nullish-type-aliases -- JSON includes null as a first-class value. */
/** A value accepted by the closed semantic content boundary. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
/* eslint-enable agent-code-guard/no-nullish-type-aliases -- Restore the absence rule outside JSON values. */

/** Runtime validation for the closed recursive JSON value. */
export const JsonValue: Schema.Schema<JsonValue> = Schema.suspend(() =>
  Schema.Union(
    Schema.Null,
    Schema.Boolean,
    Schema.JsonNumber,
    wellFormedString,
    Schema.Array(JsonValue),
    Schema.Record({ key: wellFormedString, value: JsonValue }),
  ),
).annotations({ identifier: "JsonValue" });

/** One exact semantic part of a message. */
export const ContentPart = Schema.Union(
  exactStruct({ type: Schema.Literal("text"), text: wellFormedString }),
  exactStruct({ type: Schema.Literal("data"), value: JsonValue }),
).annotations({ identifier: "ContentPart" });
/** A validated semantic message part. */
export type ContentPart = typeof ContentPart.Type;

function contentFits(
  content: readonly [ContentPart, ...ContentPart[]],
): boolean {
  return Either.match(
    Either.try(() => canonicalize(content)),
    {
      onLeft: () => false,
      onRight: (canonical) =>
        canonical !== undefined &&
        utf8Encoder.encode(canonical).byteLength <= MAXIMUM_CONTENT_BYTES,
    },
  );
}

const contentStructure = Schema.NonEmptyArray(ContentPart);

/** Nonempty semantic content whose canonical JSON is at most 32,768 bytes. */
export const Content = contentStructure.pipe(
  Schema.filter(contentFits),
  Schema.annotations({ identifier: "Content" }),
);
/** Validated nonempty semantic content. */
export type Content = typeof Content.Type;

/**
 * Identity of one gather or all_gather, minted by the requesting endpoint.
 * The request, each member's answer post, an all_gather's close, the result
 * and any failure carry it. An answer that matches no single open request is
 * refused under an id minted for the refusal, so its failure is named too.
 */
export const CollectiveId = Schema.String.pipe(
  Schema.filter((value) => isCanonicalIdentifier("col_", value), {
    description:
      "A collective operation id: col_ followed by 43 base64url characters",
  }),
  Schema.brand("CollectiveId"),
);
/** A validated collective operation id. */
export type CollectiveId = typeof CollectiveId.Type;

/** One property of a form-mode schema as a caller states it. */
const formProperty = Schema.Record({ key: Schema.String, value: JsonValue });

/**
 * The MCP form-mode `requestedSchema` of a collecting operation: a flat object
 * of primitive properties. This schema fixes its outline; the sending endpoint
 * checks each property against the MCP form-mode grammar before any post.
 */
export const RequestedSchema = exactStruct({
  $schema: Schema.optionalWith(Schema.String, { exact: true }),
  type: Schema.Literal("object"),
  properties: Schema.Record({ key: Schema.String, value: formProperty }),
  required: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
});
/** A form-mode schema as stated by its requester. */
export type RequestedSchema = typeof RequestedSchema.Type;

/**
 * One answer to a collecting operation, field by field. Its value space is MCP
 * `ElicitResult` content's; the request's schema decides which fields apply.
 */
export const AnswerContent = Schema.Record({
  key: Schema.String,
  value: Schema.Union(
    Schema.String,
    Schema.Number.pipe(Schema.finite()),
    Schema.Boolean,
    Schema.Array(Schema.String),
  ),
}).annotations({
  description: "The answer, one field per requestedSchema property",
});
/** A structurally valid answer. */
export type AnswerContent = typeof AnswerContent.Type;

/** The longest deadline a collecting operation may state: 30 days, in seconds. */
export const MAXIMUM_DEADLINE_SECONDS = 2_592_000;

/** A collecting operation's relative deadline: whole seconds, up to 30 days. */
export const DeadlineSeconds = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, MAXIMUM_DEADLINE_SECONDS),
);

/**
 * Multicast: one post to the `to` address, complete when certified. `op`
 * defaults to multicast, so an omitted `op` and an omitted `collective` mean
 * the same operation.
 */
const multicastOperation = exactStruct({
  op: Schema.optionalWith(Schema.Literal("multicast"), { exact: true }),
});

/**
 * A collecting operation: the text is a question to every member of `to`.
 * A gather sends one request post to each member, in that member's direct
 * conversation with the requester, and only the requester receives the
 * result. An all_gather sends one request post to the `group:` conversation
 * `to` names; members answer there, no model sees a peer's answer before the
 * requester's close, and every member receives the same result. The deadline
 * is relative, in whole seconds; the sending endpoint converts it to an
 * absolute time at send.
 */
const collectingOperation = exactStruct({
  op: Schema.Literal("gather", "all_gather"),
  deadline: DeadlineSeconds,
  requestedSchema: RequestedSchema,
});

/** The collective operation one send performs, discriminated by `op`. */
const CollectiveOperation = Schema.Union(
  multicastOperation,
  collectingOperation,
);
/** A validated collective operation. */
export type CollectiveOperation = typeof CollectiveOperation.Type;

/**
 * A member's answer to the one request open in the conversation it is sent
 * to: the requester's direct conversation for a gather, the group for an
 * all_gather. It is MCP's `ElicitResult`; only `accept` carries content,
 * valid against the request's schema.
 */
const CollectiveResponse = Schema.Union(
  exactStruct({
    action: Schema.Literal("accept"),
    content: AnswerContent,
  }),
  exactStruct({
    action: Schema.Literal("decline"),
  }),
);
/** A validated collective response. */
export type CollectiveResponse = typeof CollectiveResponse.Type;

/**
 * One send to one address: text with its collective operation, multicast
 * when `collective` is omitted, or an answer to the request open in that
 * address's conversation. `parseMessageText` reads both from a message's
 * text.
 */
export const SendInput = Schema.Union(
  exactStruct({
    to: MessageAddressInput,
    text: wellFormedString,
    collective: Schema.optionalWith(CollectiveOperation, { exact: true }),
  }),
  exactStruct({
    to: MessageAddressInput,
    collectiveResponse: CollectiveResponse,
  }),
).annotations({ identifier: "SendInput" });
/** Validated input for one send. */
export type SendInput = typeof SendInput.Type;

/**
 * Where a refused collecting operation or response reports its error:
 * returned to the caller, or emitted as an `operationFailed` item while the
 * send completes.
 */
export type FailureDelivery = "result" | "inbound";

const sendFailure = Schema.Literal(
  "invalid-address",
  "unknown-agent",
  "membership-invalid",
  "content-invalid",
  "not-registered",
  "version-mismatch",
  "certification-unavailable",
  "persistence-failed",
  "network-unavailable",
);
type SendFailure = typeof sendFailure.Type;

/** Members a send could not reach, each with its send failure's reason. */
export const UnreachableMembers = Schema.NonEmptyArray(
  exactStruct({ member: AgentAddress, reason: sendFailure }),
).annotations({ identifier: "UnreachableMembers" });
/** Validated unreachable members. */
export type UnreachableMembers = typeof UnreachableMembers.Type;

/** Members whose request post was still being certified when a send returned. */
export const PendingMembers = Schema.NonEmptyArray(AgentAddress).annotations({
  identifier: "PendingMembers",
});
/** Validated pending members. */
export type PendingMembers = typeof PendingMembers.Type;

/**
 * What a completed send returns: a collecting operation names its id. A
 * gather names the members whose request post was refused, each of which
 * ends as `no-answer`, and those whose post was still being certified, which
 * are asked once it is and end as `no-answer` if it is not by the deadline.
 */
export interface SendResult {
  readonly operationId?: CollectiveId;
  readonly unreachable?: UnreachableMembers;
  readonly pending?: PendingMembers;
}

const directMessageStructure = exactStruct({
  kind: Schema.Literal("direct"),
  postId: PostId,
  address: AgentAddress,
  sender: AgentAddress,
  content: Content,
});

const directMessage = directMessageStructure.pipe(
  Schema.filter((message) => message.address === message.sender, {
    identifier: "DirectMessage",
    description: "A direct delivery addressed by its remote sender",
  }),
);

const groupMembers = Schema.Tuple(
  [AgentAddress, AgentAddress, AgentAddress],
  AgentAddress,
).pipe(Schema.maxItems(MAXIMUM_GROUP_MEMBERS));

const groupMessageStructure = exactStruct({
  kind: Schema.Literal("group"),
  postId: PostId,
  address: GroupAddress,
  sender: AgentAddress,
  members: groupMembers,
  content: Content,
});

const groupMessage = groupMessageStructure.pipe(
  Schema.filter(
    (message) => {
      const addressNames = parseGroupAddress(message.address);
      return (
        addressNames !== undefined &&
        addressNames.length === message.members.length &&
        message.members.every(
          (member, index) => parseAgentAddress(member) === addressNames[index],
        ) &&
        message.members.includes(message.sender)
      );
    },
    {
      identifier: "GroupMessage",
      description:
        "A group delivery whose canonical address, members, and sender agree",
    },
  ),
);

/** One certified remote-authored direct message. */
export type DirectMessage = typeof directMessage.Type;
/** One certified remote-authored fixed-group message. */
export type GroupMessage = typeof groupMessage.Type;

/** One certified remote-authored post, direct or to a fixed group. */
export const InboundMessage = Schema.Union(
  directMessage,
  groupMessage,
).annotations({ identifier: "InboundMessage" });
/** A validated direct or group post. */
export type InboundMessage = typeof InboundMessage.Type;

/**
 * A multicast delivered to this endpoint. The message content is the post's
 * content without the collective layer's part.
 */
const multicastItem = exactStruct({
  kind: Schema.Literal("multicast"),
  message: InboundMessage,
});

/** Absolute epoch milliseconds; endpoints assume zero clock skew. */
const epochMillis = Schema.Number.pipe(Schema.int(), Schema.positive());

/**
 * A question another agent asked this one. `postId` is the certified request
 * post's and `to` the conversation it arrived in: the requester's `agent:`
 * address for a gather, the group's `group:` address for an all_gather. The
 * member answers once with a `collectiveResponse` sent to `to`.
 */
const collectiveRequestItem = exactStruct({
  kind: Schema.Literal("collectiveRequest"),
  id: CollectiveId,
  postId: PostId,
  from: AgentAddress,
  to: MessageAddressInput,
  question: wellFormedString,
  requestedSchema: RequestedSchema,
  deadlineAt: epochMillis,
});

/**
 * One member's outcome in a completed gather or all_gather, discriminated by
 * `kind`. `no-answer` covers every member that did not answer: one whose
 * request post was refused or not certified in time, and one silent at the
 * deadline.
 */
const memberOutcome = Schema.Union(
  exactStruct({ kind: Schema.Literal("answered"), content: AnswerContent }),
  exactStruct({ kind: Schema.Literal("declined") }),
  exactStruct({ kind: Schema.Literal("invalid"), reason: Schema.String }),
  exactStruct({ kind: Schema.Literal("no-answer") }),
);
/** One member's recorded outcome. */
export type CollectiveMemberOutcome = typeof memberOutcome.Type;

/**
 * The result of a gather this endpoint started, or of an all_gather this
 * endpoint started or was asked: exactly one outcome per member, in member
 * order. `to` is the address the operation named. An all_gather's result
 * names its certified close post in `closePostId`; every member's result is
 * built from exactly the answers that close lists, so each endpoint's result
 * is the same.
 */
const collectiveResultItem = exactStruct({
  kind: Schema.Literal("collectiveResult"),
  id: CollectiveId,
  to: MessageAddressInput,
  question: wellFormedString,
  outcomes: Schema.NonEmptyArray(
    exactStruct({ member: AgentAddress, outcome: memberOutcome }),
  ),
  closePostId: Schema.optionalWith(PostId, { exact: true }),
});

/**
 * A collective send that failed after the host's tool had returned, or an
 * all_gather whose close could not be certified. `to` is the operation's
 * address, or the request's conversation for a response; `error` is the text
 * a waiting host would have received as the tool error.
 */
const operationFailedItem = exactStruct({
  kind: Schema.Literal("operationFailed"),
  id: CollectiveId,
  to: MessageAddressInput,
  error: Schema.String,
});

/**
 * One inbound item, discriminated by `kind`. The endpoint consumes the
 * collective layer's protocol posts, posts whose collective part is malformed
 * or duplicated, and multicasts that carry nothing besides that part; every
 * other certified post becomes one item, and the endpoint itself emits
 * results and failures.
 */
export const InboundItem = Schema.Union(
  multicastItem,
  collectiveRequestItem,
  collectiveResultItem,
  operationFailedItem,
).annotations({
  identifier: "InboundItem",
});
/** A validated inbound item. */
export type InboundItem = typeof InboundItem.Type;

/**
 * How one send ended in the history export: the posts certified by the time
 * it returned, with the operation id of a gather or all_gather and the
 * members a gather did not reach, or the error it returned.
 */
const historyExportSendOutcome = Schema.Union(
  exactStruct({
    kind: Schema.Literal("sent"),
    operationId: Schema.optionalWith(CollectiveId, { exact: true }),
    unreachable: Schema.optionalWith(UnreachableMembers, { exact: true }),
    pending: Schema.optionalWith(PendingMembers, { exact: true }),
    postIds: Schema.Array(PostId),
  }),
  exactStruct({ kind: Schema.Literal("failed"), error: Schema.String }),
);

/**
 * One line of the daemon's optional history export: an item as the daemon
 * published it, a completed `send` invocation with its input and outcome, or
 * the one line that says the export stopped. Readers decode the file line by
 * line with this schema rather than copying its shape.
 */
export const HistoryExportRecord = Schema.Union(
  exactStruct({
    kind: Schema.Literal("inbound"),
    item: InboundItem,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("outbound"),
    input: SendInput,
    outcome: historyExportSendOutcome,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("export-failed"),
    reason: Schema.String,
    at: Schema.DateTimeUtc,
  }),
).annotations({ identifier: "HistoryExportRecord" });
/** A validated line of the daemon's history export. */
export type HistoryExportRecord = typeof HistoryExportRecord.Type;

/** An addressed send failed before local certification completed. */
export class SendError extends Data.TaggedError("SendError")<{
  readonly reason: SendFailure;
}> {
  override get message(): string {
    return `send failed: ${this.reason}`;
  }
}

/**
 * Why a collective send was refused, discriminated by `kind`: a gather or
 * all_gather whose schema is outside the form-mode grammar or whose request
 * post some member could not receive, or a response the member's endpoint
 * cannot send.
 */
const collectiveFailure = Schema.Union(
  exactStruct({
    kind: Schema.Literal("members-unreachable"),
    members: UnreachableMembers,
  }),
  exactStruct({
    kind: Schema.Literal("schema-invalid"),
    detail: Schema.String,
  }),
  exactStruct({
    kind: Schema.Literal("answer-invalid"),
    fields: Schema.NonEmptyArray(
      exactStruct({
        field: Schema.String,
        reason: Schema.Literal("missing", "unexpected", "invalid"),
        detail: Schema.optionalWith(Schema.String, { exact: true }),
      }),
    ),
  }),
  exactStruct({ kind: Schema.Literal("request-none") }),
  exactStruct({ kind: Schema.Literal("request-ambiguous") }),
  exactStruct({ kind: Schema.Literal("request-answered") }),
  exactStruct({ kind: Schema.Literal("request-expired") }),
);
/** A validated collective failure. */
export type CollectiveFailure = typeof collectiveFailure.Type;

/**
 * Decode a collective failure carried across the loopback MCP boundary.
 * @param value Untrusted failure detail from a refused send's error data.
 * @returns The validated failure.
 */
export const decodeCollectiveFailure = Schema.decodeUnknown(collectiveFailure);

function describeCollectiveFailure(failure: CollectiveFailure): string {
  switch (failure.kind) {
    case "members-unreachable":
      return `unreachable members: ${failure.members
        .map(({ member, reason }) => `${member} (${reason})`)
        .join(", ")}`;
    case "schema-invalid":
      return `requestedSchema is not an MCP form-mode schema: ${failure.detail}`;
    case "answer-invalid":
      return `content does not match the request's schema: ${failure.fields
        .map(({ field, reason, detail }) =>
          detail === undefined
            ? `${field}: ${reason}`
            : `${field}: ${reason} (${detail})`,
        )
        .join("; ")}`;
    case "request-none":
      return "no gather or all_gather request is open in this conversation";
    case "request-ambiguous":
      return "more than one gather or all_gather request is open in this conversation, and answering one of several is not supported; nothing was sent";
    case "request-answered":
      return "the request in this conversation was already answered";
    case "request-expired":
      return "the request in this conversation has passed its deadline";
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/**
 * A gather, all_gather or answer was refused. The message names each
 * unreachable member or failing field, so a host can hand it to its model as
 * the tool error.
 */
export class CollectiveError extends Data.TaggedError("CollectiveError")<{
  readonly id: CollectiveId;
  readonly failure: CollectiveFailure;
}> {
  override get message(): string {
    return `operation ${this.id} failed: ${describeCollectiveFailure(this.failure)}`;
  }
}

type ListenFailure =
  | "already-listening"
  | "incompatible-daemon"
  | "transport-failed"
  | "decode-failed";

/** The endpoint's sole inbound subscription failed. */
export class ListenError extends Data.TaggedError("ListenError")<{
  readonly reason: ListenFailure;
}> {
  override get message(): string {
    return `listen failed: ${this.reason}`;
  }
}

type DeliveryAcknowledgeFailure =
  | "unknown-delivery"
  | "delivery-conflict"
  | "persistence-failed"
  | "transport-failed";

/** Transport acknowledgment could not complete for one delivery. */
export class DeliveryAcknowledgeError extends Data.TaggedError(
  "DeliveryAcknowledgeError",
)<{
  readonly reason: DeliveryAcknowledgeFailure;
}> {
  override get message(): string {
    return `delivery acknowledgment failed: ${this.reason}`;
  }
}

type ConnectFailure =
  | "transport-failed"
  | "decode-failed"
  | "incompatible-daemon";

/** Acquiring the endpoint connection failed. */
export class ConnectError extends Data.TaggedError("ConnectError")<{
  readonly reason: ConnectFailure;
}> {
  override get message(): string {
    return `connect failed: ${this.reason}`;
  }
}

/** One inbound item plus its transport-only acknowledgment. */
export interface InboundDelivery {
  readonly item: InboundItem;
  readonly acknowledge: Effect.Effect<void, DeliveryAcknowledgeError>;
}

/**
 * Structural runtime capability owned by one scoped endpoint connection.
 * Every send is one operation or one collective response; the stream yields
 * inbound items.
 *
 * A host whose tool returns before the send completes passes
 * `failureDelivery: "inbound"`: a refused gather, all_gather or response
 * then completes and its error arrives as an `operationFailed` item on the
 * stream. A multicast has no operation id, so its failure is always returned.
 */
export interface HarnessEndpoint {
  readonly send: (
    input: SendInput,
    options?: Readonly<{ failureDelivery?: FailureDelivery }>,
  ) => Effect.Effect<SendResult, SendError | CollectiveError>;
  readonly messages: Stream.Stream<InboundDelivery, ListenError>;
}

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
