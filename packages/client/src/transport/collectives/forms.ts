/** @file Collective operations, answers and the closed errors of a refused collective send. */

import { Data, ParseResult, Schema } from "effect";
import {
  type SendError,
  sendFailureReasons,
  sendFailureText,
} from "../messaging/errors.js";
import {
  AgentAddress,
  exactStruct,
  isCanonicalIdentifier,
  JsonValue,
  MessageAddressInput,
  wellFormedString,
} from "../wire/values.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

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

/** An `accept` answer, the only one that carries content. */
export const AcceptResponse = exactStruct({
  action: Schema.Literal("accept"),
  content: AnswerContent,
});

/** A `decline` answer. */
export const DeclineResponse = exactStruct({
  action: Schema.Literal("decline"),
});

/**
 * A member's answer to the one request open in the conversation it is sent
 * to: the requester's direct conversation for a gather, the group for an
 * all_gather. It is MCP's `ElicitResult`; only `accept` carries content,
 * valid against the request's schema.
 */
const CollectiveResponse = Schema.Union(AcceptResponse, DeclineResponse);
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

/** Members a send could not reach. */
const unreachableMembers = Schema.NonEmptyArray(
  exactStruct({
    member: AgentAddress,
    reason: Schema.Literal(...sendFailureReasons),
    detail: Schema.optionalWith(Schema.String, { exact: true }),
  }),
);

/** What a completed send returns: a collecting operation names its id. */
export interface SendResult {
  readonly operationId?: CollectiveId;
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
    members: unreachableMembers,
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

/**
 * The text of an all_gather whose close was not certified, so the asker has
 * no result. A close refused before it was queued reaches no member; a
 * `delivery-pending` close reaches them once MoltZap is reachable, and its
 * text says so.
 * @param error Why the close post failed.
 * @returns The `operationFailed` text the asker's model reads.
 */
export function closeFailureText(error: SendError): string {
  return `all_gather failed: the result could not be shared with the group: ${error.detail ?? sendFailureText[error.reason]}`;
}

/**
 * One line per issue of a decode failure, each led by its path, such as
 * `requestedSchema.type: Expected "object", actual "obj"`, joined by `; `.
 * A model repairs its input from this text alone.
 * @param error The failed decode.
 * @returns The issues as text.
 */
export const describeIssues = (error: ParseResult.ParseError): string =>
  ParseResult.ArrayFormatter.formatErrorSync(error)
    .map(({ path, message }) =>
      path.length === 0 ? message : `${path.map(String).join(".")}: ${message}`,
    )
    .join("; ");

/** What each answer-field problem means. */
const answerFieldText = {
  missing: "is missing",
  unexpected: "is not in the form",
  invalid: "is invalid",
} as const;

/** Every field of an answer that fails its request's schema. */
export type AnswerFieldFailures = Extract<
  CollectiveFailure,
  { readonly kind: "answer-invalid" }
>["fields"];

/**
 * Name each failing answer field, such as `field "slot" is invalid (enum)`.
 * A refused reply and a member's `invalid` outcome read the same.
 * @param fields The failing fields, in validation order.
 * @returns One clause per field, joined by `; `.
 */
export function answerFieldsText(fields: AnswerFieldFailures): string {
  return fields
    .map(({ field, reason, detail }) => {
      const problem = answerFieldText[reason];
      return detail === undefined
        ? `field "${field}" ${problem}`
        : `field "${field}" ${problem} (${detail})`;
    })
    .join("; ");
}

function describeCollectiveFailure(failure: CollectiveFailure): string {
  switch (failure.kind) {
    case "members-unreachable":
      return `send failed: ${failure.members
        .map(({ member, reason, detail }) =>
          reason === "unknown-agent"
            ? `${member} is not a known agent`
            : `${member} could not be reached: ${detail ?? sendFailureText[reason]}`,
        )
        .join("; ")}`;
    case "schema-invalid":
      return `send failed: the form is invalid (${failure.detail})`;
    case "answer-invalid":
      return `reply failed: ${answerFieldsText(failure.fields)}`;
    case "request-none":
      return "reply failed: no question is open in this conversation";
    case "request-ambiguous":
      return "reply failed: more than one question is open in this conversation, and answering one of several is not supported";
    case "request-answered":
      return "reply failed: the question was already answered";
    case "request-expired":
      return "reply failed: the question's deadline has passed";
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

/**
 * The service could not keep an item the layer emitted. The service has
 * already reported its own failure, so the layer only stops the work that
 * emitted the item.
 */
export class CollectiveEmitError extends Data.TaggedError(
  "CollectiveEmitError",
) {}

/**
 * A gather, all_gather or answer was refused. The message is what a host
 * hands its model as the tool error: the failed action and its cause, naming
 * each unreachable member or failing field. The operation id stays in the
 * error's data, not its message.
 */
export class CollectiveError extends Data.TaggedError("CollectiveError")<{
  readonly id: CollectiveId;
  readonly failure: CollectiveFailure;
}> {
  override get message(): string {
    return describeCollectiveFailure(this.failure);
  }
}

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
