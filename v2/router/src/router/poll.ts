import {
  InternalServerError,
  OverloadedError,
  type AgentId,
  type SignedMessage,
} from "@moltzap/v2-identity";
import canonicalize from "canonicalize";
import { Duration, Effect, Option, Schema } from "effect";
import { entriesAfter, type FeedSnapshot, type RouterFeed } from "./feed.js";
import type { HeldPolls } from "./held-polls.js";
import {
  RouterPollResult,
  type RouterPollRequest,
  type RouterPollResult as RouterPollResultValue,
} from "./operations.js";
import type { PollCursorCodec } from "./poll-cursor.js";
import type { PollCursor, RouterInstanceId } from "./values.js";

const HOLD_DURATION = Duration.seconds(25);
const utf8Encoder = new TextEncoder();

type PollFailure = OverloadedError | InternalServerError;

interface VerifiedCaller {
  readonly callerAgentId: AgentId;
}

interface PollDependencies {
  readonly routerInstanceId: RouterInstanceId;
  readonly feed: RouterFeed;
  readonly heldPolls: HeldPolls;
  readonly cursorCodec: PollCursorCodec;
  readonly pollMessageLimit: number;
  readonly pollResponseByteLimit: number;
}

interface ScanResult {
  readonly result: RouterPollResultValue;
  readonly reachedTail: boolean;
  readonly lastScannedOrder: bigint;
}

interface ScanState {
  readonly selected: readonly SignedMessage[];
  readonly lastScannedOrder: bigint;
}

const encodedResultLength = (
  result: RouterPollResultValue,
): Effect.Effect<number, InternalServerError> =>
  Schema.encode(RouterPollResult)(result).pipe(
    Effect.catchTag("ParseError", () => Effect.fail(new InternalServerError())),
    Effect.flatMap((encoded) => {
      const jcs = canonicalize(encoded);
      return jcs === undefined
        ? Effect.fail(new InternalServerError())
        : Effect.succeed(utf8Encoder.encode(jcs).byteLength);
    }),
  );

const addressedDataIsReady = (
  feed: RouterFeed,
  callerAgentId: AgentId,
  order: bigint,
): Effect.Effect<boolean> =>
  feed.snapshot.pipe(
    Effect.map(
      (snapshot) =>
        order < snapshot.greatestEvictedOrder ||
        entriesAfter(snapshot, order).some((entry) =>
          entry.recipients.has(callerAgentId),
        ),
    ),
  );

const makeBatch = (
  input: PollDependencies,
  callerAgentId: AgentId,
  signedMessages: readonly SignedMessage[],
  lastScannedOrder: bigint,
): Effect.Effect<RouterPollResultValue, InternalServerError> =>
  input.cursorCodec.encrypt({ agentId: callerAgentId, lastScannedOrder }).pipe(
    Effect.catchTag("PollCursorEncryptionError", () =>
      Effect.fail(new InternalServerError()),
    ),
    Effect.map(
      (pollCursor): RouterPollResultValue => ({
        kind: "batch",
        routerInstanceId: input.routerInstanceId,
        signedMessages,
        pollCursor,
      }),
    ),
  );

const scanEntry = (
  input: PollDependencies,
  callerAgentId: AgentId,
  state: ScanState,
  entry: FeedSnapshot["entries"][number],
): Effect.Effect<Option.Option<ScanState>, InternalServerError> => {
  if (!entry.recipients.has(callerAgentId)) {
    return Effect.succeed(
      Option.some({
        ...state,
        lastScannedOrder: entry.order,
      }),
    );
  }
  if (state.selected.length >= input.pollMessageLimit) {
    return Effect.succeed(Option.none());
  }
  const selected = [...state.selected, entry.signedMessage];
  return makeBatch(input, callerAgentId, selected, entry.order).pipe(
    Effect.flatMap(encodedResultLength),
    Effect.map((byteLength) =>
      byteLength <= input.pollResponseByteLimit
        ? Option.some({
            selected,
            lastScannedOrder: entry.order,
          })
        : Option.none(),
    ),
  );
};

