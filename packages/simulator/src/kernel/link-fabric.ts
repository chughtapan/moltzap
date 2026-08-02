/** @file In-process link fabric: policy storage, interpreter, and evidence. */

import type { AgentId } from "@moltzap/protocol/identity";
import type { Message } from "@moltzap/protocol/message";
import {
  Data,
  Deferred,
  Duration,
  Effect,
  GroupBy,
  Option,
  Ref,
  type Scope,
  Stream,
} from "effect";
import {
  type linkEvents,
  LinkMessageDelayed,
  LinkMessageDropped,
  LinkMessageHeld,
} from "../events/core.js";
import type { LedgerWriter } from "../ledger/live.js";
import {
  linkPolicy,
  linkVerdict,
  type InboundLinkStage,
  type LinkDelivery,
  type LinkDriverService,
  type LinkPolicy,
  type LinkPolicyLease,
  type LinkVerdict,
} from "../network/link.js";
import {
  networkFailure,
  type NetworkFailure,
  type NetworkOperation,
} from "../network/router.js";

type LinkEventWriter = LedgerWriter<typeof linkEvents>;

/**
 * Registers in-process receivers with the link fabric. Acquiring `attach` is
 * what makes a receiver a valid policy target, so a consumer that cannot reach
 * its own inbound deliveries leaves the agent unregistered and link control
 * over it fails instead of shaping nothing. Releasing the acquisition scope
 * removes the registration.
 */
export interface InboundLinkInterceptor {
  readonly attach: (
    to: AgentId,
  ) => Effect.Effect<InboundLinkStage, never, Scope.Scope>;
}

/** Driver and receiver registration faces of one in-process link fabric. */
export interface LinkFabric {
  readonly driver: LinkDriverService;
  readonly interceptor: InboundLinkInterceptor;
}

interface ActivePolicy {
  readonly policy: LinkPolicy;
  readonly description: string;
  /** Completed exactly when the installing lease clears. */
  readonly cleared: Deferred.Deferred<undefined>;
}

interface FabricState {
  readonly receivers: Ref.Ref<ReadonlySet<AgentId>>;
  readonly policies: Ref.Ref<ReadonlyMap<string, readonly ActivePolicy[]>>;
  readonly disables: Ref.Ref<ReadonlyMap<string, LinkPolicyLease>>;
  readonly transition: Effect.Semaphore;
  readonly writer: LinkEventWriter;
}

type ChainOutcome = Data.TaggedEnum<{
  drop: { readonly reason?: string };
  hold: { readonly cleared: Deferred.Deferred<undefined> };
  delay: { readonly total: Duration.Duration };
  deliver: Record<never, never>;
}>;

const chainOutcome = Data.taggedEnum<ChainOutcome>();

function keyOf(from: AgentId, to: AgentId): string {
  return `${from}->${to}`;
}

function recordDropped(
  state: FabricState,
  delivery: LinkDelivery,
  reason?: string,
) {
  return state.writer
    .write({
      event: LinkMessageDropped.make({
        from: delivery.from,
        to: delivery.to,
        conversationId: delivery.message.conversationId,
        messageId: delivery.message.id,
        reason,
      }),
    })
    .pipe(Effect.asVoid);
}

function recordDelayed(
  state: FabricState,
  delivery: LinkDelivery,
  total: Duration.Duration,
) {
  return state.writer
    .write({
      event: LinkMessageDelayed.make({
        from: delivery.from,
        to: delivery.to,
        conversationId: delivery.message.conversationId,
        messageId: delivery.message.id,
        delayMillis: Duration.toMillis(total),
      }),
    })
    .pipe(Effect.asVoid);
}

function recordHeld(state: FabricState, delivery: LinkDelivery) {
  return state.writer
    .write({
      event: LinkMessageHeld.make({
        from: delivery.from,
        to: delivery.to,
        conversationId: delivery.message.conversationId,
        messageId: delivery.message.id,
      }),
    })
    .pipe(Effect.asVoid);
}

type ChainVerdicts = ReadonlyArray<readonly [ActivePolicy, LinkVerdict]>;

