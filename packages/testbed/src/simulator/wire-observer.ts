/**
 * @file In-band observation of the society's messages through the run's
 * own principal connections.
 *
 * The principal is already a participant of every conversation the
 * episode creates, so subscribing its existing client to
 * `agent/message/received` gives the run its control signal without
 * adding a participant the agents under test can see. An observer
 * identity would perturb the society; that is why this rides the
 * principal's connection rather than a second one.
 *
 * The observer never writes `MessageLog`. It enqueues one `wire.message`
 * per notification and the episode's single observing writer records it,
 * so record-then-evaluate holds for the in-band channel.
 *
 * ```mermaid
 * flowchart LR
 *   POOL[principal pool] -->|clientHooks| CLIENT[MoltZapAgentClient]
 *   CLIENT -->|attach| SUB[agent/message/received]
 *   SUB --> ENQ[wire.message live]
 *   POOL -->|track receipt| CHAN[tracked channel + high-water mark]
 *   CLIENT -->|onReconnect| REC[agent/message/list]
 *   CHAN --> REC
 *   REC --> ENQ2[wire.message recovery]
 *   REC -->|page misses the mark| FAIL[WireRecoveryTruncated]
 * ```
 */
// safer-arch-ignore file-implicit-boundary-module: an implementation peer of episode-live.ts under the composition root, not a facade; it exports one factory and the interface that factory returns, the composition root is its only constructor, and the failures it raises live in the closed InfraError kernel rather than here.
import {
  Deferred,
  Effect,
  Option,
  Queue,
  Schema,
  Stream,
  type Scope,
} from "effect";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import {
  MessageReceivedNotificationDefinition,
  MessagesList,
  type Message,
} from "@moltzap/protocol/message";
import type {
  CloseInfo,
  ConnectResult,
  MoltZapAgentClient,
} from "@moltzap/protocol/socket";
import type { TaskId } from "@moltzap/protocol/task";
import { wallTimeNow } from "./ids.js";
import type { EventLog } from "./event-log.js";
import { JsonValue, type PrincipalName } from "./run-spec.js";
import type { SpeechReceipt } from "./episode.js";
import { WireObservationLost, WireRecoveryTruncated } from "./errors.js";

/**
 * Subscribes the run's own connections to `agent/message/received` and
 * enqueues one `wire.message` per notification. The observer owns a
 * `Scope` captured at construction, so neither `attach` nor `track`
 * pushes a scope requirement into `Principal.deliver`.
 */
export type WireObserver = {
  /**
   * Callbacks the principal pool passes to `new MoltZapAgentClient`.
   * Reconnect is a constructor concern: `AgentClientOptions` accepts these
   * only at construction, and a notification subscription survives an
   * automatic reconnect rather than ending, so a gap is undetectable from
   * the stream alone.
   */
  clientHooks(principal: PrincipalName): {
    readonly onDisconnect: (close: CloseInfo) => void;
    readonly onReconnect: (helloOk: ConnectResult) => void;
  };

  /**
   * Begin observing one connected client, resolving as close to
   * registration as the client surface allows.
   *
   * It cannot resolve *on* registration: `notificationSubscribe` registers
   * inside `Stream.async`'s constructor, which runs when the stream runs,
   * and `subscribe` hands back only the stream — no handle, no
   * post-registration signal. The residual window is one fiber schedule,
   * and the only message that could land in it is a reply to a step that
   * has not been sent yet, because attach precedes the first send.
   */
  attach(
    principal: PrincipalName,
    client: MoltZapAgentClient,
  ): Effect.Effect<void, never, never>;

  /**
   * Record a conversation this run speaks into, and anchor recovery in it.
   * Recovery lists per conversation, and the notification stream never
   * names a conversation the run created, because the principal's own send
   * is suppressed on its own connection — so both the channel and the
   * first high-water mark have to come from the receipt.
   */
  track(
    principal: PrincipalName,
    receipt: SpeechReceipt,
  ): Effect.Effect<void, never, never>;

  /** Long-lived failure channel; raced alongside the episode. */
  awaitFailure(): Effect.Effect<
    never,
    WireObservationLost | WireRecoveryTruncated,
    never
  >;
};

