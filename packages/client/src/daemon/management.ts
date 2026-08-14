/** @file Private daemon management operations over Registry and endpoint state. */

import { AgentCard, type VerifiedAgentCard } from "@moltzap/identity";
import {
  Registry,
  RegistryInvalidResponseError,
  type RegistryListResult,
  type RegistryLookupResult,
  type RegistryRegisterResult,
} from "@moltzap/identity/registry";
import { type Context, Data, Effect, Schema } from "effect";
import type {
  ConversationPage,
  EndpointStore,
  EndpointStoreError,
  HistoryPage,
  CertifiedRecord as StoredCertifiedRecord,
} from "../endpoint/store.js";
import type { HarnessMcpOperations } from "../harness-mcp-wire.js";
import type {
  ManagementReadConversationResult,
  ManagementRegisterResult,
  ManagementSearchAgentsResult,
  ManagementStatusResult,
} from "../management-runtime.js";
import type { DaemonBootstrap } from "./configuration.js";
import { ConversationId } from "../contract.js";
import {
  CertifiedRecord,
  type CertifiedRecord as CertifiedRecordValue,
  decodeCanonical,
} from "../endpoint/representation.js";
import {
  type DaemonRegistrationPersistenceError,
  type DaemonRegistrationRepresentationError,
  type DaemonRegistrationUpstreamError,
  readDaemonRegistrationState,
  registerDaemonIdentity,
} from "./registration.js";

type ManagementOperation =
  | "readStatus"
  | "register"
  | "searchAgents"
  | "searchConversations"
  | "readConversation";

type ManagementFailure =
  | "invalid-continuation"
  | "not-found"
  | "persistence"
  | "representation"
  | "upstream";

type RegistryService = Context.Tag.Service<typeof Registry>;

class DaemonManagementError extends Data.TaggedError("DaemonManagementError")<{
  readonly reason: ManagementFailure;
}> {}

/** Closed management-only projection consumed by the MCP presentation. */
export type DaemonManagementOperations = Pick<
  HarnessMcpOperations,
  ManagementOperation
>;

const managementFailure = (reason: ManagementFailure): DaemonManagementError =>
  new DaemonManagementError({ reason });

const representationFailure = (): DaemonManagementError =>
  managementFailure("representation");

const encodeAgentCard = (
  agentCard: VerifiedAgentCard,
): Effect.Effect<unknown, DaemonManagementError> =>
  Schema.encode(AgentCard)(agentCard).pipe(
    Effect.mapError(representationFailure),
  );

const encodeRegisterResult = (
  result: RegistryRegisterResult,
): Effect.Effect<ManagementRegisterResult, DaemonManagementError> => {
  if (result.kind !== "registered") {
    return Effect.succeed(result);
  }
  return encodeAgentCard(result.agentCard).pipe(
    Effect.map((agentCard) => Object.freeze({ kind: "registered", agentCard })),
  );
};

const encodeStatus = (
  state:
    | Readonly<{ kind: "unregistered" }>
    | Readonly<{ kind: "active"; agentCard: VerifiedAgentCard }>,
): Effect.Effect<ManagementStatusResult, DaemonManagementError> => {
  if (state.kind === "unregistered") {
    return Effect.succeed(state);
  }
  return encodeAgentCard(state.agentCard).pipe(
    Effect.map((agentCard) => Object.freeze({ kind: "active", agentCard })),
  );
};

