import { Duration, Effect, Ref } from "effect";
import type {
  HandleInboundFrameOpts,
  BadServerBehavior,
  LeaseRecord,
  ModeratorVerdict,
} from "./dispatch-admission-bad-server-model.js";
import {
  DEFAULT_LEASE_TIMEOUT_MS,
  freshUuidV4,
} from "./dispatch-admission-bad-server-model.js";
import {
  emitDispatchesExpired,
  emitReleaseFrame,
} from "./dispatch-admission-bad-server-wire.js";

export function resolveLease(args: {
  readonly lease: LeaseRecord;
  readonly opts: HandleInboundFrameOpts;
  readonly verdict: ModeratorVerdict;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    applyLeaseVerdict(args.lease, args.verdict);
    const wireVerdict = pickWireVerdict({
      verdict: args.verdict,
      behavior: args.opts.behavior,
    });
    yield* emitPrimaryRelease(args, wireVerdict);
    yield* markReleaseEmitted(args.opts, args.lease);
    yield* maybeEmitDuplicateRelease(args, wireVerdict);
    yield* scheduleExpiryIfGranted(args);
  }).pipe(Effect.withSpan("resolveLease"));
}

function applyLeaseVerdict(
  lease: LeaseRecord,
  verdict: ModeratorVerdict,
): void {
  lease.verdict = verdict;
  switch (verdict._tag) {
    case "grant":
      lease.state = "GRANTED";
      lease.leaseTimeoutMs = verdict.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
      return;
    case "deny":
      lease.state = "DENIED";
      return;
    case "hold":
      lease.state = "HOLD";
  }
}

function emitPrimaryRelease(
  args: {
    readonly lease: LeaseRecord;
    readonly opts: HandleInboundFrameOpts;
    readonly verdict: ModeratorVerdict;
  },
  wireVerdict: ModeratorVerdict,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (args.opts.behavior === "release-out-of-order") {
      yield* awaitEarlierMintsEmitted(args.opts, args.lease);
    }
    yield* emitReleaseForLease(args, wireVerdict);
  });
}

function markReleaseEmitted(
  opts: HandleInboundFrameOpts,
  lease: LeaseRecord,
): Effect.Effect<void> {
  return Ref.update(opts.nextEmitIndexByRecipient, (m) => {
    const cur = m.get(lease.recipientConnId) ?? 0;
    m.set(lease.recipientConnId, Math.max(cur, lease.mintIndex + 1));
    return m;
  });
}

function maybeEmitDuplicateRelease(
  args: {
    readonly lease: LeaseRecord;
    readonly opts: HandleInboundFrameOpts;
    readonly verdict: ModeratorVerdict;
  },
  wireVerdict: ModeratorVerdict,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (args.opts.behavior !== "release-fires-twice") return;
    yield* Effect.sleep(Duration.millis(50));
    yield* emitReleaseForLease(args, wireVerdict);
  });
}

function emitReleaseForLease(
  args: {
    readonly lease: LeaseRecord;
    readonly opts: HandleInboundFrameOpts;
    readonly verdict: ModeratorVerdict;
  },
  verdict: ModeratorVerdict,
): Effect.Effect<void> {
  return emitReleaseFrame({
    stateRef: args.opts.stateRef,
    recipientConnId: args.lease.recipientConnId,
    dispatchId: args.lease.dispatchId,
    leaseId: args.lease.leaseId,
    verdict,
    leaseTimeoutMs:
      args.verdict._tag === "grant" ? args.lease.leaseTimeoutMs : null,
  });
}

function scheduleExpiryIfGranted(args: {
  readonly lease: LeaseRecord;
  readonly opts: HandleInboundFrameOpts;
  readonly verdict: ModeratorVerdict;
}): Effect.Effect<void> {
  if (args.verdict._tag !== "grant") return Effect.void;
  return Effect.gen(function* () {
    const expiredFiber = yield* Effect.forkDaemon(expireLeaseAfterTtl(args));
    args.lease.expiryFiber = expiredFiber;
  });
}

function expireLeaseAfterTtl(args: {
  readonly lease: LeaseRecord;
  readonly opts: HandleInboundFrameOpts;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Effect.sleep(
      Duration.millis(args.lease.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS),
    );
    if (shouldSkipExpiry(args)) return;
    if (args.lease.state !== "CONSUMED") {
      args.lease.state = "EXPIRED";
    }
    yield* emitDispatchesExpired({
      stateRef: args.opts.stateRef,
      lease: args.lease,
      leaseIdOverride:
        args.opts.behavior === "expired-leaseid-mismatch"
          ? freshUuidV4()
          : null,
    });
  });
}

function shouldSkipExpiry(args: {
  readonly lease: LeaseRecord;
  readonly opts: HandleInboundFrameOpts;
}): boolean {
  if (
    args.lease.state === "CONSUMED" &&
    args.opts.behavior !== "expired-fires-after-consume"
  ) {
    return true;
  }
  return args.lease.state === "ABANDONED";
}

function awaitEarlierMintsEmitted(
  opts: HandleInboundFrameOpts,
  lease: LeaseRecord,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      const ready = yield* Ref.modify(opts.nextEmitIndexByRecipient, (m) => {
        const cur = m.get(lease.recipientConnId) ?? 0;
        return [cur >= lease.mintIndex, m] as const;
      });
      if (ready) return;
      yield* Effect.sleep(Duration.millis(25));
    }
  });
}

function pickWireVerdict(args: {
  readonly verdict: ModeratorVerdict;
  readonly behavior: BadServerBehavior;
}): ModeratorVerdict {
  if (args.behavior === "release-decision-mismatch") {
    switch (args.verdict._tag) {
      case "grant":
        return { _tag: "deny", reason: "synthetic-mismatch" };
      case "deny":
        return { _tag: "grant" };
      case "hold":
        return { _tag: "grant" };
    }
  }
  return args.verdict;
}