/** One conversation the run speaks into, plus the newest message it has seen there. */
type TrackedChannel = {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  lastObservedMessageId: MessageId;
};

type ObserverState = {
  readonly log: EventLog;
  readonly recoveryLimit: number;
  readonly failure: Deferred.Deferred<
    never,
    WireObservationLost | WireRecoveryTruncated
  >;
  readonly reconnects: Queue.Queue<PrincipalName>;
  readonly clients: Map<PrincipalName, MoltZapAgentClient>;
  readonly channels: Map<PrincipalName, Map<ConversationId, TrackedChannel>>;
  /** Principals whose connection dropped; only these have a gap to recover. */
  readonly disconnected: Set<PrincipalName>;
  /** Principals with a recovery already queued or running; one at a time each. */
  readonly recovering: Set<PrincipalName>;
};

export function makeWireObserver(deps: {
  readonly log: EventLog;
  /** Newest-N window used for reconnect backfill. */
  readonly recoveryLimit: number;
}): Effect.Effect<WireObserver, never, Scope.Scope> {
  return Effect.gen(function* () {
    // The run's scope, held for the lifetime of the observer: `attach`
    // forks into it long after this effect returned, and neither it nor
    // `track` may push a scope requirement into `Principal.deliver`.
    const scope = yield* Effect.scope;
    const state: ObserverState = {
      log: deps.log,
      recoveryLimit: deps.recoveryLimit,
      failure: yield* Deferred.make<
        never,
        WireObservationLost | WireRecoveryTruncated
      >(),
      reconnects: yield* Queue.unbounded<PrincipalName>(),
      clients: new Map(),
      channels: new Map(),
      disconnected: new Set(),
      recovering: new Set(),
    };
    yield* Effect.forkIn(recoveryLoop(state), scope);
    const observer: WireObserver = {
      clientHooks: (principal) => hooksFor(state, principal),
      attach: (principal, client) => attachOne(state, scope, principal, client),
      track: (principal, receipt) =>
        Effect.sync(() => trackChannel(state, principal, receipt)),
      awaitFailure: () => Deferred.await(state.failure),
    };
    return observer;
  }).pipe(Effect.withSpan("makeWireObserver"));
}

function hooksFor(
  state: ObserverState,
  principal: PrincipalName,
): ReturnType<WireObserver["clientHooks"]> {
  return {
    onDisconnect: () => {
      state.disconnected.add(principal);
    },
    onReconnect: () => {
      // A reconnect with no preceding drop has no gap behind it; only a
      // connection that actually lost frames needs the backfill.
      if (!state.disconnected.delete(principal)) return;
      // One recovery per principal at a time. A flapping connection would
      // otherwise queue a full per-conversation `agent/message/list` sweep
      // per flap, and each sweep re-reads the same window; the pending one
      // already covers everything a later flap would ask for.
      if (state.recovering.has(principal)) return;
      state.recovering.add(principal);
      Queue.unsafeOffer(state.reconnects, principal);
    },
  };
}

// ---------------------------------------------------------------------------
// Live observation
// ---------------------------------------------------------------------------

function attachOne(
  state: ObserverState,
  scope: Scope.Scope,
  principal: PrincipalName,
  client: MoltZapAgentClient,
): Effect.Effect<void, never, never> {
  return Effect.sync(() => {
    state.clients.set(principal, client);
  }).pipe(
    Effect.zipRight(
      Effect.forkIn(observeConnection(state, principal, client), scope),
    ),
    // The forked fiber registers the subscriber when it runs the stream;
    // yielding hands it the scheduler before the caller's first send.
    Effect.zipRight(Effect.yieldNow()),
  );
}

/**
 * The subscription is long-lived by contract: it survives an automatic
 * reconnect and only ends when the client closes. So an end is a lost
 * channel, and the run says so rather than waiting out its inactivity
 * bound on a connection that stopped reporting.
 */
