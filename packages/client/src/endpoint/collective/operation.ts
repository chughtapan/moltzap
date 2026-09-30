/**
 * @file Operations over the post envelope.
 *
 * A send is one operation; this module turns it into the content of the post
 * it certifies, and turns one certified post back into the inbound item the
 * subscriber receives. Every post an endpoint authors carries its operation as
 * an explicit collective part, so each certified post says which operation it
 * belongs to. A post without a collective part reads as multicast, the
 * operation an omitted `op` names.
 */

import { Effect, Array as EffectArray, Option } from "effect";
import type {
  CollectiveOperation,
  InboundItem,
  InboundMessage,
  SendInput,
} from "../../contract.js";
import {
  type CollectiveContentError,
  type CollectiveValue,
  encodeCollectiveContent,
  readCollectiveValue,
  withoutCollectivePart,
} from "./wire.js";

/** The identity a collecting operation's request, answers, close and send result share. */
export { CollectiveId } from "./wire.js";

type PostContent = InboundMessage["content"];

type OperationName = NonNullable<CollectiveOperation["op"]>;

/**
 * The collective part each single-post operation carries, keyed by `op`. The
 * mapped type makes a new operation name a compile error until it has an
 * entry.
 */
const singlePostOperations: {
  readonly [Op in OperationName]: CollectiveValue;
} = {
  multicast: { kind: "operation", op: "multicast" },
};

/**
 * Build the content of the one post a multicast certifies: the operation's
 * text, then its explicit collective part.
 * @param input One validated operation.
 * @returns Post content within the canonical size limit.
 */
export const operationContent = (
  input: SendInput,
): Effect.Effect<PostContent, CollectiveContentError> =>
  encodeCollectiveContent(
    singlePostOperations[input.collective?.op ?? "multicast"],
    input.text,
  );

/**
 * Classify one certified remote post as the item its subscriber receives.
 *
 * A multicast becomes a multicast item without its collective part. The
 * endpoint consumes every other collective value and every post whose
 * collective part is duplicated or malformed, and a multicast whose content
 * is only its collective part carries nothing to deliver.
 * @param message The certified post as the endpoint projected it.
 * @returns The item to publish, or none when the endpoint consumes the post.
 */
export const inboundItem = (
  message: InboundMessage,
): Effect.Effect<Option.Option<InboundItem>> =>
  readCollectiveValue(message.content).pipe(
    Effect.map(
      Option.match({
        onNone: () => Option.some<InboundItem>({ kind: "multicast", message }),
        onSome: (value) => collectiveItem(message, value),
      }),
    ),
    Effect.catchTag("CollectivePartInvalidError", () =>
      Effect.succeed(Option.none()),
    ),
  );

function collectiveItem(
  message: InboundMessage,
  value: CollectiveValue,
): Option.Option<InboundItem> {
  switch (value.kind) {
    case "operation":
      return value.op === "multicast"
        ? multicastItem(message, withoutCollectivePart(message.content))
        : Option.none();
    case "response":
    case "close":
      return Option.none();
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function multicastItem(
  message: InboundMessage,
  content: ReadonlyArray<PostContent[number]>,
): Option.Option<InboundItem> {
  return EffectArray.isNonEmptyReadonlyArray(content)
    ? Option.some({ kind: "multicast", message: { ...message, content } })
    : Option.none();
}
