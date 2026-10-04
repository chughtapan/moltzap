/** @file Private address resolution from runtime names to immutable cards. */

import type { Registry } from "@moltzap/identity/registry";
import { AgentName, type VerifiedAgentCard } from "@moltzap/identity";
import { type Context, Effect, Schema } from "effect";
import { compareAgentIds, maximumMembers } from "../wire/values.js";
import { SendError } from "./errors.js";

const AGENT_ADDRESS_PREFIX = "agent:";
const GROUP_ADDRESS_PREFIX = "group:";

const isAgentName = Schema.is(AgentName);

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Effect Schemas share their domain names with the nominal values they decode. */

/**
 * The registry name an `agent:` address names.
 * @param value A candidate address.
 * @returns The name, or undefined when the value is not an agent address.
 */
export function parseAgentAddress(value: string): string | undefined {
  if (!value.startsWith(AGENT_ADDRESS_PREFIX)) {
    return undefined;
  }
  const name = value.slice(AGENT_ADDRESS_PREFIX.length);
  return isAgentName(name) ? name : undefined;
}

/**
 * The names a `group:` address lists, in the order given.
 * @param value A candidate address.
 * @returns The names, or undefined when the value is not a group address.
 */
export function parseGroupAddress(
  value: string,
): readonly string[] | undefined {
  if (!value.startsWith(GROUP_ADDRESS_PREFIX)) {
    return undefined;
  }
  const names = value.slice(GROUP_ADDRESS_PREFIX.length).split(",");
  return names.length > 0 && names.every((name) => isAgentName(name))
    ? names
    : undefined;
}

const addressInput = Schema.String.pipe(
  Schema.filter(
    (value) =>
      parseAgentAddress(value) !== undefined ||
      parseGroupAddress(value) !== undefined,
    {
      identifier: "MessageAddressInput",
      description: "An agent address or syntactically valid group input",
    },
  ),
  Schema.brand("MessageAddressInput"),
);

/** An explicit direct destination using one canonical Registry name. */
export const AgentAddress = addressInput.pipe(
  Schema.filter((value) => parseAgentAddress(value) !== undefined),
  Schema.brand("AgentAddress"),
  Schema.annotations({ identifier: "AgentAddress" }),
);
/** A validated direct destination. */
export type AgentAddress = typeof AgentAddress.Type;

/** A complete fixed-member group address in unsigned ASCII name order. */
export const GroupAddress = addressInput.pipe(
  Schema.filter(isCanonicalGroupAddress),
  Schema.brand("GroupAddress"),
  Schema.annotations({ identifier: "GroupAddress" }),
);
/** A validated canonical complete group destination. */
export type GroupAddress = typeof GroupAddress.Type;

/** Either accepted destination input, including noncanonical group order. */
export const MessageAddressInput = addressInput;
/** A validated explicit destination input. */
export type MessageAddressInput = typeof MessageAddressInput.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore the package naming rules after the Schema/type pairs. */

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
  return canonicalMessageAddress(input.to, input.localAgentCard.agentName).pipe(
    Effect.flatMap(
      (canonical): Effect.Effect<ResolvedMessageAddress, SendError> =>
        canonical.kind === "direct"
          ? resolveDirect(input, canonical)
          : resolveGroup(input, canonical),
    ),
  );
}

/** A destination in canonical form, before any Registry lookup. */
export type CanonicalMessageAddress =
  | {
      readonly kind: "direct";
      readonly address: AgentAddress;
      readonly remoteName: AgentName;
    }
  | {
      readonly kind: "group";
      readonly address: GroupAddress;
      readonly memberNames: readonly AgentName[];
    };

/**
 * Put one destination in canonical form, the rule every send shares. An
 * `agent:` address names one other agent. A `group:` address names each agent
 * once and the local agent is added when absent. Naming one other agent makes
 * it that agent's direct address, since the two-member set is the direct
 * conversation; otherwise the complete group has 3 to `maximumMembers` members
 * in unsigned ASCII name order.
 * @param to The validated destination input.
 * @param localAgentName The local agent's Registry name.
 * @returns The canonical address with its names, local agent included for a
 *   group, or `invalid-address` or `membership-invalid`.
 */
export function canonicalMessageAddress(
  to: MessageAddressInput,
  localAgentName: string,
): Effect.Effect<CanonicalMessageAddress, SendError> {
  return to.startsWith(AGENT_ADDRESS_PREFIX)
    ? canonicalDirect(to, localAgentName)
    : canonicalGroup(to, localAgentName);
}

/**
 * Unsigned ASCII order, the order a canonical group address lists its names in.
 * @param left One name.
 * @param right The other name.
 * @returns Negative, zero, or positive as `left` sorts before, with, or after `right`.
 */
