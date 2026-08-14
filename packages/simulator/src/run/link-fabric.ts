/** @file In-process directed-link policy storage and delivery interpreter. */

import type { AgentId, SignedMessage } from "@moltzap/identity";
import {
  Cause,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  GroupBy,
  Mailbox,
  Option,
  Ref,
  type Scope,
  Stream,
} from "effect";
import {
  type LinkDelivery,
  type LinkDriverService,
  linkPolicy,
  type LinkPolicy,
  type LinkPolicyLease,
  linkVerdict,
  type LinkVerdict,
  networkError,
  type NetworkError,
  type NetworkOperation,
} from "../network/index.js";

/* eslint-disable max-lines-per-function, max-params, max-statements, sonarjs/max-lines-per-function, sonarjs/no-nested-functions -- The private delivery interpreter keeps each semaphore-protected state transition beside the lane outcome that owns it. */

/**
 * Registers in-process receivers with the link fabric. Acquiring `attach`
 * makes a receiver a valid policy target. Releasing the acquisition scope
 * removes the registration.
 */
export interface InboundLinkInterceptor {
  readonly attach: (to: AgentId) => Effect.Effect<void, never, Scope.Scope>;
}

/** A delivery retained by the run controller until its policy lets it pass. */
export interface RoutedLinkDelivery {
  readonly message: SignedMessage;
}

/** Driver and receiver-registration faces of one in-process link fabric. */
export interface LinkFabric {
  readonly driver: LinkDriverService;
  readonly interceptor: InboundLinkInterceptor;
  /** Whether active or retained fault work requires response interception. */
  readonly needsInterception: (to: AgentId) => Effect.Effect<boolean>;
  /** Route one batch through persistent per-sender lanes. */
  readonly route: (
    to: AgentId,
    deliveries: readonly RoutedLinkDelivery[],
  ) => Effect.Effect<readonly RoutedLinkDelivery[], NetworkError>;
  /** Drain every delivery whose active fault policy currently lets it pass. */
  readonly drain: (
    to: AgentId,
  ) => Effect.Effect<readonly RoutedLinkDelivery[], NetworkError>;
  /** Discard retained deliveries when the upstream Router generation changes. */
  readonly reset: (to: AgentId) => Effect.Effect<void, NetworkError>;
}

/**
 * Creates one state-neutral in-process link fabric.
 * @param serialization Optional private serializer shared by a composition.
 * @returns The fabric's driver and receiver-registration faces.
 */
export function makeLinkFabric(
  serialization?: Effect.Semaphore,
): Effect.Effect<LinkFabric> {
  return Effect.gen(function* () {
    const state: FabricState = {
      receivers: yield* Ref.make<ReadonlySet<AgentId>>(new Set()),
      policies: yield* Ref.make<ReadonlyMap<string, readonly ActivePolicy[]>>(
        new Map(),
      ),
      routes: yield* Ref.make<ReadonlyMap<AgentId, ReceiverRoute>>(new Map()),
      disables: yield* Ref.make<ReadonlyMap<string, ActivePolicy>>(new Map()),
      transition: serialization ?? (yield* Effect.makeSemaphore(1)),
    };
    return Object.freeze({
      driver: Object.freeze({
        disable: disable(state),
        enable: enable(state),
        apply: apply(state),
      }),
      interceptor: Object.freeze({
        attach: attach(state),
      }),
      route: route(state),
      drain: drain(state),
      needsInterception: needsInterception(state),
      reset: reset(state),
    });
  }).pipe(Effect.withSpan("makeLinkFabric"));
}

interface ActivePolicy {
  readonly policy: LinkPolicy;
  /** Completed exactly when the installing lease clears. */
  readonly cleared: Deferred.Deferred<undefined>;
}

interface InstalledPolicy {
  readonly active: ActivePolicy;
  readonly lease: LinkPolicyLease;
}