function observeConnection(
  state: ObserverState,
  principal: PrincipalName,
  client: MoltZapAgentClient,
): Effect.Effect<void, never, never> {
  return Stream.runForEach(
    client.subscribe(MessageReceivedNotificationDefinition),
    (params) =>
      enqueueWire(state, {
        principal,
        observation: "live",
        taskId: params.taskId,
        message: params.message,
      }),
  ).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        observationLost(
          state,
          principal,
          `the notification subscription failed: ${cause.message}`,
        ),
      onSuccess: () =>
        observationLost(state, principal, "the notification stream ended"),
    }),
  );
}

function observationLost(
  state: ObserverState,
  principal: PrincipalName,
  detail: string,
): Effect.Effect<void, never, never> {
  return Deferred.fail(
    state.failure,
    new WireObservationLost({
      principal,
      detail,
      message: `The in-band observation channel for principal "${principal}" ended before the run did: ${detail}. Episode completion is decided from the messages this connection reports, so the run seals failed rather than reading silence as an unanswered society.`,
    }),
  ).pipe(Effect.asVoid);
}

/** One message as the observer learned of it, and how. */
type Observation = {
  readonly principal: PrincipalName;
  readonly observation: "live" | "recovery";
  readonly taskId: TaskId;
  readonly message: Message;
};

function enqueueWire(
  state: ObserverState,
  { principal, observation, taskId, message }: Observation,
): Effect.Effect<void, never, never> {
  return state.log
    .enqueue({
      _tag: "wire.message",
      source: "wire",
      wallTime: wallTimeNow(),
      observedBy: principal,
      observation,
      messageId: message.id,
      conversationId: message.conversationId,
      taskId,
      senderId: message.senderId,
      // An absent optional stays absent: an explicit `undefined` is
      // outside the JSON value space the event line is serialized in.
      ...(message.replyToId === undefined
        ? {}
        : { replyToId: message.replyToId }),
      parts: partsJson(message.parts),
      createdAt: message.createdAt,
    })
    .pipe(
      Effect.tap(() =>
        Effect.sync(() => advanceHighWater(state, principal, message)),
      ),
      Effect.asVoid,
      // A sealed log means the run is already shutting down; the observer
      // treats it as the end of observation, never as an error of its own.
      Effect.catchTag("EventLogSealed", () => Effect.void),
    );
}

/** Conversations a reconnecting connection backfills at once. */
const RECOVERY_CONCURRENCY = 4;

const decodeJsonValue = Schema.decodeUnknownOption(JsonValue);

/**
 * Parts arrive already decoded against the protocol's part schema, which
 * lives inside the JSON value space. `null` marks the shape this reader
 * cannot represent rather than dropping the message that carried it.
 */
function partsJson(parts: unknown): JsonValue {
  return Option.getOrElse(decodeJsonValue(parts), (): JsonValue => null);
}

// ---------------------------------------------------------------------------
// Tracked channels and reconnect recovery
// ---------------------------------------------------------------------------

/**
 * The receipt is the newest commit the run knows of in that conversation,
 * so it is the tightest anchor available. A mark that lags reality only
 * widens the backfill, and `MessageLog` collapses the overlap by message
 * id; a mark that runs ahead of it would skip evidence.
 */
function trackChannel(
  state: ObserverState,
  principal: PrincipalName,
  receipt: SpeechReceipt,
): void {
  channelsOf(state, principal).set(receipt.conversationId, {
    taskId: receipt.taskId,
    conversationId: receipt.conversationId,
    lastObservedMessageId: receipt.message.id,
  });
}

function advanceHighWater(
  state: ObserverState,
  principal: PrincipalName,
  message: Message,
): void {
  const channel = channelsOf(state, principal).get(message.conversationId);
  if (channel === undefined) return;
  channel.lastObservedMessageId = message.id;
}