export function compareAscii(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

function invalidAddress(): SendError {
  return new SendError({ reason: "invalid-address" });
}

function invalidMembership(detail: string): SendError {
  return new SendError({ reason: "membership-invalid", detail });
}

function unknownAgent(agentName: AgentName): SendError {
  return new SendError({
    reason: "unknown-agent",
    detail: `${AGENT_ADDRESS_PREFIX}${agentName} is not a known agent`,
  });
}

function mapRegistryFailure(error: { readonly _tag: string }): SendError {
  return new SendError({
    reason:
      error._tag === "VersionMismatchError"
        ? "version-mismatch"
        : "network-unavailable",
  });
}

function isCanonicalGroupAddress(value: string): boolean {
  const names = parseGroupAddress(value);
  if (
    names === undefined ||
    names.length < 3 ||
    names.length > maximumMembers
  ) {
    return false;
  }
  for (let index = 1; index < names.length; index += 1) {
    const previous = names[index - 1];
    const current = names[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareAscii(previous, current) >= 0
    ) {
      return false;
    }
  }
  return true;
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
        return Effect.fail(unknownAgent(agentName));
      }
      return result.agentCard.agentName === agentName
        ? Effect.succeed(result.agentCard)
        : Effect.fail(unknownAgent(agentName));
    }),
  );
}

function canonicalDirect(
  to: MessageAddressInput,
  localAgentName: string,
): Effect.Effect<CanonicalMessageAddress, SendError> {
  return Effect.gen(function* () {
    const remoteName = yield* decodeAgentName(
      to.slice(AGENT_ADDRESS_PREFIX.length),
    );
    if (remoteName === localAgentName) {
      return yield* invalidMembership("the address names only you");
    }
    const address = yield* Schema.decodeUnknown(AgentAddress)(to).pipe(
      Effect.mapError(invalidAddress),
    );
    return { kind: "direct", address, remoteName };
  });
}

function canonicalGroup(
  to: MessageAddressInput,
  localAgentName: string,
): Effect.Effect<CanonicalMessageAddress, SendError> {
  return Effect.gen(function* () {
    const explicitNames = yield* Effect.forEach(
      to.slice(GROUP_ADDRESS_PREFIX.length).split(","),
      decodeAgentName,
      { concurrency: 1 },
    );
    if (new Set(explicitNames).size !== explicitNames.length) {
      return yield* invalidMembership(
        "the address names an agent more than once",
      );
    }
    const localName = yield* decodeAgentName(localAgentName);
    const memberNames = explicitNames.includes(localName)
      ? explicitNames.slice()
      : [...explicitNames, localName];
    const others = memberNames.filter((name) => name !== localName);
    const [onlyOther] = others;
    if (onlyOther === undefined) {
      return yield* invalidMembership("the address names only you");
    }
    if (others.length === 1) {
      const address = yield* Schema.decodeUnknown(AgentAddress)(
        `${AGENT_ADDRESS_PREFIX}${onlyOther}`,
      ).pipe(Effect.mapError(invalidAddress));
      return { kind: "direct", address, remoteName: onlyOther };
    }
    if (memberNames.length > maximumMembers) {
      return yield* invalidMembership(
        `a group has at most ${String(maximumMembers)} members`,
      );
    }
    memberNames.sort(compareAscii);
    const address = yield* Schema.decodeUnknown(GroupAddress)(
      `${GROUP_ADDRESS_PREFIX}${memberNames.join(",")}`,
    ).pipe(Effect.mapError(invalidAddress));
    return { kind: "group", address, memberNames };
  });
}

function resolveDirect(
  input: ResolveMessageAddressInput,
  canonical: Extract<CanonicalMessageAddress, { readonly kind: "direct" }>,
): Effect.Effect<ResolvedDirectAddress, SendError> {
  return Effect.gen(function* () {
    const remoteCard = yield* lookupCard(input.registry, canonical.remoteName);
    const ordered = orderMemberCards([input.localAgentCard, remoteCard]);
    const first = ordered[0];
    const second = ordered[1];
    if (first === undefined || second === undefined) {
      return yield* Effect.dieMessage("direct membership lost a member");
    }
    return {
      kind: "direct",
      address: canonical.address,
      memberCards: [first, second],
    };
  });
}

function resolveGroup(
  input: ResolveMessageAddressInput,
  canonical: Extract<CanonicalMessageAddress, { readonly kind: "group" }>,
): Effect.Effect<ResolvedGroupAddress, SendError> {
  return Effect.gen(function* () {
    const resolved = yield* Effect.forEach(
      canonical.memberNames,
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
    return {
      kind: "group",
      address: canonical.address,
      memberCards: [first, second, third, ...ordered.slice(3)],
    };
  });
}
