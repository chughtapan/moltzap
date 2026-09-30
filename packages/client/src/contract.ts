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

function isCanonicalPostId(value: string): boolean {
  if (!value.startsWith("pst_")) {
    return false;
  }
  return Either.match(Encoding.decodeBase64Url(value.slice(4)), {
    onLeft: () => false,
    onRight: (bytes) =>
      bytes.byteLength === HASH_BYTE_LENGTH &&
      `pst_${Encoding.encodeBase64Url(bytes)}` === value,
  });
}

/** Opaque identity minted for one addressed-send invocation. */
export const PostId = Schema.String.pipe(
  Schema.filter(isCanonicalPostId, {
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
 * Multicast: one post to the `to` address, complete when certified. `op`
 * defaults to multicast, so an omitted `op` and an omitted `collective` mean
 * the same operation.
 */
const multicastOperation = exactStruct({
  op: Schema.optionalWith(Schema.Literal("multicast"), { exact: true }),
});

/**
 * The collective operation one send performs, discriminated by `op`. Each
 * operation is one member of this union; the schema carries no identifier so
 * its JSON Schema embeds inline in a host tool's parameters.
 */
export const CollectiveOperation = Schema.Union(multicastOperation).annotations(
  {
    description:
      "The collective operation. Omit it, or its op, for multicast: one post to the to address.",
  },
);
/** A validated collective operation. */
export type CollectiveOperation = typeof CollectiveOperation.Type;

/**
 * One operation: its address, its body text and the collective operation it
 * performs, multicast when `collective` is omitted.
 */
export const SendInput = exactStruct({
  to: MessageAddressInput,
  text: wellFormedString,
  collective: Schema.optionalWith(CollectiveOperation, { exact: true }),
}).annotations({ identifier: "SendInput" });
/** Validated input for one operation. */
export type SendInput = typeof SendInput.Type;

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

/**
 * One inbound item, discriminated by `kind`. The endpoint consumes the
 * collective layer's protocol posts, posts whose collective part is malformed
 * or duplicated, and multicasts that carry nothing besides that part; every
 * other certified post becomes one item.
 */
export const InboundItem = Schema.Union(multicastItem).annotations({
  identifier: "InboundItem",
});
/** A validated inbound item. */
export type InboundItem = typeof InboundItem.Type;

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

const historyExportSendOutcome = Schema.Union(
  exactStruct({ kind: Schema.Literal("certified"), postId: PostId }),
  exactStruct({ kind: Schema.Literal("failed"), reason: sendFailure }),
);

/**
 * One line of the daemon's optional history export: an inbound item, a
 * completed `send` invocation with its operation and outcome, or the one line
 * that says the export stopped. Readers decode the file line by line with
 * this schema rather than copying its shape.
 */
export const HistoryExportRecord = Schema.Union(
  exactStruct({
    kind: Schema.Literal("inbound"),
    item: InboundItem,
    at: Schema.DateTimeUtc,
  }),
  exactStruct({
    kind: Schema.Literal("outbound"),
    to: MessageAddressInput,
    text: wellFormedString,
    collective: Schema.optionalWith(CollectiveOperation, { exact: true }),
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
 * Every send is one operation; the stream yields inbound items.
 */
export interface HarnessEndpoint {
  readonly send: (input: SendInput) => Effect.Effect<void, SendError>;
  readonly messages: Stream.Stream<InboundDelivery, ListenError>;
}

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