const scan = (
  input: PollDependencies,
  snapshot: FeedSnapshot,
  callerAgentId: AgentId,
  startOrder: bigint,
): Effect.Effect<ScanResult, InternalServerError> =>
  Effect.gen(function* () {
    let state: ScanState = {
      selected: [],
      lastScannedOrder: startOrder,
    };
    let reachedTail = true;
    for (const entry of entriesAfter(snapshot, startOrder)) {
      const next = yield* scanEntry(input, callerAgentId, state, entry);
      if (Option.isNone(next)) {
        reachedTail = false;
        break;
      }
      state = next.value;
    }
    return {
      result: yield* makeBatch(
        input,
        callerAgentId,
        state.selected,
        state.lastScannedOrder,
      ),
      reachedTail,
      lastScannedOrder: state.lastScannedOrder,
    };
  });

const feedGap = (
  routerInstanceId: RouterInstanceId,
): RouterPollResultValue => ({
  kind: "feed_gap",
  routerInstanceId,
});

const holdAtTail = (
  input: PollDependencies,
  callerAgentId: AgentId,
  startOrder: bigint,
): Effect.Effect<void, OverloadedError> =>
  input.heldPolls
    .awaitSignal(
      callerAgentId,
      addressedDataIsReady(input.feed, callerAgentId, startOrder),
    )
    .pipe(
      Effect.raceFirst(Effect.sleep(HOLD_DURATION)),
      Effect.catchTag("HeldPollCapacityError", () =>
        Effect.fail(new OverloadedError()),
      ),
    );

const continueFromOrder = (
  input: PollDependencies,
  callerAgentId: AgentId,
  startOrder: bigint,
): Effect.Effect<RouterPollResultValue, PollFailure> =>
  Effect.gen(function* () {
    const snapshot = yield* input.feed.snapshot;
    if (startOrder > snapshot.tailOrder) {
      return { kind: "cursor_invalid" };
    }
    if (startOrder < snapshot.greatestEvictedOrder) {
      return feedGap(input.routerInstanceId);
    }
    const first = yield* scan(input, snapshot, callerAgentId, startOrder);
    const hasImmediateResult =
      first.result.kind !== "batch" ||
      first.result.signedMessages.length > 0 ||
      !first.reachedTail;
    if (hasImmediateResult) {
      return first.result;
    }
    yield* holdAtTail(input, callerAgentId, first.lastScannedOrder);
    const finalSnapshot = yield* input.feed.snapshot;
    if (first.lastScannedOrder < finalSnapshot.greatestEvictedOrder) {
      return feedGap(input.routerInstanceId);
    }
    return (yield* scan(
      input,
      finalSnapshot,
      callerAgentId,
      first.lastScannedOrder,
    )).result;
  });

const continuePoll = (
  input: PollDependencies,
  callerAgentId: AgentId,
  pollCursor: PollCursor,
): Effect.Effect<RouterPollResultValue, PollFailure> =>
  input.cursorCodec.decrypt(pollCursor, callerAgentId).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed<RouterPollResultValue>({
            kind: "cursor_invalid",
          }),
        onSome: (order) => continueFromOrder(input, callerAgentId, order),
      }),
    ),
  );

const handlePoll = (
  input: PollDependencies,
  request: RouterPollRequest,
  verifiedRequest: VerifiedCaller,
): Effect.Effect<RouterPollResultValue, PollFailure> => {
  const callerAgentId = verifiedRequest.callerAgentId;
  if (request.pollCursor !== undefined) {
    return continuePoll(input, callerAgentId, request.pollCursor);
  }
  return input.feed.snapshot.pipe(
    Effect.flatMap((snapshot) =>
      makeBatch(input, callerAgentId, [], snapshot.tailOrder),
    ),
  );
};

/** Poll domain operation after HTTP authentication. */
export interface RouterPoll {
  readonly handle: (
    request: RouterPollRequest,
    verifiedRequest: VerifiedCaller,
  ) => Effect.Effect<RouterPollResultValue, PollFailure>;
}

/**
 * Builds endpoint-wide bounded polling over one volatile global feed.
 *
 * @param input Current process state and finite poll bounds.
 * @param input.routerInstanceId Current volatile process identity.
 * @param input.feed Global volatile feed.
 * @param input.heldPolls Addressed held-poll notifications.
 * @param input.cursorCodec Caller-bound cursor codec.
 * @param input.pollMessageLimit Maximum messages in one result.
 * @param input.pollResponseByteLimit Maximum complete result bytes.
 * @returns The authenticated poll domain operation.
 */
export const makeRouterPoll = (input: PollDependencies): RouterPoll =>
  Object.freeze({
    handle: (request: RouterPollRequest, verifiedRequest: VerifiedCaller) =>
      handlePoll(input, request, verifiedRequest),
  });
