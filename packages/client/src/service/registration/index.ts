/** @file Crash-recoverable daemon identity binding over Registry and endpoint storage. */

import type { VerifiedAgentCard } from "@moltzap/identity";
import {
  Registry,
  RegistryRegisterRequest,
  type RegistryRegisterResult,
} from "@moltzap/identity/registry";
import { Data, Effect, Schema } from "effect";
import type { HarnessMcpOperations } from "../../endpoint/mcp/index.js";
import type {
  DaemonBootstrap,
  DaemonConfigurationError,
} from "../bootstrap.js";
import {
  bindCard,
  DaemonRegistrationPersistenceError,
  DaemonRegistrationRepresentationError,
  type DaemonRegistrationStore,
  readBoundCard,
} from "./binding.js";

/** Durable identity row errors and the store authority registration needs. */
export {
  DaemonRegistrationPersistenceError,
  DaemonRegistrationRepresentationError,
  type DaemonRegistrationStore,
};

/** Registry transport or service failure without upstream implementation detail. */
export class DaemonRegistrationUpstreamError extends Data.TaggedError(
  "DaemonRegistrationUpstreamError",
) {}

/** Complete registration state exposed by status and catalog selection. */
export type DaemonRegistrationState =
  | Readonly<{ kind: "unregistered" }>
  | Readonly<{ kind: "active"; agentCard: VerifiedAgentCard }>;

type RegistrationRequest = Parameters<HarnessMcpOperations["register"]>[0];

const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

const representationFailure = (): DaemonRegistrationRepresentationError =>
  new DaemonRegistrationRepresentationError();

const upstreamFailure = (): DaemonRegistrationUpstreamError =>
  new DaemonRegistrationUpstreamError();

/**
 * Reads startup identity state and re-verifies any durable binding.
 *
 * @param input Startup identity dependencies.
 * @param input.store Minimal durable identity store.
 * @param input.bootstrap Configured Registry and agent key authority.
 * @returns Either the sole unregistered state or one verified active card.
 */
export const readDaemonRegistrationState = (input: {
  readonly store: Pick<DaemonRegistrationStore, "readIdentity">;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<
  DaemonRegistrationState,
  DaemonRegistrationPersistenceError | DaemonRegistrationRepresentationError
> =>
  readBoundCard(input).pipe(
    Effect.map(
      (agentCard): DaemonRegistrationState =>
        agentCard === undefined
          ? Object.freeze({ kind: "unregistered" })
          : Object.freeze({ kind: "active", agentCard }),
    ),
    Effect.withSpan("readDaemonRegistrationState"),
  );

/**
 * Loads the admission credential only while the daemon is unregistered, so an
 * unregistered daemon fails closed without it and a registered daemon starts
 * without reading it.
 *
 * @param state The registration state read once at startup.
 * @param bootstrap Configured deferred admission credential.
 * @returns Nothing once startup admission is satisfied.
 */
export const requireAdmission = (
  state: DaemonRegistrationState,
  bootstrap: DaemonBootstrap,
): Effect.Effect<void, DaemonConfigurationError> =>
  (state.kind === "unregistered"
    ? Effect.asVoid(bootstrap.admissionCredential)
    : Effect.void
  ).pipe(Effect.withSpan("requireAdmission"));

const makeRegistryRequest = (input: {
  readonly request: RegistrationRequest;
  readonly bootstrap: DaemonBootstrap;
}) =>
  Schema.decodeUnknown(RegistryRegisterRequest)(
    {
      operationId: input.request.operationId,
      principalId: input.request.principalId,
      agentName: input.request.agentName,
      publicKey: input.bootstrap.agentPublicKey,
    },
    exactOptions,
  ).pipe(Effect.mapError(representationFailure));

const registrationMatches = (
  agentCard: VerifiedAgentCard,
  request: RegistrationRequest,
  bootstrap: DaemonBootstrap,
): boolean =>
  agentCard.principalId === request.principalId &&
  agentCard.agentName === request.agentName &&
  agentCard.publicKey.x === bootstrap.agentPublicKey.x;

/**
 * Registers through Identity and commits a successful binding before return.
 * Only a `registered` result carries the verified card; the Registry's refusals
 * pass through unchanged and bind nothing.
 *
 * @param input Complete registration dependencies.
 * @param input.request Closed caller-supplied registration fields.
 * @param input.store Minimal durable identity store.
 * @param input.bootstrap Configured public key, signer, and deferred admission
 *   credential, whose load failure refuses registration before Registry is called.
 * @returns The exact Registry result after any successful binding is durable.
 */
export const registerDaemonIdentity = (input: {
  readonly request: RegistrationRequest;
  readonly store: DaemonRegistrationStore;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<
  RegistryRegisterResult,
  | DaemonRegistrationUpstreamError
  | DaemonRegistrationPersistenceError
  | DaemonRegistrationRepresentationError
  | DaemonConfigurationError,
  Registry
> =>
  Effect.gen(function* () {
    const request = yield* makeRegistryRequest(input);
    const admissionCredential = yield* input.bootstrap.admissionCredential;
    const result = yield* Registry.register({
      request,
      admissionCredential,
      signingAuthority: input.bootstrap.signingAuthority,
    }).pipe(Effect.mapError(upstreamFailure));
    if (result.kind === "registered") {
      if (
        !registrationMatches(result.agentCard, input.request, input.bootstrap)
      ) {
        return yield* representationFailure();
      }
      yield* bindCard(input.store, result.agentCard);
    }
    return result;
  }).pipe(Effect.withSpan("registerDaemonIdentity"));