function channelsOf(
  state: ObserverState,
  principal: PrincipalName,
): Map<ConversationId, TrackedChannel> {
  const existing = state.channels.get(principal);
  if (existing !== undefined) return existing;
  const created = new Map<ConversationId, TrackedChannel>();
  state.channels.set(principal, created);
  return created;
}

function recoveryLoop(state: ObserverState): Effect.Effect<void, never, never> {
  return Queue.take(state.reconnects).pipe(
    Effect.flatMap((principal) => recoverPrincipal(state, principal)),
    Effect.forever,
  );
}

function recoverPrincipal(
  state: ObserverState,
  principal: PrincipalName,
): Effect.Effect<void, never, never> {
  const client = state.clients.get(principal);
  if (client === undefined) return Effect.void;
  // Conversations recover independently and the run is blind to the gap
  // until they all have, so they overlap; order matters only within one
  // conversation, which `backfill` keeps. The bound is the connection's,
  // not the conversation count's: a reconnecting client should not open
  // its recovery with an unbounded burst.
  return Effect.forEach(
    [...channelsOf(state, principal).values()],
    (channel) => recoverChannel(state, principal, client, channel),
    { concurrency: RECOVERY_CONCURRENCY, discard: true },
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        state.recovering.delete(principal);
      }),
    ),
  );
}

function recoverChannel(
  state: ObserverState,
  principal: PrincipalName,
  client: MoltZapAgentClient,
  channel: TrackedChannel,
): Effect.Effect<void, never, never> {
  // The anchor is read before the page is asked for, not after it comes
  // back. A live notification arriving while the list is in flight moves
  // the mark to a message the server had not committed when it built the
  // page, and reading the mark afterwards would report a gap wider than
  // the window over a conversation that lost nothing.
  return Effect.suspend(() => {
    const anchoredAt = channel.lastObservedMessageId;
    return client
      .callDefinition(MessagesList, {
        taskId: channel.taskId,
        conversationId: channel.conversationId,
        limit: state.recoveryLimit,
      })
      .pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            observationLost(
              state,
              principal,
              `reconnect backfill of conversation ${channel.conversationId} could not be read: ${cause.message}`,
            ),
          onSuccess: (page) =>
            backfill(state, { principal, channel, anchoredAt }, page.messages),
        }),
      );
  });
}

/**
 * Reaching back past the last message the run already observed is the
 * recovery condition, not page fullness: a conversation holding the whole
 * window none of which was missed is not truncated, and failing on a full
 * page alone would fail those runs for nothing. `agent/message/list`
 * returns newest-N oldest-first with no cursor, so nothing in the reply
 * says whether history exists behind the page; the high-water mark is the
 * only thing that can tell.
 */
function backfill(
  state: ObserverState,
  recovery: {
    readonly principal: PrincipalName;
    readonly channel: TrackedChannel;
    /** The mark as it stood before the page was asked for. */
    readonly anchoredAt: MessageId;
  },
  messages: ReadonlyArray<Message>,
): Effect.Effect<void, never, never> {
  const { principal, channel, anchoredAt } = recovery;
  const anchor = messages.findIndex((message) => message.id === anchoredAt);
  if (anchor < 0) {
    return Deferred.fail(
      state.failure,
      new WireRecoveryTruncated({
        principal,
        conversationId: channel.conversationId,
        windowLimit: state.recoveryLimit,
        lastObservedMessageId: anchoredAt,
        message: `Reconnect backfill for principal "${principal}" read the newest ${String(state.recoveryLimit)} messages of conversation ${channel.conversationId} and none of them is the last message the run observed, so the gap is wider than the window and the recording would be missing messages it cannot name. Raise the conversation's traffic bound or shorten the run.`,
      }),
    ).pipe(Effect.asVoid);
  }
  return Effect.forEach(
    messages.slice(anchor + 1),
    (message) =>
      enqueueWire(state, {
        principal,
        observation: "recovery",
        taskId: channel.taskId,
        message,
      }),
    { concurrency: 1, discard: true },
  );
}
