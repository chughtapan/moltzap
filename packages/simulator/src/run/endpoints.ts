/** @file Run-owned controlled endpoint acquisition and semantic turn inboxes. */

import type { ConversationId, HarnessTurn } from "@moltzap/client";
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
  Scope,
  Stream,
  Take,
} from "effect";
import type { InboundLinkInterceptor } from "./link-fabric.js";
import {
  type AttachedEndpoint,
  type Endpoint,
  type EndpointInbox,
  makeEndpoint,
  type NetworkError,
  type NetworkService,
} from "../network/index.js";

// safer-arch-ignore no-cross-domain-sibling-import: The run kernel binds private cluster acquisition, link registration, and the public endpoint facade.

type TurnMailbox = Mailbox.Mailbox<HarnessTurn, NetworkError>;
type EndpointCache = Cache.Cache<string, Exit.Exit<Endpoint, NetworkError>>;

interface InboxState {
  readonly conversations: ReadonlyMap<string, TurnMailbox>;
  readonly exit?: Exit.Exit<void, NetworkError>;
}

interface InboxRuntime {
  readonly all: PubSub.PubSub<Take.Take<HarnessTurn, NetworkError>>;
  readonly state: Ref.Ref<InboxState>;
  readonly transition: Effect.Semaphore;
}

/** Private platform acquisition used by the run-owned Network service. */
export type AcquireControlledEndpoint = <const Name extends string>(input: {
  readonly name: Name;
  readonly routerOrigin: URL;
}) => Effect.Effect<AttachedEndpoint<Name>, NetworkError, Scope.Scope>;

/**
 * Build one cached Network service over the platform's controlled-daemon seam.
 * Receiver registration authorizes link policies; delivery shaping itself is
 * performed once by the shared post-Router proxy before the daemon consumes it.
 * @param input Endpoint acquisition, proxy origin, and receiver registration.
 * @param input.acquireEndpoint Scoped production-daemon acquisition.
 * @param input.routerOrigin Shared post-Router proxy origin.
 * @param input.interceptor Link-fabric receiver registration.
 * @returns The run-scoped Network service.
 */
export function makeNetworkService(input: {
  readonly acquireEndpoint: AcquireControlledEndpoint;
  readonly routerOrigin: URL;
  readonly interceptor: InboundLinkInterceptor;
}): Effect.Effect<NetworkService, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const endpoints = yield* Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (name: string) =>
        acquireEndpoint(
          {
            acquireEndpoint: input.acquireEndpoint,
            routerOrigin: input.routerOrigin,
            interceptor: input.interceptor,
            scope,
          },
          name,
        ),
      timeToLive: Duration.infinity,
    });
    return Object.freeze({
      endpoint: <const Name extends string>(name: Name) =>
        cachedEndpoint(endpoints, name),
    });
  }).pipe(Effect.withSpan("makeNetworkService"));
}

function conversationStream(
  mailbox: TurnMailbox,
): Stream.Stream<HarnessTurn, NetworkError> {
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
  exit: Exit.Exit<void, NetworkError>,
): Stream.Stream<HarnessTurn, NetworkError> {
  return Exit.isSuccess(exit) ? Stream.empty : Stream.failCause(exit.cause);
}

function endpointMessages(
  runtime: InboxRuntime,
): Stream.Stream<HarnessTurn, NetworkError> {
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

function publish(
  runtime: InboxRuntime,
  turn: HarnessTurn,
): Effect.Effect<void> {
  return runtime.transition.withPermits(1)(
    Effect.gen(function* () {
      const state = yield* Ref.get(runtime.state);
      if (state.exit !== undefined) {
        return;
      }
      yield* PubSub.publish(runtime.all, Take.of(turn));
      const key = turn.conversationId;
      let conversation = state.conversations.get(key);
      if (conversation === undefined) {
        conversation = yield* Mailbox.make<HarnessTurn, NetworkError>();
        const conversations = new Map(state.conversations);
        conversations.set(key, conversation);
        yield* Ref.set(runtime.state, { ...state, conversations });
      }
      yield* conversation.offer(turn);
    }).pipe(Effect.uninterruptible),
  );
}

function finish(
  runtime: InboxRuntime,
  exit: Exit.Exit<void, NetworkError>,
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
  return (conversationId: ConversationId) =>
    runtime.transition.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(runtime.state);
        const existing = state.conversations.get(conversationId);
        if (existing !== undefined) {
          return conversationStream(existing);
        }
        const mailbox = yield* Mailbox.make<HarnessTurn, NetworkError>();
        if (state.exit !== undefined) {
          yield* mailbox.done(state.exit);
        } else {
          const conversations = new Map(state.conversations);
          conversations.set(conversationId, mailbox);
          yield* Ref.set(runtime.state, { ...state, conversations });
        }
        return conversationStream(mailbox);
      }),
    );
}

function runIngress(
  runtime: InboxRuntime,
  received: Stream.Stream<HarnessTurn, NetworkError>,
) {
  return received.pipe(
    Stream.runForEach((turn) => publish(runtime, turn)),
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
): Effect.Effect<EndpointInbox, never, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime: InboxRuntime = {
      all: yield* PubSub.unbounded<Take.Take<HarnessTurn, NetworkError>>(),
      state: yield* Ref.make<InboxState>({ conversations: new Map() }),
      transition: yield* Effect.makeSemaphore(1),
    };
    const ingressStarted = yield* Deferred.make<undefined>();
    const received = attachment.transport.received.pipe(
      Stream.onStart(Deferred.succeed(ingressStarted, undefined)),
    );
    yield* Effect.addFinalizer(() => finish(runtime, Exit.void));
    yield* runIngress(runtime, received).pipe(Effect.forkScoped);
    yield* Deferred.await(ingressStarted);
    return Object.freeze({
      messages: endpointMessages(runtime),
      conversation: conversation(runtime),
    });
  });
}

interface EndpointAcquisitionContext {
  readonly acquireEndpoint: AcquireControlledEndpoint;
  readonly routerOrigin: URL;
  readonly interceptor: InboundLinkInterceptor;
  readonly scope: Scope.Scope;
}

function acquireEndpoint(
  context: EndpointAcquisitionContext,
  name: string,
): Effect.Effect<Exit.Exit<Endpoint, NetworkError>> {
  const acquire = context
    .acquireEndpoint({ name, routerOrigin: context.routerOrigin })
    .pipe(
      Effect.tap((attachment) =>
        context.interceptor.attach(attachment.participant.id),
      ),
      Effect.flatMap((attachment) =>
        makeInbox(attachment).pipe(
          Effect.map((inbox) => makeEndpoint(attachment, inbox)),
        ),
      ),
    );
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const attemptScope = yield* Scope.fork(
        context.scope,
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
): Effect.Effect<Endpoint<Name>, NetworkError> {
  return /* Safe because the cache key is the exact endpoint name captured by the acquisition that creates its nominal participant handle. */ Effect.uninterruptibleMask(
    (restore) => restore(endpoints.get(name)).pipe(Effect.flatten),
  ) as Effect.Effect<Endpoint<Name>, NetworkError>;
}
