/** @file Single-ingress endpoint observation and ordered delivery. */

import { agentName } from "@moltzap/protocol/identity";
import {
  Cache,
  Cause,
  Deferred,
  Duration,
  Effect,
  ExecutionStrategy,
  Exit,
  Mailbox,
  Option,
  PubSub,
  Ref,
  Schema,
  Scope,
  Stream,
  Take,
} from "effect";
import {
  ConversationOpened,
  type endpointEvents,
  EndpointMessageReceived,
  EndpointMessageSent,
} from "../events/core.js";
import type { LedgerWriter } from "../ledger/live.js";
import {
  type Endpoint,
  makeEndpoint,
  type EndpointInbox,
  type NetworkService,
} from "../network/endpoint.js";
import {
  networkFailure,
  type AttachedEndpoint,
  type EndpointTransport,
  type NetworkFailure,
  type ParticipantIds,
  type ReceivedMessage,
  type Router,
} from "../network/router.js";

type DeliveryMailbox = Mailbox.Mailbox<ReceivedMessage, NetworkFailure>;
type EndpointEventWriter = LedgerWriter<typeof endpointEvents>;
type EndpointCache = Cache.Cache<string, Exit.Exit<Endpoint, NetworkFailure>>;

interface InboxState {
  readonly conversations: ReadonlyMap<string, DeliveryMailbox>;
  readonly exit?: Exit.Exit<void, NetworkFailure>;
}

interface InboxRuntime {
  readonly all: PubSub.PubSub<Take.Take<ReceivedMessage, NetworkFailure>>;
  readonly state: Ref.Ref<InboxState>;
  readonly transition: Effect.Semaphore;
}

function conversationStream(
  mailbox: DeliveryMailbox,
): Stream.Stream<ReceivedMessage, NetworkFailure> {
  return Stream.repeatEffectOption(
    mailbox.take.pipe(
      Effect.mapError((error) =>
        Cause.isNoSuchElementException(error)
          ? Option.none()
          : Option.some(error),
      ),
    ),
  );
}

function terminalStream(
  exit: Exit.Exit<void, NetworkFailure>,
): Stream.Stream<ReceivedMessage, NetworkFailure> {
  return Exit.isSuccess(exit) ? Stream.empty : Stream.failCause(exit.cause);
}

function endpointMessages(
  runtime: InboxRuntime,
): Stream.Stream<ReceivedMessage, NetworkFailure> {
  return Stream.unwrapScoped(
    runtime.transition.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(runtime.state);
        if (state.exit !== undefined) {
          return terminalStream(state.exit);
        }
        const subscription = yield* PubSub.subscribe(runtime.all);
        return Stream.fromQueue(subscription).pipe(Stream.flattenTake);
      }),
    ),
  );
}

function addressedIds(
  endpointId: ParticipantIds[number],
  participants: ParticipantIds,
): ParticipantIds {
  const unique = new Set(participants);
  unique.delete(endpointId);
  return [endpointId, ...unique];
}

function conversationKey(
  taskId: ReceivedMessage["taskId"],
  conversationId: ReceivedMessage["message"]["conversationId"],
): string {
  return `${taskId}/${conversationId}`;
}

function publish(
  runtime: InboxRuntime,
  received: ReceivedMessage,
): Effect.Effect<void> {
  return runtime.transition.withPermits(1)(
    Effect.gen(function* () {
      const state = yield* Ref.get(runtime.state);
      if (state.exit !== undefined) {
        return;
      }
      yield* PubSub.publish(runtime.all, Take.of(received));
      const key = conversationKey(
        received.taskId,
        received.message.conversationId,
      );
      let conversation = state.conversations.get(key);
      if (conversation === undefined) {
        conversation = yield* Mailbox.make<ReceivedMessage, NetworkFailure>();
        const conversations = new Map(state.conversations);
        conversations.set(key, conversation);
        yield* Ref.set(runtime.state, {
          ...state,
          conversations,
        });
      }
      yield* conversation.offer(received);
    }).pipe(Effect.uninterruptible),
  );
}

function finish(
  runtime: InboxRuntime,
  exit: Exit.Exit<void, NetworkFailure>,
): Effect.Effect<void> {
  return runtime.transition.withPermits(1)(
    Effect.gen(function* () {
      const state = yield* Ref.get(runtime.state);
      if (state.exit !== undefined) {
        return;
      }
      yield* Ref.set(runtime.state, { ...state, exit });
      yield* PubSub.publish(
        runtime.all,
        Exit.isSuccess(exit) ? Take.end : Take.failCause(exit.cause),
      );
      yield* Effect.forEach(
        state.conversations.values(),
        (mailbox) => mailbox.done(exit),
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.uninterruptible),
  );
}

function conversation(runtime: InboxRuntime): EndpointInbox["conversation"] {
  return (taskId, conversationId) =>
    runtime.transition.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(runtime.state);
        const key = conversationKey(taskId, conversationId);
        const existing = state.conversations.get(key);
        if (existing !== undefined) {
          return conversationStream(existing);
        }
        const mailbox = yield* Mailbox.make<ReceivedMessage, NetworkFailure>();
        if (state.exit !== undefined) {
          yield* mailbox.done(state.exit);
        } else {
          const conversations = new Map(state.conversations);
          conversations.set(key, mailbox);
          yield* Ref.set(runtime.state, {
            ...state,
            conversations,
          });
        }
        return conversationStream(mailbox);
      }),
    );
}