const isDrop = linkVerdict.$is("drop");
const isHold = linkVerdict.$is("hold");
const isDelay = linkVerdict.$is("delay");

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

function totalDelay(verdicts: ChainVerdicts): Duration.Duration {
  let total = Duration.zero;
  for (const [, verdict] of verdicts) {
    if (isDelay(verdict)) {
      total = Duration.sum(total, verdict.duration);
    }
  }
  return total;
}

function foldVerdicts(verdicts: ChainVerdicts): ChainOutcome {
  for (const [, verdict] of verdicts) {
    if (isDrop(verdict)) {
      return chainOutcome.drop({ reason: verdict.reason });
    }
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

/**
 * Runs every policy of one chain in installation order and folds their
 * verdicts: the first drop wins outright, then any hold parks the delivery,
 * then delay durations sum, otherwise the delivery passes.
 * @param chain Active policies for one directed pair, in installation order.
 * @param delivery Delivery under decision.
 * @returns The folded chain outcome.
 */
function evaluateChain(
  chain: readonly ActivePolicy[],
  delivery: LinkDelivery,
): Effect.Effect<ChainOutcome> {
  return collectVerdicts(chain, delivery).pipe(Effect.map(foldVerdicts));
}

/**
 * Decides one delivery against the currently active chain. A parked delivery
 * re-evaluates the then-active chain after the holding lease clears; the
 * interpreter, never a policy, spends the delay time and records evidence.
 * @param state Shared fabric state.
 * @param delivery Delivery under decision.
 * @returns Whether the delivery proceeds to its receiver.
 */
function interpretDelivery(
  state: FabricState,
  delivery: LinkDelivery,
): Effect.Effect<boolean> {
  const step = Effect.gen(function* () {
    const chain =
      (yield* Ref.get(state.policies)).get(keyOf(delivery.from, delivery.to)) ??
      [];
    if (chain.length === 0) {
      return Option.some(true);
    }
    const outcome = yield* evaluateChain(chain, delivery);
    return yield* chainOutcome.$match(outcome, {
      drop: ({ reason }) =>
        recordDropped(state, delivery, reason).pipe(
          Effect.as(Option.some(false)),
        ),
      hold: ({ cleared }) =>
        recordHeld(state, delivery).pipe(
          Effect.zipRight(Deferred.await(cleared)),
          Effect.as(Option.none<boolean>()),
        ),
      delay: ({ total }) =>
        recordDelayed(state, delivery, total).pipe(
          Effect.zipRight(Effect.sleep(total)),
          Effect.as(Option.some(true)),
        ),
      deliver: () => Effect.succeed(Option.some(true)),
    });
  });
  // Evidence failures interrupt the delivery lane; the shared ledger writer
  // independently surfaces the failure to the run kernel.
  return step.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.suspend(() => interpretDelivery(state, delivery)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catchAll(() => Effect.interrupt),
  );
}

function interpretItem<A extends { readonly message: Message }>(
  state: FabricState,
  to: AgentId,
  item: A,
): Effect.Effect<Option.Option<A>> {
  return interpretDelivery(state, {
    from: item.message.senderId,
    to,
    message: item.message,
  }).pipe(
    Effect.map((deliver) => (deliver ? Option.some(item) : Option.none<A>())),
  );
}

function laneStage(state: FabricState, to: AgentId) {
  return <A extends { readonly message: Message }, E>(
    lane: Stream.Stream<A, E>,
  ): Stream.Stream<A, E> =>
    lane.pipe(
      Stream.mapEffect((item) => interpretItem(state, to, item), {
        concurrency: 1,
      }),
      Stream.filterMap((option) => option),
    );
}

function makeStage(state: FabricState, to: AgentId): InboundLinkStage {
  return <A extends { readonly message: Message }, E>(
    inbound: Stream.Stream<A, E>,
  ): Stream.Stream<A, E> =>
    Stream.groupByKey(inbound, (item) => item.message.senderId).pipe(
      GroupBy.evaluate((...[, lane]) => laneStage(state, to)(lane)),
    );
}

function installPolicy(
  state: FabricState,
  key: string,
  policy: LinkPolicy,
  description: string,
): Effect.Effect<LinkPolicyLease> {
  return Effect.gen(function* () {
    const active: ActivePolicy = {
      policy,
      description,
      cleared: yield* Deferred.make<undefined>(),
    };
    yield* Ref.update(state.policies, (policies) => {
      const updated = new Map(policies);
      updated.set(key, [...(updated.get(key) ?? []), active]);
      return updated;
    });
    const clear = Ref.update(state.policies, (policies) => {
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
    }).pipe(Effect.zipRight(Deferred.succeed(active.cleared, undefined)));
    return Object.freeze({ clear: Effect.asVoid(clear) });
  });
}

function requireReceiver(
  state: FabricState,
  operation: NetworkOperation,
  to: AgentId,
): Effect.Effect<void, NetworkFailure> {
  return Ref.get(state.receivers).pipe(
    Effect.filterOrFail(
      (receivers) => receivers.has(to),
      () =>
        networkFailure(
          operation,
          `agent ${to} is not an attached in-process receiver`,
        ),
    ),
    Effect.asVoid,
  );
}

function apply(state: FabricState): LinkDriverService["apply"] {
  return (from, to, policy, description) =>
    requireReceiver(state, "shape-link", to).pipe(
      Effect.zipRight(
        installPolicy(state, keyOf(from, to), policy, description),
      ),
    );
}

function disable(state: FabricState): LinkDriverService["disable"] {
  return (from, to) =>
    state.transition.withPermits(1)(
      Effect.gen(function* () {
        yield* requireReceiver(state, "disable-link", to);
        const key = keyOf(from, to);
        if ((yield* Ref.get(state.disables)).has(key)) {
          return yield* networkFailure(
            "disable-link",
            `link ${key} is already disabled`,
          );
        }
        const lease = yield* installPolicy(
          state,
          key,
          linkPolicy.dropAll("link disabled"),
          "disable",
        );
        yield* Ref.update(state.disables, (disables) =>
          new Map(disables).set(key, lease),
        );
      }),
    );
}

function enable(state: FabricState): LinkDriverService["enable"] {
  return (from, to) =>
    state.transition.withPermits(1)(
      Effect.gen(function* () {
        const key = keyOf(from, to);
        const lease = (yield* Ref.get(state.disables)).get(key);
        if (lease === undefined) {
          return yield* networkFailure(
            "enable-link",
            `link ${key} is not disabled`,
          );
        }
        yield* Ref.update(state.disables, (disables) => {
          const updated = new Map(disables);
          updated.delete(key);
          return updated;
        });
        yield* lease.clear;
      }),
    );
}

function attach(state: FabricState): InboundLinkInterceptor["attach"] {
  return (to) =>
    // The returned acquisition keeps Scope in attach's requirements; the
    // registering endpoint acquisition owns that enclosing scope.
    // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- this helper returns the scoped acquisition to its caller
    Effect.acquireRelease(
      Ref.update(state.receivers, (receivers) => new Set(receivers).add(to)),
      () =>
        Ref.update(state.receivers, (receivers) => {
          const updated = new Set(receivers);
          updated.delete(to);
          return updated;
        }),
    ).pipe(Effect.as(makeStage(state, to)));
}

/**
 * Creates the in-process link fabric.
 * @param writer Ledger writer for per-message link evidence.
 * @returns The fabric's driver and receiver-registration faces.
 */
export function makeLinkFabric(
  writer: LinkEventWriter,
): Effect.Effect<LinkFabric> {
  return Effect.gen(function* () {
    const state: FabricState = {
      receivers: yield* Ref.make<ReadonlySet<AgentId>>(new Set()),
      policies: yield* Ref.make<ReadonlyMap<string, readonly ActivePolicy[]>>(
        new Map(),
      ),
      disables: yield* Ref.make<ReadonlyMap<string, LinkPolicyLease>>(
        new Map(),
      ),
      transition: yield* Effect.makeSemaphore(1),
      writer,
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
    });
  }).pipe(Effect.withSpan("makeLinkFabric"));
}
