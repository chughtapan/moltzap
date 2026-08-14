/** @file Evidence-producing scoped control for directed network links. */

import { Cause, Duration, Effect, Either, Exit, Ref } from "effect";
import type { LedgerWriter } from "../ledger/append.js";
import {
  LinkDown,
  type linkEvents,
  LinkPolicyCleared,
  LinkPolicySet,
  LinkUp,
} from "../events/core.js";
import {
  type LinkControllerService,
  LinkDriver,
  type LinkDriverService,
  linkPolicy,
  type LinkPolicy,
  type LinkPolicyLease,
  networkError,
  type NetworkError,
  type ParticipantHandle,
} from "../network/index.js";

interface DirectedLink {
  readonly key: string;
  readonly from: ParticipantHandle;
  readonly to: ParticipantHandle;
}

type LinkEventWriter = LedgerWriter<typeof linkEvents>;

interface ActiveLink extends DirectedLink {
  readonly driver: LinkDriverService;
  readonly leases: Ref.Ref<number>;
}

interface LinkControllerRuntime {
  readonly active: Ref.Ref<ReadonlyMap<string, ActiveLink>>;
  readonly transition: Effect.Semaphore;
  readonly writer: LinkEventWriter;
}

type Restore = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

/**
 * Creates one run-scoped directed-link controller.
 * @param writer Producer-bound writer for link lifecycle events.
 * @returns The scoped link-control service.
 */
export function makeLinkController(
  writer: LinkEventWriter,
): Effect.Effect<LinkControllerService> {
  return Effect.gen(function* () {
    const runtime: LinkControllerRuntime = {
      active: yield* Ref.make<ReadonlyMap<string, ActiveLink>>(new Map()),
      transition: yield* Effect.makeSemaphore(1),
      writer,
    };
    return Object.freeze({
      disable: disable(runtime),
      delay: delay(runtime),
      hold: hold(runtime),
      shape: shape(runtime),
    });
  }).pipe(Effect.withSpan("makeLinkController"));
}

function keyOf(from: ParticipantHandle, to: ParticipantHandle): string {
  return `${from.id}->${to.id}`;
}

function recordDown(runtime: LinkControllerRuntime, link: DirectedLink) {
  return runtime.writer
    .write({
      event: LinkDown.make({ from: link.from.id, to: link.to.id }),
    })
    .pipe(Effect.asVoid);
}

function recordUp(runtime: LinkControllerRuntime, link: DirectedLink) {
  return runtime.writer
    .write({
      event: LinkUp.make({ from: link.from.id, to: link.to.id }),
    })
    .pipe(Effect.asVoid);
}

function holdFirstLease(runtime: LinkControllerRuntime, link: ActiveLink) {
  return holdLease(runtime, link, addActive(runtime, link));
}

function holdOverlappingLease(
  runtime: LinkControllerRuntime,
  link: ActiveLink,
) {
  return holdLease(
    runtime,
    link,
    Ref.update(link.leases, (leases) => leases + 1),
  );
}

function addActive(
  runtime: LinkControllerRuntime,
  link: ActiveLink,
): Effect.Effect<void> {
  return Ref.update(runtime.active, (active) => {
    const updated = new Map(active);
    updated.set(link.key, link);
    return updated;
  });
}

function removeActive(
  runtime: LinkControllerRuntime,
  link: ActiveLink,
): Effect.Effect<void> {
  return Ref.update(runtime.active, (active) => {
    const updated = new Map(active);
    updated.delete(link.key);
    return updated;
  });
}

function rollbackDown(
  driver: LinkDriverService,
  link: DirectedLink,
  cause: Cause.Cause<never>,
) {
  return Effect.gen(function* () {
    const rollback = yield* Effect.exit(
      driver.enable(link.from.id, link.to.id),
    );
    return yield* Exit.isFailure(rollback)
      ? Effect.failCause(Cause.sequential(cause, rollback.cause))
      : Effect.failCause(cause);
  });
}

function rollbackLedgerFailure(driver: LinkDriverService, link: DirectedLink) {
  return Effect.gen(function* () {
    const rollback = yield* Effect.exit(
      driver.enable(link.from.id, link.to.id),
    );
    return yield* Exit.isFailure(rollback)
      ? Effect.failCause(rollback.cause)
      : Effect.interrupt;
  });
}

function releaseLease(
  runtime: LinkControllerRuntime,
  link: ActiveLink,
): Effect.Effect<void, NetworkError> {
  return runtime.transition.withPermits(1)(
    Effect.gen(function* () {
      const leases = yield* Ref.get(link.leases);
      if (leases > 1) {
        yield* Ref.set(link.leases, leases - 1);
        return;
      }
      yield* link.driver.enable(link.from.id, link.to.id);
      yield* removeActive(runtime, link);
      yield* recordUp(runtime, link).pipe(Effect.catchAll(() => Effect.void));
    }),
  );
}

function holdLease(
  runtime: LinkControllerRuntime,
  link: ActiveLink,
  acquire: Effect.Effect<void>,
) {
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- the caller owns the fault scope
  return Effect.acquireRelease(acquire, () =>
    releaseLease(runtime, link).pipe(Effect.orDie),
  );
}

