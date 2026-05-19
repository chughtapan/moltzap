/**
 * Unit tests for the canonical lease primitives.
 *
 * Covers:
 * - `LeaseAlreadyConsumed` shape + tag narrowing + structural equality.
 * - `projectLeaseInvalid` predicate (4 cases per spec C #597 AC).
 * - `catchLeaseInvalid` Effect-pipe wrapper (typed branch + pass-through).
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Effect, Either, Equal, Match, TestClock, TestContext } from "effect";
import { RpcServerError } from "@moltzap/protocol";
import {
  LeaseAlreadyConsumed,
  catchLeaseInvalid,
  projectLeaseInvalid,
} from "../../channel-base/lease.js";

const FIXED_TS = 1_700_000_000_000;
const SAMPLE_LEASE_ID = "lease-abc-123";
const NON_LEASE_ERROR_MESSAGE = "boom";
const LEASE_MESSAGE = "lease consumed";
const FORBIDDEN_ERROR_CODE = -32001;
const FORWARD_COMPAT_TAG_CODE = -32099;
const INTERNAL_ERROR_CODE = -32603;
const LEASE_ID_FALLBACK = "(unknown)";
// Forward-compat: server may later emit the canonical lease-error tag inside
// the wire payload's `data._tag`. The predicate accepts that shape too.
const FORWARD_COMPAT_LEASE_TAG = "LeaseAlreadyConsumed";

function leaseInvalidWire(): RpcServerError {
  return new RpcServerError({
    code: FORBIDDEN_ERROR_CODE,
    message: LEASE_MESSAGE,
    data: { reason: "LeaseInvalid", state: "CONSUMED", expected: "OPEN" },
  });
}

function leaseTagInvalidWire(): RpcServerError {
  return new RpcServerError({
    code: FORWARD_COMPAT_TAG_CODE,
    message: LEASE_MESSAGE,
    // eslint-disable-next-line agent-code-guard/manual-tagged-error -- simulating wire payload shape; this is the literal predicate input the projector must accept
    data: { _tag: FORWARD_COMPAT_LEASE_TAG, leaseId: SAMPLE_LEASE_ID },
  });
}

function genericWire(): RpcServerError {
  return new RpcServerError({
    code: INTERNAL_ERROR_CODE,
    message: NON_LEASE_ERROR_MESSAGE,
    data: { reason: "InternalError" },
  });
}

function projectedToTyped(
  err: LeaseAlreadyConsumed | RpcServerError,
): LeaseAlreadyConsumed {
  if (!(err instanceof LeaseAlreadyConsumed)) {
    throw new Error("expected typed LeaseAlreadyConsumed projection");
  }
  return err;
}

describe("LeaseAlreadyConsumed canonical shape", () => {
  it(
    "property: projector populates the canonical fields for any leaseId/consumedAt",
    propertyCanonicalFields,
  );
  it("narrows via Match.tag", narrowsViaMatchTag);
  it(
    "supports structural equality on identical fields",
    structuralEqualityHolds,
  );
  it(
    "preserves the original RpcServerError on cause for host inspection",
    preservesCauseForHosts,
  );
});

describe("projectLeaseInvalid predicate", () => {
  it(
    "property: every RpcServerError with data.reason='LeaseInvalid' projects",
    propertyReasonArmProjects,
  );
  it(
    "projects when data._tag matches the forward-compat tag",
    projectsOnForwardCompatTag,
  );
  it(
    "passes the original error through when neither discriminant matches",
    passesThroughGenericError,
  );
  it("falls back to '(unknown)' leaseId when ctx omits it", fallsBackOnLeaseId);
});

describe("catchLeaseInvalid Effect-pipe wrapper", () => {
  it("surfaces LeaseAlreadyConsumed on the failure channel for matching errors", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(FIXED_TS);
        const wire = leaseInvalidWire();
        const result = yield* Effect.either(
          Effect.fail<RpcServerError>(wire).pipe(
            catchLeaseInvalid({ leaseId: SAMPLE_LEASE_ID }),
          ),
        );
        Either.match(result, {
          onLeft: (err) => {
            const typed = projectedToTyped(err);
            expect(typed.leaseId).toBe(SAMPLE_LEASE_ID);
            expect(typed.consumedAt).toBe(FIXED_TS);
            expect(typed.cause).toBe(wire);
          },
          onRight: () => {
            throw new Error(
              "expected the lease wire error on the failure channel",
            );
          },
        });
      }).pipe(Effect.provide(TestContext.TestContext)),
    ));
  it("re-raises non-matching RpcServerError unchanged (pass-through)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const wire = genericWire();
        const result = yield* Effect.either(
          Effect.fail<RpcServerError>(wire).pipe(
            catchLeaseInvalid({ leaseId: SAMPLE_LEASE_ID }),
          ),
        );
        Either.match(result, {
          onLeft: (err) => expect(err).toBe(wire),
          onRight: () => {
            throw new Error(
              "expected generic wire error on the failure channel",
            );
          },
        });
      }),
    ));
});

function propertyCanonicalFields(): void {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 32 }),
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      assertProjectionPopulatesFields,
    ),
  );
}

function assertProjectionPopulatesFields(
  leaseId: string,
  consumedAt: number,
): void {
  const wire = leaseInvalidWire();
  const typed = projectedToTyped(
    projectLeaseInvalid(wire, { leaseId, consumedAt }),
  );
  expect(typed.leaseId).toBe(leaseId);
  expect(typed.consumedAt).toBe(consumedAt);
  expect(typed.cause).toBe(wire);
  expect(typed.message).toBe(LEASE_MESSAGE);
}

function narrowsViaMatchTag(): void {
  const wire = leaseInvalidWire();
  const projected = projectLeaseInvalid(wire, {
    leaseId: SAMPLE_LEASE_ID,
    consumedAt: FIXED_TS,
  });
  const branch = Match.value(projected).pipe(
    Match.tag("LeaseAlreadyConsumed", (e) => `typed:${e.leaseId}`),
    Match.tag("RpcServerError", () => "rpc"),
    Match.exhaustive,
  );
  expect(branch).toBe(`typed:${SAMPLE_LEASE_ID}`);
}

function structuralEqualityHolds(): void {
  const wire = leaseInvalidWire();
  const a = new LeaseAlreadyConsumed({
    leaseId: SAMPLE_LEASE_ID,
    consumedAt: FIXED_TS,
    cause: wire,
    message: LEASE_MESSAGE,
  });
  const b = new LeaseAlreadyConsumed({
    leaseId: SAMPLE_LEASE_ID,
    consumedAt: FIXED_TS,
    cause: wire,
    message: LEASE_MESSAGE,
  });
  expect(Equal.equals(a, b)).toBe(true);
}

function preservesCauseForHosts(): void {
  const wire = leaseInvalidWire();
  const typed = projectedToTyped(
    projectLeaseInvalid(wire, {
      leaseId: SAMPLE_LEASE_ID,
      consumedAt: FIXED_TS,
    }),
  );
  expect(typed.cause.code).toBe(FORBIDDEN_ERROR_CODE);
  expect(typed.cause.data).toEqual({
    reason: "LeaseInvalid",
    state: "CONSUMED",
    expected: "OPEN",
  });
}

function propertyReasonArmProjects(): void {
  fc.assert(
    fc.property(
      fc.string({ minLength: 1, maxLength: 32 }),
      fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
      (leaseId, consumedAt) => {
        const wire = leaseInvalidWire();
        const out = projectLeaseInvalid(wire, { leaseId, consumedAt });
        expect(out).toBeInstanceOf(LeaseAlreadyConsumed);
      },
    ),
  );
}

function projectsOnForwardCompatTag(): void {
  const wire = leaseTagInvalidWire();
  const out = projectLeaseInvalid(wire, {
    leaseId: SAMPLE_LEASE_ID,
    consumedAt: FIXED_TS,
  });
  expect(out).toBeInstanceOf(LeaseAlreadyConsumed);
}

function passesThroughGenericError(): void {
  const wire = genericWire();
  const out = projectLeaseInvalid(wire, {
    leaseId: SAMPLE_LEASE_ID,
    consumedAt: FIXED_TS,
  });
  expect(out).toBe(wire);
  expect(out).not.toBeInstanceOf(LeaseAlreadyConsumed);
}

function fallsBackOnLeaseId(): void {
  const wire = leaseInvalidWire();
  const typed = projectedToTyped(
    projectLeaseInvalid(wire, { consumedAt: FIXED_TS }),
  );
  expect(typed.leaseId).toBe(LEASE_ID_FALLBACK);
}
