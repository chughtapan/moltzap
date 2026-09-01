/** @file Private address resolution from runtime names to immutable cards. */

import type { Registry } from "@moltzap/identity/registry";
import { AgentName, type VerifiedAgentCard } from "@moltzap/identity";
import { type Context, Effect, Schema } from "effect";
import {
  AgentAddress,
  GroupAddress,
  type MessageAddressInput,
  SendError,
} from "../../contract.js";
import { compareAgentIds } from "../representation.js";

const AGENT_ADDRESS_PREFIX = "agent:";
const GROUP_ADDRESS_PREFIX = "group:";
const MAXIMUM_GROUP_MEMBERS = 32;

/** Minimal Registry capability required by address resolution. */
export type AddressRegistryPort = Pick<
  Context.Tag.Service<typeof Registry>,
  "lookup"
>;

/** Resolved deterministic membership for a direct destination. */
interface ResolvedDirectAddress {
  readonly kind: "direct";
  readonly address: AgentAddress;
  readonly memberCards: readonly [VerifiedAgentCard, VerifiedAgentCard];
}

/** Resolved deterministic membership for a fixed group destination. */
interface ResolvedGroupAddress {
  readonly kind: "group";
  readonly address: GroupAddress;
  readonly memberCards: readonly [
    VerifiedAgentCard,
    VerifiedAgentCard,
    VerifiedAgentCard,
    ...VerifiedAgentCard[],
  ];
}

/** Address resolution retains both the runtime spelling and private cards. */
export type ResolvedMessageAddress =
  | ResolvedDirectAddress
  | ResolvedGroupAddress;

interface ResolveMessageAddressInput {
  readonly localAgentCard: VerifiedAgentCard;
  readonly registry: AddressRegistryPort;
  readonly to: MessageAddressInput;
}

/**
 * Resolve one explicit runtime destination to canonical immutable membership.
 * @param input Local verified identity, Registry lookup, and validated input.
 * @returns The canonical runtime address and AgentId-ordered verified cards.
 */
export function resolveMessageAddress(
  input: ResolveMessageAddressInput,
): Effect.Effect<ResolvedMessageAddress, SendError> {
  return input.to.startsWith(AGENT_ADDRESS_PREFIX)
    ? resolveDirect(input)
    : resolveGroup(input);
}

function invalidAddress(): SendError {
  return new SendError({ reason: "invalid-address" });
}

function invalidMembership(): SendError {
  return new SendError({ reason: "membership-invalid" });
}

function mapRegistryFailure(error: { readonly _tag: string }): SendError {
  return new SendError({
    reason:
      error._tag === "VersionMismatchError"
        ? "version-mismatch"
        : "network-unavailable",
  });
}

function compareAscii(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function orderMemberCards(
  cards: readonly VerifiedAgentCard[],
): readonly VerifiedAgentCard[] {
  const ordered = cards.slice();
  ordered.sort((left, right) => compareAgentIds(left.agentId, right.agentId));
  return ordered;
}

function decodeAgentName(value: string): Effect.Effect<AgentName, SendError> {
  return Schema.decodeUnknown(AgentName)(value).pipe(
    Effect.mapError(invalidAddress),
  );
}

function lookupCard(
  registry: AddressRegistryPort,
  agentName: AgentName,
): Effect.Effect<VerifiedAgentCard, SendError> {
  return registry.lookup({ agentName }).pipe(
    Effect.mapError(mapRegistryFailure),
    Effect.flatMap((result) => {
      if (result.kind === "not_found") {
        return Effect.fail(new SendError({ reason: "unknown-agent" }));
      }
      return result.agentCard.agentName === agentName
        ? Effect.succeed(result.agentCard)
        : Effect.fail(new SendError({ reason: "unknown-agent" }));
    }),
  );
}

function resolveDirect(
  input: ResolveMessageAddressInput,
): Effect.Effect<ResolvedDirectAddress, SendError> {
  return Effect.gen(function* () {
    const agentName = yield* decodeAgentName(
      input.to.slice(AGENT_ADDRESS_PREFIX.length),
    );
    if (agentName === input.localAgentCard.agentName) {
      return yield* invalidMembership();
    }
    const remoteCard = yield* lookupCard(input.registry, agentName);
    const ordered = orderMemberCards([input.localAgentCard, remoteCard]);
    const first = ordered[0];
    const second = ordered[1];
    if (first === undefined || second === undefined) {
      return yield* Effect.dieMessage("direct membership lost a member");
    }
    const address = yield* Schema.decodeUnknown(AgentAddress)(input.to).pipe(
      Effect.mapError(invalidAddress),
    );
    return {
      kind: "direct",
      address,
      memberCards: [first, second],
    };
  });
}

function resolveGroup(
  input: ResolveMessageAddressInput,
): Effect.Effect<ResolvedGroupAddress, SendError> {
  return Effect.gen(function* () {
    const explicitNames = yield* Effect.forEach(
      input.to.slice(GROUP_ADDRESS_PREFIX.length).split(","),
      decodeAgentName,
      { concurrency: 1 },
    );
    if (new Set(explicitNames).size !== explicitNames.length) {
      return yield* invalidMembership();
    }
    const completeNames = explicitNames.includes(input.localAgentCard.agentName)
      ? explicitNames
      : [...explicitNames, input.localAgentCard.agentName];
    if (
      completeNames.length < 3 ||
      completeNames.length > MAXIMUM_GROUP_MEMBERS
    ) {
      return yield* invalidMembership();
    }
    const resolved = yield* Effect.forEach(
      completeNames,
      (agentName) =>
        agentName === input.localAgentCard.agentName
          ? Effect.succeed(input.localAgentCard)
          : lookupCard(input.registry, agentName),
      { concurrency: 1 },
    );
    const ordered = orderMemberCards(resolved);
    const first = ordered[0];
    const second = ordered[1];
    const third = ordered[2];
    if (first === undefined || second === undefined || third === undefined) {
      return yield* Effect.dieMessage("group membership lost a member");
    }
    const canonicalNames = completeNames.slice();
    canonicalNames.sort(compareAscii);
    const address = yield* Schema.decodeUnknown(GroupAddress)(
      `${GROUP_ADDRESS_PREFIX}${canonicalNames.join(",")}`,
    ).pipe(Effect.mapError(invalidAddress));
    return {
      kind: "group",
      address,
      memberCards: [first, second, third, ...ordered.slice(3)],
    };
  });
}