const mapRegistrationFailure = (
  error:
    | DaemonRegistrationPersistenceError
    | DaemonRegistrationRepresentationError
    | DaemonRegistrationUpstreamError,
): DaemonManagementError => {
  switch (error._tag) {
    case "DaemonRegistrationPersistenceError":
      return managementFailure("persistence");
    case "DaemonRegistrationRepresentationError":
      return representationFailure();
    case "DaemonRegistrationUpstreamError":
      return managementFailure("upstream");
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
};

const mapRegistryFailure = (error: unknown): DaemonManagementError =>
  error instanceof RegistryInvalidResponseError
    ? representationFailure()
    : managementFailure("upstream");

const encodeLookupResult = (
  result: RegistryLookupResult,
): Effect.Effect<ManagementSearchAgentsResult, DaemonManagementError> => {
  if (result.kind === "not_found") {
    return Effect.succeed(result);
  }
  return encodeAgentCard(result.agentCard).pipe(
    Effect.map((agentCard) => Object.freeze({ kind: "found", agentCard })),
  );
};

const encodeListResult = (
  result: RegistryListResult,
): Effect.Effect<ManagementSearchAgentsResult, DaemonManagementError> =>
  Effect.forEach(result.agentCards, encodeAgentCard, { concurrency: 1 }).pipe(
    Effect.map((agentCards) =>
      Object.freeze({ kind: "page", agentCards, hasMore: result.hasMore }),
    ),
  );

const decodeConversationId = (
  value: string,
): Effect.Effect<typeof ConversationId.Type, DaemonManagementError> =>
  Schema.decodeUnknown(ConversationId)(value).pipe(
    Effect.mapError(() => managementFailure("persistence")),
  );

const mapHistoryStoreFailure = (
  error: EndpointStoreError,
): DaemonManagementError => {
  if (error.reason === "invalid-continuation") {
    return managementFailure("invalid-continuation");
  }
  return error.reason === "not-found"
    ? managementFailure("not-found")
    : managementFailure("persistence");
};

const actionMatchesIndex = (
  record: CertifiedRecordValue,
  stored: StoredCertifiedRecord,
): boolean => {
  const action = record.actionCertifiedRecord.action;
  return (
    action.conversationId === stored.conversationId &&
    action.membershipHash === stored.membershipHash &&
    action.anchorHash === stored.anchorHash
  );
};

const recordMatchesIndex = (
  record: CertifiedRecordValue,
  stored: StoredCertifiedRecord,
): boolean => {
  const actionRecord = record.actionCertifiedRecord;
  return (
    record.recordHash === stored.recordHash &&
    actionRecord.membership.conversationId === stored.conversationId &&
    actionRecord.anchorHash === stored.anchorHash &&
    actionMatchesIndex(record, stored)
  );
};

const decodeStoredRecord = (
  stored: StoredCertifiedRecord,
): Effect.Effect<CertifiedRecordValue, DaemonManagementError> =>
  decodeCanonical(CertifiedRecord, stored.canonicalCertifiedRecord).pipe(
    Effect.mapError(representationFailure),
    Effect.filterOrFail(
      (record) => recordMatchesIndex(record, stored),
      representationFailure,
    ),
  );

const readStatusOperation =
  (input: {
    readonly store: EndpointStore;
    readonly bootstrap: DaemonBootstrap;
  }): DaemonManagementOperations["readStatus"] =>
  () =>
    readDaemonRegistrationState(input).pipe(
      Effect.mapError(mapRegistrationFailure),
      Effect.flatMap(encodeStatus),
    );

const registerOperation =
  (
    input: {
      readonly store: EndpointStore;
      readonly bootstrap: DaemonBootstrap;
    },
    registry: RegistryService,
  ): DaemonManagementOperations["register"] =>
  (request) =>
    registerDaemonIdentity({ ...input, request }).pipe(
      Effect.provideService(Registry, registry),
      Effect.mapError(mapRegistrationFailure),
      Effect.flatMap(encodeRegisterResult),
    );

const searchAgentsOperation =
  (registry: RegistryService): DaemonManagementOperations["searchAgents"] =>
  (request) => {
    if ("agentId" in request || "agentName" in request) {
      return registry
        .lookup(request)
        .pipe(
          Effect.mapError(mapRegistryFailure),
          Effect.flatMap(encodeLookupResult),
        );
    }
    return registry
      .list(request)
      .pipe(
        Effect.mapError(mapRegistryFailure),
        Effect.flatMap(encodeListResult),
      );
  };

const encodeConversationPage = (
  page: ConversationPage,
): ReturnType<DaemonManagementOperations["searchConversations"]> =>
  Effect.forEach(page.conversationIds, decodeConversationId, {
    concurrency: 1,
  }).pipe(
    Effect.map((conversationIds) =>
      Object.freeze({
        kind: "page" as const,
        conversationIds,
        hasMore: page.hasMore,
      }),
    ),
  );

const searchConversationsOperation =
  (store: EndpointStore): DaemonManagementOperations["searchConversations"] =>
  (request) =>
    store.searchConversations(request).pipe(
      Effect.mapError(() => managementFailure("persistence")),
      Effect.flatMap(encodeConversationPage),
    );

const decodeHistoryPage = (
  page: HistoryPage,
): Effect.Effect<ManagementReadConversationResult, DaemonManagementError> =>
  Effect.forEach(page.records, decodeStoredRecord, { concurrency: 1 }).pipe(
    Effect.map(
      (records): ManagementReadConversationResult =>
        Object.freeze({
          kind: "page",
          records,
          continuation: page.continuation,
        }),
    ),
  );

const readConversationOperation =
  (store: EndpointStore): DaemonManagementOperations["readConversation"] =>
  (request) =>
    store
      .readConversation(request)
      .pipe(
        Effect.mapError(mapHistoryStoreFailure),
        Effect.flatMap(decodeHistoryPage),
      );

/**
 * Builds management operations with one captured Registry service.
 *
 * @param input Daemon bootstrap authority and its exclusively owned store.
 * @param input.store Exclusively owned durable endpoint state.
 * @param input.bootstrap Configured identity and registration authority.
 * @returns Closed operations ready for the loopback MCP presentation.
 */
export const makeDaemonManagementOperations = (input: {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<DaemonManagementOperations, never, Registry> =>
  Effect.gen(function* () {
    const registry = yield* Registry;
    const operations: DaemonManagementOperations = {
      readStatus: readStatusOperation(input),
      register: registerOperation(input, registry),
      searchAgents: searchAgentsOperation(registry),
      searchConversations: searchConversationsOperation(input.store),
      readConversation: readConversationOperation(input.store),
    };
    return Object.freeze(operations);
  }).pipe(Effect.withSpan("makeDaemonManagementOperations"));
