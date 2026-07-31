import type { AgentId } from "@moltzap/v2-identity";
import { Data, Deferred, Effect, Ref } from "effect";

/** No held-poll slot is immediately available. */
class HeldPollCapacityError extends Data.TaggedError("HeldPollCapacityError") {}

/** Bounded addressed-notification capability. */
export interface HeldPolls {
  readonly awaitSignal: (
    agentId: AgentId,
    addressedDataIsReady: Effect.Effect<boolean>,
  ) => Effect.Effect<void, HeldPollCapacityError>;
  readonly notify: (recipients: ReadonlySet<AgentId>) => Effect.Effect<void>;
  readonly activeCount: Effect.Effect<number>;
}

type Waiter = Deferred.Deferred<undefined>;
type Waiters = ReadonlyMap<AgentId, Waiter>;

const removeWaiter = (
  waiters: Ref.Ref<Waiters>,
  agentId: AgentId,
  deferred: Waiter,
): Effect.Effect<void> =>
  Ref.update(waiters, (current) => {
    if (current.get(agentId) !== deferred) {
      return current;
    }
    const next = new Map(current);
    next.delete(agentId);
    return next;
  });

const registerWaiter = (
  waiters: Ref.Ref<Waiters>,
  capacity: number,
  agentId: AgentId,
  deferred: Waiter,
): Effect.Effect<boolean> =>
  Ref.modify(waiters, (current): readonly [boolean, Waiters] => {
    if (current.has(agentId) || current.size >= capacity) {
      return [false, current];
    }
    const next = new Map(current);
    next.set(agentId, deferred);
    return [true, next];
  });

const detachWaiters = (
  waiters: Ref.Ref<Waiters>,
  recipients: ReadonlySet<AgentId>,
): Effect.Effect<readonly Waiter[]> =>
  Ref.modify(waiters, (current): readonly [readonly Waiter[], Waiters] => {
    const next = new Map(current);
    const found: Waiter[] = [];
    for (const agentId of recipients) {
      const deferred = next.get(agentId);
      if (deferred !== undefined) {
        found.push(deferred);
        next.delete(agentId);
      }
    }
    return [found, next];
  });

const awaitRegisteredWaiter = (
  waiters: Ref.Ref<Waiters>,
  capacity: number,
  agentId: AgentId,
  addressedDataIsReady: Effect.Effect<boolean>,
): Effect.Effect<void, HeldPollCapacityError> =>
  Effect.gen(function* () {
    const deferred = yield* Deferred.make<undefined>();
    const registered = yield* registerWaiter(
      waiters,
      capacity,
      agentId,
      deferred,
    );
    if (!registered) {
      return yield* Effect.fail(new HeldPollCapacityError());
    }
    return yield* Effect.gen(function* () {
      if (yield* addressedDataIsReady) {
        return;
      }
      yield* Deferred.await(deferred);
    }).pipe(Effect.ensuring(removeWaiter(waiters, agentId, deferred)));
  });

const notifyWaiters = (
  waiters: Ref.Ref<Waiters>,
  recipients: ReadonlySet<AgentId>,
): Effect.Effect<void> =>
  detachWaiters(waiters, recipients).pipe(
    Effect.flatMap((detached) =>
      Effect.forEach(
        detached,
        (deferred) => Deferred.succeed(deferred, undefined),
        { concurrency: 128, discard: true },
      ),
    ),
  );

/**
 * Creates request-scoped held polls with global and per-agent bounds.
 *
 * @param capacity Maximum simultaneous held polls.
 * @returns The bounded waiter capability.
 */
export const makeHeldPolls = (capacity: number): Effect.Effect<HeldPolls> =>
  Effect.gen(function* () {
    const waiters = yield* Ref.make<Waiters>(new Map());
    const service: HeldPolls = {
      awaitSignal: (
        agentId: AgentId,
        addressedDataIsReady: Effect.Effect<boolean>,
      ) =>
        awaitRegisteredWaiter(waiters, capacity, agentId, addressedDataIsReady),
      notify: (recipients: ReadonlySet<AgentId>) =>
        notifyWaiters(waiters, recipients),
      activeCount: Ref.get(waiters).pipe(Effect.map((current) => current.size)),
    };
    return Object.freeze(service);
  }).pipe(Effect.withSpan("makeHeldPolls"));