function acquireFirst(
  runtime: LinkControllerRuntime,
  link: DirectedLink,
  driver: LinkDriverService,
  restore: Restore,
) {
  return Effect.gen(function* () {
    // The driver can commit before interruption becomes observable. Keep this
    // call masked so either evidence is compensated or a finalizer owns it.
    yield* driver.disable(link.from.id, link.to.id);
    const observed = yield* Effect.exit(restore(recordDown(runtime, link)));
    if (Exit.isFailure(observed)) {
      const failure = Cause.failureOrCause(observed.cause);
      return yield* Either.match(failure, {
        onLeft: () => rollbackLedgerFailure(driver, link),
        onRight: (cause) => rollbackDown(driver, link, cause),
      });
    }
    const active: ActiveLink = {
      ...link,
      driver,
      leases: yield* Ref.make(1),
    };
    yield* holdFirstLease(runtime, active);
  });
}

function acquireLease(
  runtime: LinkControllerRuntime,
  link: DirectedLink,
  driver: LinkDriverService,
) {
  return runtime.transition.withPermits(1)(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(runtime.active)).get(link.key);
        if (existing !== undefined) {
          yield* holdOverlappingLease(runtime, existing);
          return;
        }
        yield* acquireFirst(runtime, link, driver, restore);
      }),
    ),
  );
}

function recordPolicySet(
  runtime: LinkControllerRuntime,
  link: DirectedLink,
  description: string,
) {
  return runtime.writer
    .write({
      event: LinkPolicySet.make({
        from: link.from.id,
        to: link.to.id,
        policy: description,
      }),
    })
    .pipe(Effect.asVoid);
}

function releasePolicy(
  runtime: LinkControllerRuntime,
  link: DirectedLink,
  lease: LinkPolicyLease,
  description: string,
): Effect.Effect<void, NetworkError> {
  return lease.clear.pipe(
    Effect.zipRight(
      recordPolicyCleared(runtime, link, description).pipe(
        Effect.catchAll(() => Effect.void),
      ),
    ),
  );
}

function recordPolicyCleared(
  runtime: LinkControllerRuntime,
  link: DirectedLink,
  description: string,
) {
  return runtime.writer
    .write({
      event: LinkPolicyCleared.make({
        from: link.from.id,
        to: link.to.id,
        policy: description,
      }),
    })
    .pipe(Effect.asVoid);
}

function rollbackPolicy(lease: LinkPolicyLease, cause: Cause.Cause<never>) {
  return Effect.gen(function* () {
    const rollback = yield* Effect.exit(lease.clear);
    return yield* Exit.isFailure(rollback)
      ? Effect.failCause(Cause.sequential(cause, rollback.cause))
      : Effect.failCause(cause);
  });
}

function rollbackPolicyLedgerFailure(lease: LinkPolicyLease) {
  return Effect.gen(function* () {
    const rollback = yield* Effect.exit(lease.clear);
    return yield* Exit.isFailure(rollback)
      ? Effect.failCause(rollback.cause)
      : Effect.interrupt;
  });
}

interface PolicyInstallation {
  readonly driver: LinkDriverService;
  readonly policy: LinkPolicy;
  readonly description: string;
}

function acquirePolicy(
  runtime: LinkControllerRuntime,
  link: DirectedLink,
  installation: PolicyInstallation,
) {
  const { driver, policy, description } = installation;
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      // Acquiring the lease stays masked until an interruptible evidence write
      // is compensated or scoped release owns the exact committed lease.
      const lease = yield* driver.apply(
        link.from.id,
        link.to.id,
        policy,
        description,
      );
      const observed = yield* Effect.exit(
        restore(recordPolicySet(runtime, link, description)),
      );
      if (Exit.isFailure(observed)) {
        const failure = Cause.failureOrCause(observed.cause);
        return yield* Either.match(failure, {
          onLeft: () => rollbackPolicyLedgerFailure(lease),
          onRight: (cause) => rollbackPolicy(lease, cause),
        });
      }
      // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- the caller owns the policy scope
      yield* Effect.acquireRelease(Effect.void, () =>
        releasePolicy(runtime, link, lease, description).pipe(Effect.orDie),
      );
    }),
  );
}

function shape(runtime: LinkControllerRuntime): LinkControllerService["shape"] {
  return (from, to, policy, description) =>
    Effect.gen(function* () {
      if (from.id === to.id) {
        return yield* networkError(
          "shape-link",
          "a directed link requires two different participants",
        );
      }
      if (description.length === 0) {
        return yield* networkError(
          "shape-link",
          "a link policy requires a nonempty description",
        );
      }
      const driver = yield* LinkDriver;
      const link: DirectedLink = {
        key: keyOf(from, to),
        from,
        to,
      };
      yield* acquirePolicy(runtime, link, { driver, policy, description });
    });
}

function delay(runtime: LinkControllerRuntime): LinkControllerService["delay"] {
  return (from, to, duration) => {
    const decoded = Duration.decode(duration);
    return shape(runtime)(
      from,
      to,
      linkPolicy.delay(decoded),
      `delay ${Duration.format(decoded)}`,
    );
  };
}

function hold(runtime: LinkControllerRuntime): LinkControllerService["hold"] {
  return (from, to) => shape(runtime)(from, to, linkPolicy.hold, "hold");
}

function disable(
  runtime: LinkControllerRuntime,
): LinkControllerService["disable"] {
  return (from, to) =>
    Effect.gen(function* () {
      if (from.id === to.id) {
        return yield* networkError(
          "disable-link",
          "a directed link requires two different participants",
        );
      }
      const driver = yield* LinkDriver;
      const link: DirectedLink = {
        key: keyOf(from, to),
        from,
        to,
      };
      yield* acquireLease(runtime, link, driver);
    });
}