interface FabricState {
  readonly receivers: Ref.Ref<ReadonlySet<AgentId>>;
  readonly policies: Ref.Ref<ReadonlyMap<string, readonly ActivePolicy[]>>;
  readonly routes: Ref.Ref<ReadonlyMap<AgentId, ReceiverRoute>>;
  readonly disables: Ref.Ref<ReadonlyMap<string, ActivePolicy>>;
  readonly transition: Effect.Semaphore;
}

interface ReceiverRoute {
  readonly closed: Deferred.Deferred<never, NetworkError>;
  readonly input: Mailbox.Mailbox<PendingRouteDelivery>;
  readonly output: Mailbox.Mailbox<PendingRouteDelivery>;
  readonly pending: Ref.Ref<number>;
  readonly epoch: Ref.Ref<number>;
  readonly reset: Ref.Ref<Deferred.Deferred<undefined>>;
  readonly senderPending: Ref.Ref<ReadonlyMap<string, number>>;
  readonly sequence: Ref.Ref<number>;
  readonly transition: Effect.Semaphore;
}

interface PendingRouteDelivery extends RoutedLinkDelivery {
  readonly accepted: Deferred.Deferred<undefined>;
  readonly epoch: number;
  readonly reset: Deferred.Deferred<undefined>;
  readonly sequence: number;
  readonly senderKey: string;
  readonly settled: Ref.Ref<boolean>;
}

interface SequencedRouteDelivery extends RoutedLinkDelivery {
  readonly sequence: number;
}

type ChainOutcome = Data.TaggedEnum<{
  drop: Record<never, never>;
  hold: { readonly cleared: Deferred.Deferred<undefined> };
  delay: { readonly total: Duration.Duration };
  deliver: Record<never, never>;
}>;

const chainOutcome = Data.taggedEnum<ChainOutcome>();
const BARRIER_CONCURRENCY = 32;

function keyOf(from: AgentId, to: AgentId): string {
  return `${from}->${to}`;
}

type ChainVerdicts = ReadonlyArray<readonly [ActivePolicy, LinkVerdict]>;

const isDrop = linkVerdict.$is("drop");
const isHold = linkVerdict.$is("hold");
const isDelay = linkVerdict.$is("delay");

/**
 * Runs a policy chain in installation order. A first drop wins, otherwise a
 * hold parks the delivery, delays sum, and an empty effect passes through.
 * @param chain Active policies in installation order.
 * @param delivery Delivery evaluated by the policy chain.
 * @returns The folded delivery outcome.
 */
function evaluateChain(
  chain: readonly ActivePolicy[],
  delivery: LinkDelivery,
): Effect.Effect<ChainOutcome> {
  return collectVerdicts(chain, delivery).pipe(Effect.map(foldVerdicts));
}

function collectVerdicts(
  chain: readonly ActivePolicy[],
  delivery: LinkDelivery,
): Effect.Effect<ChainVerdicts> {
  return Effect.gen(function* () {
    const verdicts: Array<readonly [ActivePolicy, LinkVerdict]> = [];
    for (const active of chain) {
      const verdict = yield* active.policy(delivery);
      verdicts.push([active, verdict] as const);
      if (isDrop(verdict)) {
        break;
      }
    }
    return verdicts;
  });
}

function foldVerdicts(verdicts: ChainVerdicts): ChainOutcome {
  if (verdicts.some(([, verdict]) => isDrop(verdict))) {
    return chainOutcome.drop();
  }
  const holding = verdicts.find(([, verdict]) => isHold(verdict));
  if (holding !== undefined) {
    return chainOutcome.hold({ cleared: holding[0].cleared });
  }
  const total = totalDelay(verdicts);
  return Duration.greaterThan(total, Duration.zero)
    ? chainOutcome.delay({ total })
    : chainOutcome.deliver();
}

function totalDelay(verdicts: ChainVerdicts): Duration.Duration {
  let total = Duration.zero;
  for (const [, verdict] of verdicts) {
    if (isDelay(verdict)) {
      total = Duration.sum(total, verdict.duration);
    }
  }
  return total;
}

