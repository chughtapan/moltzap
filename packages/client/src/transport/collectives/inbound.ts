/** @file The items an endpoint delivers to its host: messages and collective requests, results and failures. */

import { Schema } from "effect";
import { AgentAddress, MessageAddressInput } from "../messaging/address.js";
import { InboundMessage } from "../messaging/message.js";
import { exactStruct, PostId, wellFormedString } from "../wire/values.js";
import { AnswerContent, CollectiveId, RequestedSchema } from "./forms.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

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

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */
