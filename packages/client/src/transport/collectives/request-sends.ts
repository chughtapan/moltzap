/**
 * @file A gather's request posts while they are sent, and how each one is
 * settled when the requester stops waiting.
 */

import {
  Effect,
  Array as EffectArray,
  Either,
  Exit,
  Fiber,
  Option,
} from "effect";
import type { AgentAddress } from "../messaging/address.js";
import type { SendError } from "../messaging/errors.js";
import type { EngineSentPost } from "../messaging/index.js";

/** A member whose request post was refused, and why. */
export type RequestRefusal = Readonly<{
  member: AgentAddress;
  reason: SendError["reason"];
}>;

/** A request post in flight, resolving to the member's refusal, if any. */
export type RequestSend = Fiber.RuntimeFiber<
  Either.Either<EngineSentPost, RequestRefusal>
>;

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

/**
 * Where a gather's request posts stand when the send stops waiting: each
 * certified post and each member refused. A send still pending keeps
 * running and is in neither.
 * @param members The members asked, in the order of their sends.
 * @param sends Each member's request send.
 * @returns The posts and refusals, in member order.
 */
export const requestsSoFar = (
  members: readonly AgentAddress[],
  sends: readonly RequestSend[],
): Effect.Effect<{
  readonly posts: EngineSentPost[];
  readonly refused: RequestRefusal[];
}> =>
  Effect.forEach(
    EffectArray.zip(members, sends),
    ([member, send]) =>
      Fiber.poll(send).pipe(
        Effect.map((poll) => ({
          member,
          result: Option.flatMap(poll, (exit) =>
            Exit.isSuccess(exit) ? Option.some(exit.value) : Option.none(),
          ),
        })),
      ),
    { concurrency: 1 },
  ).pipe(
    Effect.map((states) => ({
      posts: states.flatMap(({ result }) =>
        Option.toArray(Option.flatMap(result, Either.getRight)),
      ),
      refused: states.flatMap(({ result }) =>
        Option.toArray(Option.flatMap(result, Either.getLeft)),
      ),
    })),
  );