function installPolicy(
  state: FabricState,
  key: string,
  policy: LinkPolicy,
): Effect.Effect<InstalledPolicy> {
  return Effect.gen(function* () {
    const active: ActivePolicy = {
      policy,
      cleared: yield* Deferred.make<undefined>(),
    };
    yield* Ref.update(state.policies, (policies) => {
      const updated = new Map(policies);
      updated.set(key, [...(updated.get(key) ?? []), active]);
      return updated;
    });
    const clear = state.transition.withPermits(1)(
      Effect.uninterruptible(clearInstalledPolicy(state, key, active)),
    );
    return Object.freeze({
      active,
      lease: Object.freeze({ clear: Effect.asVoid(clear) }),
    });
  });
}

function clearInstalledPolicy(
  state: FabricState,
  key: string,
  active: ActivePolicy,
): Effect.Effect<void> {
  return Ref.update(state.policies, (policies) => {
    const chain = policies.get(key);
    if (chain === undefined) {
      return policies;
    }
    const remaining = chain.filter((entry) => entry !== active);
    const updated = new Map(policies);
    if (remaining.length === 0) {
      updated.delete(key);
    } else {
      updated.set(key, remaining);
    }
    return updated;
  }).pipe(
    Effect.zipRight(Deferred.succeed(active.cleared, undefined)),
    Effect.asVoid,
  );
}

function requireReceiver(
  state: FabricState,
  operation: NetworkOperation,
  to: AgentId,
): Effect.Effect<void, NetworkError> {
  return Ref.get(state.receivers).pipe(
    Effect.filterOrFail(
      (receivers) => receivers.has(to),
      () =>
        networkError(
          operation,
          `agent ${to} is not an attached in-process receiver`,
        ),
    ),
    Effect.asVoid,
  );
}

function apply(state: FabricState): LinkDriverService["apply"] {
  return (from, to, policy) =>
    state.transition.withPermits(1)(
      Effect.uninterruptible(
        requireReceiver(state, "shape-link", to).pipe(
          Effect.zipRight(installPolicy(state, keyOf(from, to), policy)),
          Effect.map(({ lease }) => lease),
        ),
      ),
    );
}

function disable(state: FabricState): LinkDriverService["disable"] {
  return (from, to) =>
    state.transition.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const key = keyOf(from, to);
          yield* requireReceiver(state, "disable-link", to);
          if ((yield* Ref.get(state.disables)).has(key)) {
            return yield* networkError(
              "disable-link",
              `link ${key} is already disabled`,
            );
          }
          const { active } = yield* installPolicy(
            state,
            key,
            linkPolicy.dropAll("link disabled"),
          );
          yield* Ref.update(state.disables, (disables) =>
            new Map(disables).set(key, active),
          );
        }),
      ),
    );
}

function enable(state: FabricState): LinkDriverService["enable"] {
  return (from, to) =>
    state.transition.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const key = keyOf(from, to);
          const active = (yield* Ref.get(state.disables)).get(key);
          if (active === undefined) {
            return yield* networkError(
              "enable-link",
              `link ${key} is not disabled`,
            );
          }
          yield* Ref.update(state.disables, (disables) => {
            const updated = new Map(disables);
            updated.delete(key);
            return updated;
          });
          yield* clearInstalledPolicy(state, key, active);
        }),
      ),
    );
}