function runIngress<Name extends string>(
  attachment: AttachedEndpoint<Name>,
  writer: EndpointEventWriter,
  runtime: InboxRuntime,
  received: Stream.Stream<ReceivedMessage, NetworkFailure>,
) {
  return received.pipe(
    Stream.runForEach((received) =>
      writer
        .write({
          event: EndpointMessageReceived.make({
            endpointId: attachment.participant.id,
            taskId: received.taskId,
            conversationId: received.message.conversationId,
            messageId: received.message.id,
            senderId: received.message.senderId,
            parts: received.message.parts,
          }),
        })
        .pipe(
          Effect.zipRight(publish(runtime, received)),
          Effect.catchAll(() => Effect.interrupt),
        ),
    ),
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.isInterruptedOnly(cause)
          ? Effect.void
          : finish(runtime, Exit.failCause(cause)),
      onSuccess: () => finish(runtime, Exit.void),
    }),
  );
}

function makeInbox<Name extends string>(
  attachment: AttachedEndpoint<Name>,
  writer: EndpointEventWriter,
): Effect.Effect<EndpointInbox, never, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime: InboxRuntime = {
      all:
        yield* PubSub.unbounded<Take.Take<ReceivedMessage, NetworkFailure>>(),
      state: yield* Ref.make<InboxState>({
        conversations: new Map(),
        exit: undefined,
      }),
      transition: yield* Effect.makeSemaphore(1),
    };
    const ingressStarted = yield* Deferred.make<undefined>();
    const received = attachment.transport.received.pipe(
      Stream.onStart(Deferred.succeed(ingressStarted, undefined)),
    );
    yield* Effect.addFinalizer(() => finish(runtime, Exit.void));
    yield* runIngress(attachment, writer, runtime, received).pipe(
      Effect.forkScoped,
    );
    // Router attachments buffer from acquisition; this handshake starts the
    // kernel's single consumer before the observed endpoint escapes.
    yield* Deferred.await(ingressStarted);
    return Object.freeze({
      messages: endpointMessages(runtime),
      conversation: conversation(runtime),
    });
  });
}

function openConversation<Name extends string>(
  attachment: AttachedEndpoint<Name>,
  writer: EndpointEventWriter,
): EndpointTransport["openConversation"] {
  return (participants) =>
    attachment.transport.openConversation(participants).pipe(
      Effect.flatMap((opened) =>
        writer
          .write({
            event: ConversationOpened.make({
              openedBy: attachment.participant.id,
              taskId: opened.taskId,
              conversationId: opened.conversationId,
              participants: addressedIds(
                attachment.participant.id,
                participants,
              ),
            }),
          })
          .pipe(
            Effect.as(opened),
            Effect.orElseSucceed(() => opened),
          ),
      ),
    );
}

function send<Name extends string>(
  attachment: AttachedEndpoint<Name>,
  writer: EndpointEventWriter,
): EndpointTransport["send"] {
  return (taskId, conversationId, parts) =>
    attachment.transport.send(taskId, conversationId, parts).pipe(
      Effect.flatMap((message) =>
        writer
          .write({
            event: EndpointMessageSent.make({
              endpointId: attachment.participant.id,
              taskId,
              conversationId,
              messageId: message.id,
              parts: message.parts,
            }),
          })
          .pipe(
            Effect.as(message),
            Effect.orElseSucceed(() => message),
          ),
      ),
    );
}

function observeAttachment<Name extends string>(
  attachment: AttachedEndpoint<Name>,
  writer: EndpointEventWriter,
): Effect.Effect<Endpoint<Name>, never, Scope.Scope> {
  return makeInbox(attachment, writer).pipe(
    Effect.map((inbox) =>
      makeEndpoint(
        {
          participant: attachment.participant,
          transport: {
            received: inbox.messages,
            openConversation: openConversation(attachment, writer),
            send: send(attachment, writer),
          },
        },
        inbox,
      ),
    ),
  );
}

function acquireEndpoint(
  router: Router,
  writer: EndpointEventWriter,
  runScope: Scope.Scope,
  name: string,
): Effect.Effect<Exit.Exit<Endpoint, NetworkFailure>> {
  const acquire = Schema.decodeUnknown(agentName)(name).pipe(
    Effect.mapError((cause) => networkFailure("attach-endpoint", cause)),
    Effect.flatMap((agentName) => router.attachEndpoint(name, agentName)),
    Effect.flatMap((attachment) => observeAttachment(attachment, writer)),
  );
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const attemptScope = yield* Scope.fork(
        runScope,
        ExecutionStrategy.sequential,
      );
      const exit = yield* restore(
        acquire.pipe(Scope.extend(attemptScope)),
      ).pipe(Effect.exit);
      if (Exit.isFailure(exit)) {
        yield* Scope.close(attemptScope, exit);
      }
      return exit;
    }),
  );
}

function cachedEndpoint<const Name extends string>(
  endpoints: EndpointCache,
  name: Name,
): Effect.Effect<Endpoint<Name>, NetworkFailure> {
  return /* Safe because the surrounding invariant establishes this asserted shape. */ Effect.uninterruptibleMask(
    (restore) =>
      restore(endpoints.get(name)).pipe(
        Effect.flatMap((exit) =>
          endpoints.invalidateWhen(name, Exit.isFailure).pipe(Effect.as(exit)),
        ),
        Effect.flatten,
      ),
  ) as Effect.Effect<Endpoint<Name>, NetworkFailure>;
}

/**
 * Creates network service.
 * @param router Value supplied to the operation.
 * @param writer Value supplied to the operation.
 * @returns The created network service.
 */
export function makeNetworkService(
  router: Router,
  writer: EndpointEventWriter,
): Effect.Effect<NetworkService, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const endpoints = yield* Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (name: string) => acquireEndpoint(router, writer, scope, name),
      timeToLive: Duration.infinity,
    });
    return {
      endpoint: <const Name extends string>(name: Name) =>
        cachedEndpoint(endpoints, name),
    };
  }).pipe(Effect.withSpan("makeNetworkService"));
}
