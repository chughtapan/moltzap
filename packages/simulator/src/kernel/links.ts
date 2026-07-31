/** @file Evidence-producing scoped control for directed network links. */

import { Cause, Effect, Either, Exit, Ref } from "effect";
import { LinkDown, type linkEvents, LinkUp } from "../events/core.js";
import type { LedgerWriter } from "../ledger/live.js";
import {
  LinkDriver,
  type LinkControllerService,
  type LinkDriverService,
} from "../network/link.js";
import type { ParticipantHandle } from "../network/participant.js";
import { networkFailure, type NetworkFailure } from "../network/router.js";

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

function keyOf(from: ParticipantHandle, to: ParticipantHandle): string {
  return `${from.id}->${to.id}`;
}

function recordDown(runtime: LinkControllerRuntime, link: DirectedLink) {
  return runtime.writer
    .write({
      event: LinkDown.make({
        from: link.from.id,
        to: link.to.id,
      }),
    })
    .pipe(Effect.asVoid);
}

function recordUp(runtime: LinkControllerRuntime, link: DirectedLink) {
  return runtime.writer
    .write({
      event: LinkUp.make({
        from: link.from.id,
        to: link.to.id,
      }),
    })
    .pipe(Effect.asVoid);
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
): Effect.Effect<void, NetworkFailure> {
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
  // The returned acquisition keeps Scope in LinkController.disable's
  // requirements; the customer program owns that enclosing scope.
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- this helper returns the scoped acquisition to its caller
  return Effect.acquireRelease(acquire, () =>
    releaseLease(runtime, link).pipe(Effect.orDie),
  );
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

function acquireFirst(
  runtime: LinkControllerRuntime,
  link: DirectedLink,
  driver: LinkDriverService,
  restore: Restore,
) {
  return Effect.gen(function* () {
    yield* restore(driver.disable(link.from.id, link.to.id));
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
        const active = yield* Ref.get(runtime.active);
        const existing = active.get(link.key);
        if (existing !== undefined) {
          yield* holdOverlappingLease(runtime, existing);
          return;
        }
        yield* acquireFirst(runtime, link, driver, restore);
      }),
    ),
  );
}

function disable(
  runtime: LinkControllerRuntime,
): LinkControllerService["disable"] {
  return (from, to) =>
    Effect.gen(function* () {
      if (from.id === to.id) {
        return yield* networkFailure(
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

/**
 * Creates link controller.
 * @param writer Value supplied to the operation.
 * @returns The created link controller.
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
    });
  }).pipe(Effect.withSpan("makeLinkController"));
}