function attach(state: FabricState): InboundLinkInterceptor["attach"] {
  return (to) =>
    Effect.gen(function* () {
      const route: ReceiverRoute = {
        closed: yield* Deferred.make<never, NetworkError>(),
        input: yield* Mailbox.make<PendingRouteDelivery>(),
        output: yield* Mailbox.make<PendingRouteDelivery>(),
        pending: yield* Ref.make(0),
        epoch: yield* Ref.make(0),
        reset: yield* Ref.make(yield* Deferred.make<undefined>()),
        senderPending: yield* Ref.make<ReadonlyMap<string, number>>(new Map()),
        sequence: yield* Ref.make(0),
        transition: yield* Effect.makeSemaphore(1),
      };
      yield* routeStage(
        state,
        to,
        route,
      )(Mailbox.toStream(route.input)).pipe(
        Stream.runDrain,
        Effect.onExit((exit) => observeRouteWorker(state, to, route, exit)),
        Effect.forkScoped,
      );
      // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- The returned attach Effect requires Scope, so its caller owns both registration and worker finalizers.
      yield* Effect.acquireRelease(
        state.transition.withPermits(1)(registerRoute(state, to, route)),
        () => state.transition.withPermits(1)(releaseRoute(state, to, route)),
      );
    });
}

function observeRouteWorker(
  state: FabricState,
  to: AgentId,
  route: ReceiverRoute,
  exit: Exit.Exit<void, unknown>,
): Effect.Effect<void> {
  return Deferred.isDone(route.closed).pipe(
    Effect.flatMap((closed) => {
      if (closed) {
        return Effect.void;
      }
      if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)) {
        return Effect.void;
      }
      const detail = Exit.isSuccess(exit)
        ? `receiver ${to} route worker stopped unexpectedly`
        : `receiver ${to} route worker failed: ${Cause.pretty(exit.cause)}`;
      return state.transition.withPermits(1)(
        closeRoute(state, to, route, networkError("receive", detail)),
      );
    }),
    Effect.uninterruptible,
  );
}

function registerRoute(
  state: FabricState,
  to: AgentId,
  route: ReceiverRoute,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const reserved = yield* Ref.modify(state.receivers, (receivers) =>
      receivers.has(to)
        ? [false, receivers]
        : [true, new Set(receivers).add(to)],
    );
    if (!reserved) {
      return yield* Effect.die(new Error(`receiver ${to} is already attached`));
    }
    yield* Ref.update(state.routes, (routes) => new Map(routes).set(to, route));
  });
}

function releaseRoute(
  state: FabricState,
  to: AgentId,
  route: ReceiverRoute,
): Effect.Effect<void> {
  return closeRoute(
    state,
    to,
    route,
    networkError("receive", `receiver ${to} stopped accepting deliveries`),
  );
}

function closeRoute(
  state: FabricState,
  to: AgentId,
  route: ReceiverRoute,
  failure: NetworkError,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Deferred.fail(route.closed, failure);
    yield* Effect.all([route.input.shutdown, route.output.shutdown], {
      discard: true,
    });
    const removed = yield* Ref.modify(state.routes, (routes) => {
      if (routes.get(to) !== route) {
        return [false, routes];
      }
      const updated = new Map(routes);
      updated.delete(to);
      return [true, updated];
    });
    if (removed) {
      yield* Ref.update(state.receivers, (receivers) => {
        const updated = new Set(receivers);
        updated.delete(to);
        return updated;
      });
    }
  });
}

function route(state: FabricState): LinkFabric["route"] {
  return (to, deliveries) =>
    requireRoute(state, to).pipe(
      Effect.flatMap((receiver) => routeBatch(state, receiver, to, deliveries)),
      Effect.withSpan("LinkFabric.route"),
    );
}

function senderKey(epoch: number, sender: AgentId): string {
  return `${String(epoch)}:${sender}`;
}

function routeBatch(
  state: FabricState,
  receiver: ReceiverRoute,
  to: AgentId,
  deliveries: readonly RoutedLinkDelivery[],
): Effect.Effect<readonly RoutedLinkDelivery[], NetworkError> {
  return Effect.gen(function* () {
    const prepared = yield* whileRouteOpen(
      receiver,
      receiver.transition.withPermits(1)(
        enqueueBatch(state, receiver, to, deliveries),
      ),
    );
    const { barriers, direct } = prepared;
    yield* Effect.forEach(
      barriers,
      (accepted) => whileRouteOpen(receiver, Deferred.await(accepted)),
      {
        concurrency: BARRIER_CONCURRENCY,
        discard: true,
      },
    );
    const ready = yield* whileRouteOpen(
      receiver,
      receiver.transition.withPermits(1)(drainSequenced(receiver)),
    );
    return [...direct, ...ready]
      .sort((left, right) => left.sequence - right.sequence)
      .map(({ message }) => ({ message }));
  });
}

