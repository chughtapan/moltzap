/** @file The daemon's durable identity row: read, verify and bind. */

import { AgentCard, type VerifiedAgentCard } from "@moltzap/identity";
import { Data, Effect } from "effect";
import type { EndpointStore, IdentityBinding } from "../../store/index.js";
import type { DaemonBootstrap } from "../bootstrap.js";
import {
  decodeCanonical,
  encodeCanonical,
} from "../../transport/wire/index.js";

/** Endpoint identity state could not be read or atomically committed. */
export class DaemonRegistrationPersistenceError extends Data.TaggedError(
  "DaemonRegistrationPersistenceError",
) {}

/** Configured or durable identity bytes disagree with their closed bindings. */
export class DaemonRegistrationRepresentationError extends Data.TaggedError(
  "DaemonRegistrationRepresentationError",
) {}

/** Minimum endpoint-store authority used during identity bootstrap. */
export interface DaemonRegistrationStore {
  readonly readIdentity: EndpointStore["readIdentity"];
  readonly bindIdentity: EndpointStore["bindIdentity"];
}

const persistenceFailure = (): DaemonRegistrationPersistenceError =>
  new DaemonRegistrationPersistenceError();

const representationFailure = (): DaemonRegistrationRepresentationError =>
  new DaemonRegistrationRepresentationError();

const verifyBinding = (
  binding: IdentityBinding,
  bootstrap: DaemonBootstrap,
): Effect.Effect<VerifiedAgentCard, DaemonRegistrationRepresentationError> =>
  Effect.gen(function* () {
    const encodedCard = yield* decodeCanonical(
      AgentCard,
      binding.canonicalAgentCard,
    ).pipe(Effect.mapError(representationFailure));
    const agentCard = yield* AgentCard.verify({
      agentCard: encodedCard,
      registrySignerPublicKey: bootstrap.configuration.registrySignerPublicKey,
    }).pipe(Effect.mapError(representationFailure));
    if (
      binding.agentId !== agentCard.agentId ||
      bootstrap.agentPublicKey.x !== agentCard.publicKey.x
    ) {
      return yield* representationFailure();
    }
    return agentCard;
  });

/**
 * Reads the durable identity row and re-verifies its card against the
 * configured Registry signer and agent key. Resolves to undefined while no
 * identity is bound.
 */
export const readBoundCard = (input: {
  readonly store: Pick<DaemonRegistrationStore, "readIdentity">;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<
  VerifiedAgentCard | undefined,
  DaemonRegistrationPersistenceError | DaemonRegistrationRepresentationError
> =>
  input.store.readIdentity().pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((binding) =>
      binding === undefined
        ? Effect.succeed(undefined)
        : verifyBinding(binding, input.bootstrap),
    ),
  );

/** Commits a Registry-issued card as the durable identity row. */
export const bindCard = (
  store: DaemonRegistrationStore,
  agentCard: VerifiedAgentCard,
): Effect.Effect<
  void,
  DaemonRegistrationPersistenceError | DaemonRegistrationRepresentationError
> =>
  encodeCanonical(AgentCard, agentCard).pipe(
    Effect.mapError(representationFailure),
    Effect.flatMap((canonicalAgentCard) =>
      store
        .bindIdentity({ agentId: agentCard.agentId, canonicalAgentCard })
        .pipe(Effect.mapError(persistenceFailure)),
    ),
    Effect.asVoid,
  );
