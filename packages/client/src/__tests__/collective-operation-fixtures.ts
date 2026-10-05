/** @file Recording ports, post builders and send helpers shared by the collective operation tests. */

import {
  Duration,
  Effect,
  Encoding,
  Schema,
  type Scope,
  TestContext,
} from "effect";
import type { InboundItem } from "../transport/collectives/inbound.js";
import type { EngineSendInput } from "../transport/messaging/index.js";
import {
  CollectiveEmitError,
  CollectiveError,
  type CollectiveId,
  type FailureDelivery,
  SendInput,
} from "../transport/collectives/forms.js";
import {
  type CollectiveOperations,
  makeCollectiveOperations,
} from "../transport/collectives/operation.js";
import {
  collectiveIdOf,
  readCollectiveValue,
} from "../transport/collectives/part/index.js";
import { SendError } from "../transport/messaging/errors.js";
import { InboundMessage } from "../transport/messaging/message.js";
import { PostId, RecordHash } from "../transport/wire/index.js";
import { AgentAddress } from "../transport/wire/values.js";

/** The requester every layer `makeLayer` builds runs as. */
export const alice = Schema.decodeUnknownSync(AgentAddress)("agent:alice");

const bob = Schema.decodeUnknownSync(AgentAddress)("agent:bob");

/** The data-part key a post carries its collective value under. */
export const collectiveKey = "xyz.moltzap/collective";

/** The explicit collective part every multicast an endpoint authors carries. */
export const multicastPart = {
  type: "data",
  value: { [collectiveKey]: { kind: "operation", op: "multicast" } },
};

/** A form-mode schema asking for one required `slot`, `mon` or `tue`. */
export const slotSchema = {
  type: "object",
  properties: { slot: { type: "string", enum: ["mon", "tue"] } },
  required: ["slot"],
};

/** The nonce Bob's gather request carries. */
export const requestNonce = "N".repeat(43);

/** The id Bob's gather request derives from `requestNonce`, so it names Bob as its requester. */
export const requestId = collectiveIdOf(bob, requestNonce);

/** The question every gather and all_gather in these tests asks. */
export const questionText = "Which day works?";

/** The canonical address of the group a gather asks: alice, Bob and Carol. */
export const gatherTo = "group:alice,bob,carol";

/**
 * A record hash whose 32 bytes are all `byte`.
 * @param byte The repeated byte.
 * @returns The decoded RecordHash.
 */
export const recordHashOf = (byte: number) =>
  Schema.decodeUnknownSync(RecordHash)(
    `rch_${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`,
  );

/** The record hash every post a gather test classifies or certifies carries. */
const recordHash = recordHashOf(0);

/** What a layer's ports saw: the posts it certified and the items it emitted, in order. */
export interface Observed {
  readonly sent: EngineSendInput[];
  readonly emitted: InboundItem[];
}

/**
 * A PostId whose 32 bytes are all `byte`.
 * @param byte The repeated byte.
 * @returns The decoded PostId.
 */
export const postId = (byte: number) =>
  Schema.decodeUnknownSync(PostId)(
    `pst_${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`,
  );

/**
 * A recorder that has seen nothing yet.
 * @returns Empty sent and emitted lists.
 */
export const newObserved = (): Observed => ({ sent: [], emitted: [] });

/**
 * An emit port that keeps nothing, as a service whose store refuses every item.
 * @returns A failure naming the unkept item.
 */
export const unkeptEmit = () => Effect.fail(new CollectiveEmitError());

/**
 * Record a post and certify it under the next PostId: the nth post recorded
 * gets `postId(n)`.
 * @param observed Where the post is recorded.
 * @param input The post being certified.
 * @returns The certified post's PostId and the shared record hash.
 */
export const certifyNext = (observed: Observed, input: EngineSendInput) =>
  Effect.sync(() => {
    observed.sent.push(input);
    return { postId: postId(observed.sent.length), recordHash };
  });

/** What a test layer varies from ports that resolve, certify and keep everything. */
interface LayerOptions {
  /**
   * Members whose request post does not certify at once: refused with the
   * reason given, never certified for `slow`, or certified five seconds late
   * for `late`.
   */
  readonly refused?: Readonly<
    Record<string, SendError["reason"] | "slow" | "late">
  >;
  /** Members whose lookup fails as an unknown agent. */
  readonly unknown?: readonly string[];
  /** Whether the service keeps no item the layer emits. */
  readonly emitFails?: boolean;
}

/**
 * A collective layer for alice over recording ports, with a one-second send
 * wait, in the caller's scope.
 * @param observed Where the ports record certified posts and emitted items.
 * @param options Which members' posts or lookups fail, and whether emitted items are kept.
 * @param options.refused Members whose request post does not certify at once, and how it fares.
 * @param options.unknown Members whose lookup fails as an unknown agent.
 * @param options.emitFails Whether the service keeps no item the layer emits.
 * @returns The layer, scoped to the caller.
 */