function whileRouteOpen<A, E, R>(
  receiver: ReceiverRoute,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | NetworkError, R> {
  return Deferred.isDone(receiver.closed).pipe(
    Effect.flatMap((closed) =>
      closed
        ? Deferred.await(receiver.closed)
        : Effect.raceFirst(effect, Deferred.await(receiver.closed)),
    ),
  );
}

function enqueueBatch(
  state: FabricState,
  receiver: ReceiverRoute,
  to: AgentId,
  deliveries: readonly RoutedLinkDelivery[],
): Effect.Effect<
  {
    readonly barriers: ReadonlyArray<Deferred.Deferred<undefined>>;
    readonly direct: readonly SequencedRouteDelivery[];
  },
  NetworkError
> {
  return Effect.gen(function* () {
    const [epoch, resetSignal, policies] = yield* Effect.all([
      Ref.get(receiver.epoch),
      Ref.get(receiver.reset),
      Ref.get(state.policies),
    ]);
    let sequence = yield* Ref.get(receiver.sequence);
    const counts = new Map(yield* Ref.get(receiver.senderPending));
    const direct: SequencedRouteDelivery[] = [];
    const pending: PendingRouteDelivery[] = [];
    const barriers: Array<Deferred.Deferred<undefined>> = [];
    for (const delivery of deliveries) {
      const currentSequence = sequence;
      sequence += 1;
      const sender = delivery.message.senderAgentId;
      const laneKey = senderKey(epoch, sender);
      const count = counts.get(laneKey) ?? 0;
      const active = policies.has(keyOf(sender, to));
      if (!active && count === 0) {
        direct.push({ ...delivery, sequence: currentSequence });
        continue;
      }
      const accepted = yield* Deferred.make<undefined>();
      pending.push({
        ...delivery,
        accepted,
        epoch,
        reset: resetSignal,
        senderKey: laneKey,
        sequence: currentSequence,
        settled: yield* Ref.make(false),
      });
      counts.set(laneKey, count + 1);
      if (count === 0) {
        barriers.push(accepted);
      }
    }
    yield* Ref.set(receiver.sequence, sequence);
    if (pending.length === 0) {
      return { barriers, direct };
    }
    // Publish bookkeeping before the unbounded offer so a synchronously
    // scheduled worker cannot finish an item before that item is counted.
    yield* Ref.set(receiver.senderPending, counts);
    yield* Ref.update(receiver.pending, (count) => count + pending.length);
    const rejected = yield* receiver.input.offerAll(pending);
    if (rejected.length === 0) {
      return { barriers, direct };
    }
    // An unbounded mailbox rejects the entire offer only after its scoped
    // worker has stopped. Roll back the exact rejected suffix.
    yield* rollbackPending(receiver, rejected);
    return yield* networkError(
      "receive",
      `receiver ${to} stopped accepting deliveries`,
    );
  });
}

function drain(state: FabricState): LinkFabric["drain"] {
  return (to) =>
    requireRoute(state, to).pipe(
      Effect.flatMap((receiver) =>
        receiver.transition.withPermits(1)(drainReceiver(receiver)),
      ),
      Effect.mapError((cause) => networkError("receive", cause)),
      Effect.withSpan("LinkFabric.drain"),
    );
}

function needsInterception(
  state: FabricState,
): LinkFabric["needsInterception"] {
  return (to) =>
    Effect.gen(function* () {
      const active = [...(yield* Ref.get(state.policies)).keys()].some((key) =>
        key.endsWith(`->${to}`),
      );
      if (active) {
        return true;
      }
      const receiver = (yield* Ref.get(state.routes)).get(to);
      if (receiver === undefined) {
        return false;
      }
      const ready = yield* receiver.output.size;
      return (
        (yield* Ref.get(receiver.pending)) > 0 ||
        Option.match(ready, {
          onNone: () => false,
          onSome: (size) => size > 0,
        })
      );
    });
}

function requireRoute(
  state: FabricState,
  to: AgentId,
): Effect.Effect<ReceiverRoute, NetworkError> {
  return Ref.get(state.routes).pipe(
    Effect.flatMap((routes) => {
      const present = routes.get(to);
      return present === undefined
        ? Effect.fail(networkError("receive", `receiver ${to} is not attached`))
        : Effect.succeed(present);
    }),
  );
}

function finishRoute(
  route: ReceiverRoute,
  delivery: PendingRouteDelivery,
): Effect.Effect<void> {
  return route.transition.withPermits(1)(
    Effect.gen(function* () {
      if (yield* Ref.get(delivery.settled)) {
        return;
      }
      const currentEpoch = yield* Ref.get(route.epoch);
      if (currentEpoch === delivery.epoch) {
        const accepted = yield* route.output.offer(delivery);
        if (!accepted) {
          return yield* Effect.die(
            new Error("receiver output stopped accepting deliveries"),
          );
        }
      }
      yield* Ref.set(delivery.settled, true);
      yield* finishPending(route, delivery.senderKey);
    }),
  );
}

function drainReceiver(
  receiver: ReceiverRoute,
): Effect.Effect<readonly RoutedLinkDelivery[]> {
  return drainSequenced(receiver).pipe(
    Effect.map((ready) => ready.map(({ message }) => ({ message }))),
  );
}

function drainSequenced(
  receiver: ReceiverRoute,
): Effect.Effect<readonly SequencedRouteDelivery[]> {
  return Effect.gen(function* () {
    const epoch = yield* Ref.get(receiver.epoch);
    const ready = yield* receiver.output.clear;
    return Array.from(ready)
      .filter((delivery) => delivery.epoch === epoch)
      .sort((left, right) => left.sequence - right.sequence);
  });
}

function finishPending(route: ReceiverRoute, sender: string) {
  return Effect.all(
    [
      Ref.update(route.pending, (count) => Math.max(0, count - 1)),
      Ref.update(route.senderPending, (counts) => {
        const current = counts.get(sender) ?? 0;
        const updated = new Map(counts);
        if (current <= 1) {
          updated.delete(sender);
        } else {
          updated.set(sender, current - 1);
        }
        return updated;
      }),
    ],
    { discard: true },
  );
}

function rollbackPending(
  route: ReceiverRoute,
  rejected: Iterable<PendingRouteDelivery>,
): Effect.Effect<void> {
  const deliveries = Array.from(rejected);
  const decrements = new Map<string, number>();
  for (const delivery of deliveries) {
    decrements.set(
      delivery.senderKey,
      (decrements.get(delivery.senderKey) ?? 0) + 1,
    );
  }
  return Effect.all(
    [
      Ref.update(route.pending, (count) =>
        Math.max(0, count - deliveries.length),
      ),
      Ref.update(route.senderPending, (counts) => {
        const updated = new Map(counts);
        for (const [sender, decrement] of decrements) {
          const remaining = (updated.get(sender) ?? 0) - decrement;
          if (remaining <= 0) {
            updated.delete(sender);
          } else {
            updated.set(sender, remaining);
          }
        }
        return updated;
      }),
    ],
    { discard: true },
  );
}

function dropRoute(
  route: ReceiverRoute,
  delivery: PendingRouteDelivery,
): Effect.Effect<void> {
  return route.transition.withPermits(1)(
    Ref.getAndSet(delivery.settled, true).pipe(
      Effect.flatMap((settled) =>
        settled ? Effect.void : finishPending(route, delivery.senderKey),
      ),
    ),
  );
}

function interpretRouteDelivery(
  state: FabricState,
  to: AgentId,
  route: ReceiverRoute,
  delivery: PendingRouteDelivery,
  signalEvaluation: boolean,
): Effect.Effect<void> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const chain =
        (yield* Ref.get(state.policies)).get(
          keyOf(delivery.message.senderAgentId, to),
        ) ?? [];
      if (chain.length === 0) {
        yield* finishRoute(route, delivery);
        if (signalEvaluation) {
          yield* Deferred.succeed(delivery.accepted, undefined);
        }
        return;
      }
      const outcome = yield* restore(
        evaluateChain(chain, {
          from: delivery.message.senderAgentId,
          to,
          message: delivery.message,
        }),
      );
      yield* chainOutcome.$match(outcome, {
        drop: () =>
          dropRoute(route, delivery).pipe(
            Effect.zipRight(
              signalEvaluation
                ? Deferred.succeed(delivery.accepted, undefined)
                : Effect.void,
            ),
          ),
        hold: ({ cleared }) =>
          (signalEvaluation
            ? Deferred.succeed(delivery.accepted, undefined)
            : Effect.void
          ).pipe(
            Effect.zipRight(restore(Deferred.await(cleared))),
            Effect.zipRight(
              Effect.suspend(() =>
                interpretRouteDelivery(state, to, route, delivery, false),
              ),
            ),
          ),
        delay: ({ total }) =>
          (signalEvaluation
            ? Deferred.succeed(delivery.accepted, undefined)
            : Effect.void
          ).pipe(
            Effect.zipRight(restore(Effect.sleep(total))),
            Effect.zipRight(finishRoute(route, delivery)),
          ),
        deliver: () =>
          finishRoute(route, delivery).pipe(
            Effect.zipRight(
              signalEvaluation
                ? Deferred.succeed(delivery.accepted, undefined)
                : Effect.void,
            ),
          ),
      });
    }),
  );
}

