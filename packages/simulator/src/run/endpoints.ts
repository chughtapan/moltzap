/** @file Run-owned controlled endpoint acquisition and addressed delivery inboxes. */

import type { InboundDelivery } from "@moltzap/client";
import {
  Cache,
  Cause,
  Deferred,
  Duration,
  Effect,
  ExecutionStrategy,
  Exit,
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

type EndpointCache = Cache.Cache<string, Exit.Exit<Endpoint, NetworkError>>;

interface InboxState {
  readonly exit?: Exit.Exit<void, NetworkError>;
}

interface InboxRuntime {
  readonly all: PubSub.PubSub<Take.Take<InboundDelivery, NetworkError>>;
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

function terminalStream(
  exit: Exit.Exit<void, NetworkError>,
): Stream.Stream<InboundDelivery, NetworkError> {
  return Exit.isSuccess(exit) ? Stream.empty : Stream.failCause(exit.cause);
}

function endpointMessages(
  runtime: InboxRuntime,
): Stream.Stream<InboundDelivery, NetworkError> {
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
  delivery: InboundDelivery,
): Effect.Effect<void> {
  return runtime.transition.withPermits(1)(
    Effect.gen(function* () {
      const state = yield* Ref.get(runtime.state);
      if (state.exit !== undefined) {
        return;
      }
      yield* PubSub.publish(runtime.all, Take.of(delivery));
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
    }).pipe(Effect.uninterruptible),
  );
}

function runIngress(
  runtime: InboxRuntime,
  received: Stream.Stream<InboundDelivery, NetworkError>,
) {
  return received.pipe(
    Stream.runForEach((delivery) => publish(runtime, delivery)),
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
      all: yield* PubSub.unbounded<Take.Take<InboundDelivery, NetworkError>>(),
      state: yield* Ref.make<InboxState>({}),
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