export const makeLayer = (
  observed: Observed,
  { refused = {}, unknown = [], emitFails = false }: LayerOptions = {},
): Effect.Effect<CollectiveOperations, never, Scope.Scope> =>
  Effect.map(Effect.scope, (scope) =>
    makeCollectiveOperations({
      self: alice,
      lookupMember: (member) =>
        unknown.includes(member)
          ? Effect.fail(new SendError({ reason: "unknown-agent" }))
          : Effect.void,
      sendPost: (input) => {
        const reason = refused[input.to];
        if (reason === "slow") {
          return Effect.never;
        }
        if (reason !== undefined && reason !== "late") {
          return Effect.fail(new SendError({ reason }));
        }
        return Effect.sleep(
          reason === "late" ? Duration.seconds(5) : Duration.zero,
        ).pipe(Effect.zipRight(certifyNext(observed, input)));
      },
      emit: emitFails
        ? unkeptEmit
        : (item) =>
            Effect.sync(() => {
              observed.emitted.push(item);
            }),
      scope,
      requestSendWait: Duration.seconds(1),
    }),
  );

/**
 * Run a scoped test program on the test clock.
 * @param effect The test program.
 * @returns A promise of its result, for the test runner.
 */
export const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(TestContext.TestContext)),
  );

/**
 * A post in the direct conversation with `sender`.
 * @param sender The agent that authored the post.
 * @param content The post's parts.
 * @param byte The byte its PostId repeats.
 * @returns The decoded inbound message.
 */
export const directPost = (sender: string, content: unknown, byte = 9) =>
  Schema.decodeUnknownSync(InboundMessage)({
    kind: "direct",
    postId: postId(byte),
    address: sender,
    sender,
    content,
  });

/**
 * A gather request post asking `questionText` with `slotSchema` under
 * `requestNonce`.
 * @param sender The agent that authored the request.
 * @param deadlineAt The absolute deadline it states, in epoch milliseconds.
 * @param id The id it names, Bob's by default.
 * @returns The decoded inbound message.
 */
export const requestPost = (
  sender: string,
  deadlineAt: number,
  id = requestId,
) =>
  directPost(sender, [
    { type: "text", text: questionText },
    {
      type: "data",
      value: {
        [collectiveKey]: {
          kind: "operation",
          op: "gather",
          id,
          nonce: requestNonce,
          deadlineAt,
          requestedSchema: slotSchema,
        },
      },
    },
  ]);

/**
 * A response post answering the operation `id`.
 * @param sender The member that answers.
 * @param id The operation the response names.
 * @param response The action and any content.
 * @returns The decoded inbound message.
 */
export const answerPost = (sender: string, id: string, response: object) =>
  directPost(sender, [
    {
      type: "data",
      value: { [collectiveKey]: { kind: "response", id, ...response } },
    },
  ]);

/**
 * Classify one post as certified under the shared record hash.
 * @param layer The layer that classifies it.
 * @param message The post, as the store delivered it.
 * @returns The item the layer delivers, or none when it consumes the post.
 */
export const classifyPost = (
  layer: CollectiveOperations,
  message: InboundMessage,
) => layer.classify({ message, recordHash });

/**
 * Send an unvalidated input through the layer, decoding it first.
 * @param layer The layer that sends.
 * @param input The send input before decoding.
 * @param failureDelivery Where a refusal goes, the send's result by default.
 * @returns The send's outcome.
 */
export const send = (
  layer: CollectiveOperations,
  input: unknown,
  failureDelivery: FailureDelivery = "result",
) => layer.send(Schema.decodeUnknownSync(SendInput)(input), failureDelivery);

/**
 * A gather to `gatherTo` asking `questionText`.
 * @param deadline The relative deadline in seconds.
 * @param requestedSchema The schema answers must satisfy.
 * @returns The send input.
 */
export const gatherInput = (
  deadline = 60,
  requestedSchema: object = slotSchema,
) => ({
  to: gatherTo,
  text: questionText,
  collective: { op: "gather", deadline, requestedSchema },
});

/**
 * The refusal a send ends in.
 * @param effect The send, expected to fail.
 * @returns A collective failure's own value, or the send error itself.
 */
export const collectiveFailureOf = <A>(
  effect: Effect.Effect<A, SendError | CollectiveError>,
) =>
  Effect.flip(effect).pipe(
    Effect.map((error) =>
      error instanceof CollectiveError ? error.failure : error,
    ),
  );

/**
 * The operation id a completed send names; dies when it names none.
 * @param outcome What the send returned.
 * @param outcome.operationId The collective id, absent for a multicast.
 * @returns The id, for a test that goes on to answer or complete the operation.
 */
export const operationIdOf = (outcome: {
  readonly operationId?: CollectiveId;
}) =>
  Effect.fromNullable(outcome.operationId).pipe(
    Effect.orElse(() => Effect.dieMessage("the send named no operation")),
  );

/**
 * Start the gather `gatherInput` describes; dies when the send names no id.
 * @param layer The requester's layer.
 * @returns The gather's id.
 */
export const startGather = (layer: CollectiveOperations) =>
  send(layer, gatherInput()).pipe(Effect.flatMap(operationIdOf));

/**
 * The request the first recorded post carries; dies when that post carries
 * no gather or all_gather request.
 * @param observed What the layer's ports recorded.
 * @returns The request's collective value, with its id and nonce.
 */
export const firstRequestOf = (observed: Observed) =>
  Effect.fromNullable(observed.sent[0]).pipe(
    Effect.flatMap((post) => readCollectiveValue(post.content)),
    Effect.flatten,
    Effect.flatMap((value) =>
      Effect.fromNullable("nonce" in value ? value : undefined),
    ),
    Effect.orElse(() => Effect.dieMessage("the first post carries no request")),
  );