function routeStage(state: FabricState, to: AgentId, route: ReceiverRoute) {
  return <E>(inbound: Stream.Stream<PendingRouteDelivery, E>) =>
    Stream.groupByKey(inbound, (item) => item.message.senderAgentId).pipe(
      GroupBy.evaluate((...[, lane]) =>
        lane.pipe(
          Stream.buffer({ capacity: "unbounded" }),
          Stream.mapEffect(
            (delivery) =>
              Effect.uninterruptibleMask((restore) =>
                restore(
                  Effect.raceFirst(
                    interpretRouteDelivery(state, to, route, delivery, true),
                    Deferred.await(delivery.reset).pipe(
                      Effect.zipRight(dropRoute(route, delivery)),
                      Effect.zipRight(
                        Deferred.succeed(delivery.accepted, undefined),
                      ),
                    ),
                  ),
                ),
              ),
            { concurrency: 1 },
          ),
        ),
      ),
    );
}

function reset(state: FabricState): LinkFabric["reset"] {
  return (to) =>
    Ref.get(state.routes).pipe(
      Effect.flatMap((routes) => {
        const receiver = routes.get(to);
        return receiver === undefined
          ? Effect.void
          : receiver.transition.withPermits(1)(
              Effect.gen(function* () {
                const next = yield* Deferred.make<undefined>();
                const previous = yield* Ref.getAndSet(receiver.reset, next);
                yield* Ref.update(receiver.epoch, (epoch) => epoch + 1);
                yield* receiver.output.clear;
                // Every old lane races this signal and then decrements its own
                // retained-delivery counters exactly once.
                yield* Deferred.succeed(previous, undefined);
              }),
            );
      }),
      Effect.mapError((cause) => networkError("receive", cause)),
      Effect.withSpan("LinkFabric.reset"),
    );
}

/* eslint-enable max-lines-per-function, max-params, max-statements, sonarjs/max-lines-per-function, sonarjs/no-nested-functions -- restore project limits after the private delivery interpreter. */
