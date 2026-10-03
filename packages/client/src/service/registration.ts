/** @file Crash-recoverable daemon identity binding over Registry and endpoint storage. */

import {
  AgentCard,
  AgentName,
  PrincipalId,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import {
  OperationId,
  Registry,
  RegistryRegisterRequest,
  type RegistryRegisterResult,
} from "@moltzap/identity/registry";
import { Data, Effect, Schema } from "effect";
import type {
  EndpointStore,
  IdentityBinding,
} from "../transport/history/index.js";
import type {
  DaemonBootstrap,
  DaemonConfigurationError,
} from "./configuration.js";
import {
  decodeCanonical,
  encodeCanonical,
  exactStruct,
} from "../transport/wire/index.js";

const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

/** Closed caller-supplied portion of one Registry bootstrap request. */
export const daemonRegistrationRequestSchema = exactStruct({
  operationId: OperationId,
  principalId: PrincipalId,
  agentName: AgentName,
});

/** Validated caller-supplied daemon registration request. */
export type DaemonRegistrationRequest =
  typeof daemonRegistrationRequestSchema.Type;

/** Registry transport or service failure without upstream implementation detail. */
export class DaemonRegistrationUpstreamError extends Data.TaggedError(
  "DaemonRegistrationUpstreamError",
) {}

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

/** Complete registration state exposed by status and catalog selection. */
export type DaemonRegistrationState =
  | Readonly<{ kind: "unregistered" }>
  | Readonly<{ kind: "active"; agentCard: VerifiedAgentCard }>;

const persistenceFailure = (): DaemonRegistrationPersistenceError =>
  new DaemonRegistrationPersistenceError();

const representationFailure = (): DaemonRegistrationRepresentationError =>
  new DaemonRegistrationRepresentationError();

const upstreamFailure = (): DaemonRegistrationUpstreamError =>
  new DaemonRegistrationUpstreamError();

const readBoundCard = (input: {
  readonly binding: IdentityBinding;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<VerifiedAgentCard, DaemonRegistrationRepresentationError> =>
  Effect.gen(function* () {
    const encodedCard = yield* decodeCanonical(
      AgentCard,
      input.binding.canonicalAgentCard,
    ).pipe(Effect.mapError(representationFailure));
    const agentCard = yield* AgentCard.verify({
      agentCard: encodedCard,
      registrySignerPublicKey:
        input.bootstrap.configuration.registrySignerPublicKey,
    }).pipe(Effect.mapError(representationFailure));
    if (
      input.binding.agentId !== agentCard.agentId ||
      input.bootstrap.agentPublicKey.x !== agentCard.publicKey.x
    ) {
      return yield* representationFailure();
    }
    return agentCard;
  });

/**
 * Reads startup identity state and re-verifies any durable binding.
 *
 * @param input Startup identity dependencies.
 * @param input.store Minimal durable identity store.
 * @param input.bootstrap Configured Registry and agent key authority.
 * @returns Either the sole unregistered state or one verified active card.
 */
export const readDaemonRegistrationState = (input: {
  readonly store: DaemonRegistrationStore;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<
  DaemonRegistrationState,
  DaemonRegistrationPersistenceError | DaemonRegistrationRepresentationError
> =>
  Effect.gen(function* () {
    const binding = yield* input.store
      .readIdentity()
      .pipe(Effect.mapError(persistenceFailure));
    if (binding === undefined) {
      return Object.freeze({
        kind: "unregistered",
      }) satisfies DaemonRegistrationState;
    }
    const agentCard = yield* readBoundCard({
      binding,
      bootstrap: input.bootstrap,
    });
    return Object.freeze({
      kind: "active",
      agentCard,
    }) satisfies DaemonRegistrationState;
  }).pipe(Effect.withSpan("readDaemonRegistrationState"));

/**
 * Loads the admission credential only while the store holds no identity
 * binding, so an unregistered daemon fails closed without it and a registered
 * daemon starts without reading it.
 *
 * @param input Startup admission dependencies.
 * @param input.store Minimal durable identity store.
 * @param input.bootstrap Configured deferred admission credential.
 * @returns Nothing once startup admission is satisfied.
 */
export const requireAdmissionWhileUnregistered = (input: {
  readonly store: Pick<DaemonRegistrationStore, "readIdentity">;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<
  void,
  DaemonRegistrationPersistenceError | DaemonConfigurationError
> =>
  input.store.readIdentity().pipe(
    Effect.mapError(persistenceFailure),
    Effect.flatMap((binding) =>
      binding === undefined
        ? Effect.asVoid(input.bootstrap.admissionCredential)
        : Effect.void,
    ),
    Effect.withSpan("requireAdmissionWhileUnregistered"),
  );

const makeRegistryRequest = (input: {
  readonly request: DaemonRegistrationRequest;
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
  result: Extract<RegistryRegisterResult, { readonly kind: "registered" }>,
  request: DaemonRegistrationRequest,
  bootstrap: DaemonBootstrap,
): boolean =>
  result.agentCard.principalId === request.principalId &&
  result.agentCard.agentName === request.agentName &&
  result.agentCard.publicKey.x === bootstrap.agentPublicKey.x;

const bindRegisteredIdentity = (input: {
  readonly result: Extract<
    RegistryRegisterResult,
    { readonly kind: "registered" }
  >;
  readonly request: DaemonRegistrationRequest;
  readonly bootstrap: DaemonBootstrap;
  readonly store: DaemonRegistrationStore;
}): Effect.Effect<
  void,
  DaemonRegistrationPersistenceError | DaemonRegistrationRepresentationError
> =>
  Effect.gen(function* () {
    if (!registrationMatches(input.result, input.request, input.bootstrap)) {
      return yield* representationFailure();
    }
    const canonicalAgentCard = yield* encodeCanonical(
      AgentCard,
      input.result.agentCard,
    ).pipe(Effect.mapError(representationFailure));
    yield* input.store
      .bindIdentity({
        agentId: input.result.agentCard.agentId,
        canonicalAgentCard,
      })
      .pipe(Effect.mapError(persistenceFailure));
  });

/**
 * Registers through Identity and commits a successful binding before return.
 *
 * @param input Complete registration dependencies.
 * @param input.request Closed caller-supplied registration fields.
 * @param input.store Minimal durable identity store.
 * @param input.bootstrap Configured public key, signer, and deferred admission
 *   credential, whose load failure refuses registration before Registry is called.
 * @returns The exact Registry result after any successful binding is durable.
 */
export const registerDaemonIdentity = (input: {
  readonly request: DaemonRegistrationRequest;
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
      yield* bindRegisteredIdentity({ ...input, result });
    }
    return result;
  }).pipe(Effect.withSpan("registerDaemonIdentity"));
