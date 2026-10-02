/**
 * @file A gather's request posts while they are sent, and how each one is
 * settled when the requester stops waiting.
 */

import { Effect, Either, Exit, Fiber, Option } from "effect";
import type { AgentAddress, SendError } from "../../contract.js";
import type { EngineSentPost } from "../engine-types.js";

/** A member whose request post was refused, and why. */
export type RequestRefusal = Readonly<{
  member: AgentAddress;
  reason: SendError["reason"];
}>;

/** A request post in flight, resolving to the member's refusal, if any. */
export type RequestSend = Fiber.RuntimeFiber<
  Either.Either<EngineSentPost, RequestRefusal>
>;

/**
 * One member's request send once the wait has ended: its post, its refusal,
 * or, still pending, interrupted and reported `certification-unavailable`.
 * @param member The member the post asks.
 * @param send The post's send, possibly still running.
 * @returns The certified post, or the member's refusal.
 */
export function settleRequest(
  member: AgentAddress,
  send: RequestSend,
): Effect.Effect<Either.Either<EngineSentPost, RequestRefusal>> {
  const pending = Either.left<RequestRefusal>({
    member,
    reason: "certification-unavailable",
  });
  return Fiber.poll(send).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Fiber.interruptFork(send).pipe(Effect.as(pending)),
        onSome: (exit) =>
          Effect.succeed(Exit.isSuccess(exit) ? exit.value : pending),
      }),
    ),
  );
}

/** How many Registry lookups run at once; a group has at most 32 members. */
const MEMBER_LOOKUP_CONCURRENCY = 8;

/**
 * Failures that address resolution alone determines, so the send can refuse
 * them before any post.
 */
const ADDRESS_FAILURES: ReadonlySet<SendError["reason"]> = new Set([
  "invalid-address",
  "unknown-agent",
  "membership-invalid",
]);

/**
 * Whether a member's refusal is an address error rather than a delivery
 * failure.
 * @param refusal A member's lookup or post refusal.
 * @returns True for a malformed or unknown member or invalid membership.
 */
export const isAddressRefusal = (refusal: RequestRefusal): boolean =>
  ADDRESS_FAILURES.has(refusal.reason);

/**
 * Look up every member and name each whose lookup fails, in member order.
 * @param members The members to resolve.
 * @param lookup The engine's address resolution for one member.
 * @returns Each failing member with its reason; empty when all resolve.
 */
export const lookupRefusals = (
  members: readonly AgentAddress[],
  lookup: (member: AgentAddress) => Effect.Effect<void, SendError>,
): Effect.Effect<RequestRefusal[]> =>
  Effect.forEach(
    members,
    (member) =>
      lookup(member).pipe(
        Effect.flip,
        Effect.map(
          (error): RequestRefusal => ({ member, reason: error.reason }),
        ),
        Effect.option,
      ),
    { concurrency: MEMBER_LOOKUP_CONCURRENCY },
  ).pipe(
    Effect.map((lookups) => lookups.flatMap((found) => Option.toArray(found))),
  );
