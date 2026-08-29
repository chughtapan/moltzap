/** @file Private owner-authorized management over Registry and endpoint state. */

import {
  AgentCard,
  SignedMessage,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import {
  Registry,
  RegistryInvalidResponseError,
  type RegistryListResult,
  type RegistryLookupResult,
  type RegistryRegisterResult,
} from "@moltzap/identity/registry";
import { type Context, Data, Effect, Schema } from "effect";
import type {
  EndpointRecovery,
  EndpointStore,
  EndpointStoreError,
  HistoryPage,
  ProtocolEvidence,
  CertifiedRecord as StoredCertifiedRecord,
} from "../endpoint/store.js";
import type { HarnessMcpOperations } from "../harness-mcp-wire.js";
import type {
  ManagementReadConversationResult,
  ManagementRegisterResult,
  ManagementSearchAgentsResult,
  ManagementSearchConversationsRequest,
  ManagementSearchConversationsResult,
  ManagementStatusResult,
} from "../management-runtime.js";
import type { DaemonBootstrap } from "./configuration.js";
import { AgentAddress, GroupAddress, type SendError } from "../contract.js";
import { resolveMessageAddress } from "../endpoint/addressing/index.js";
import {
  type CertifiedRecord,
  compareAgentIds,
  decodeCanonical,
  deriveConversationId,
  MembershipDescriptor as MembershipDescriptorSchema,
  type RecordCore,
  RecordCore as RecordCoreSchema,
  type RouterAnchor,
  RouterAnchor as RouterAnchorSchema,
  verifyCertifiedRecord,
  verifyMembershipDescriptor,
  verifyRecordCore,
  verifyStableEvidence,
} from "../endpoint/representation.js";
import {
  type DaemonRegistrationPersistenceError,
  type DaemonRegistrationRepresentationError,
  type DaemonRegistrationState,
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
  | "dependency-unavailable"
  | "history-gap"
  | "incompatible-daemon"
  | "invalid-address"
  | "invalid-continuation"
  | "not-registered"
  | "persistence-failed"
  | "unknown-agent";

type RegistryService = Context.Tag.Service<typeof Registry>;
type MessageAddress = ManagementSearchConversationsResult["addresses"][number];
type HistoryRecord = ManagementReadConversationResult["records"][number];
type SignerEvidence = HistoryRecord["actionSignatures"][number];
type VerifiedMembership = Effect.Effect.Success<
  ReturnType<typeof verifyMembershipDescriptor>
>;
type VerifiedRecordCore = Effect.Effect.Success<
  ReturnType<typeof verifyRecordCore>
>;
type VerifiedEvidence = Effect.Effect.Success<
  ReturnType<typeof verifyStableEvidence>
>;

interface VerifiedStoredEvidence {
  readonly representation: unknown;
  readonly signer: SignerEvidence;
}

interface SearchConversationAddressesInput {
  readonly recovery: EndpointRecovery;
  readonly request: ManagementSearchConversationsRequest;
  readonly bootstrap: DaemonBootstrap;
  readonly localAgentCard: VerifiedAgentCard;
}

interface DecodeStoredEvidenceInput {
  readonly rows: readonly ProtocolEvidence[];
  readonly expectedKind: "action" | "durability";
  readonly expectedSubject: string;
  readonly recordCore: RecordCore;
  readonly membership: VerifiedMembership;
}

interface DecodeStoredRecordInput {
  readonly stored: StoredCertifiedRecord;
  readonly recovery: EndpointRecovery;
  readonly bootstrap: DaemonBootstrap;
}

class DaemonManagementError extends Data.TaggedError("DaemonManagementError")<{
  readonly reason: ManagementFailure;
}> {}

/** Closed management-only projection consumed by the MCP presentation. */
export type DaemonManagementOperations = Pick<
  HarnessMcpOperations,
  ManagementOperation
>;

const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};
const utf8Encoder = new TextEncoder();
const signedMessageRepresentation = Schema.Struct({
  payload: Schema.String,
  signatures: Schema.Tuple(
    Schema.Struct({ protected: Schema.String, signature: Schema.String }),
  ),
}).annotations({ parseOptions: exactOptions });
const historyFailureReasons = {
  "invalid-continuation": "invalid-continuation",
  "invalid-input": "history-gap",
  "not-found": "history-gap",
  closed: "persistence-failed",
  conflict: "persistence-failed",
  corrupt: "persistence-failed",
  incompatible: "persistence-failed",
  persistence: "persistence-failed",
} as const satisfies Readonly<
  Record<EndpointStoreError["reason"], ManagementFailure>
>;

function encodeRegisterResult(
  result: RegistryRegisterResult,
): Effect.Effect<ManagementRegisterResult, DaemonManagementError> {
  if (result.kind !== "registered") {
    return Effect.succeed(result);
  }
  return encodeAgentCard(result.agentCard).pipe(
    Effect.map((agentCard) => Object.freeze({ kind: "registered", agentCard })),
  );
}

function encodeStatus(
  state: DaemonRegistrationState,
): Effect.Effect<ManagementStatusResult, DaemonManagementError> {
  if (state.kind === "unregistered") {
    return Effect.succeed(state);
  }
  return encodeAgentCard(state.agentCard).pipe(
    Effect.map((agentCard) => Object.freeze({ kind: "active", agentCard })),
  );
}

function encodeLookupResult(
  result: RegistryLookupResult,
): Effect.Effect<ManagementSearchAgentsResult, DaemonManagementError> {
  if (result.kind === "not_found") {
    return Effect.succeed(result);
  }
  return encodeAgentCard(result.agentCard).pipe(
    Effect.map((agentCard) => Object.freeze({ kind: "found", agentCard })),
  );
}

function encodeListResult(
  result: RegistryListResult,
): Effect.Effect<ManagementSearchAgentsResult, DaemonManagementError> {
  return Effect.forEach(result.agentCards, encodeAgentCard, {
    concurrency: 1,
  }).pipe(
    Effect.map((agentCards) =>
      Object.freeze({ kind: "page", agentCards, hasMore: result.hasMore }),
    ),
  );
}

function encodeAgentCard(
  agentCard: VerifiedAgentCard,
): Effect.Effect<unknown, DaemonManagementError> {
  return Schema.encode(AgentCard)(agentCard).pipe(
    Effect.mapError(incompatibleDaemon),
  );
}

function readActiveIdentityForAgentSearch(input: {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<VerifiedAgentCard, DaemonManagementError> {
  return readActiveIdentity(input).pipe(
    Effect.mapError((error) =>
      error.reason === "persistence-failed" ? incompatibleDaemon() : error,
    ),
  );
}

function readActiveIdentityForLocalManagement(input: {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<VerifiedAgentCard, DaemonManagementError> {
  return readActiveIdentity(input).pipe(
    Effect.mapError((error) =>
      error.reason === "not-registered" ? error : persistenceFailure(),
    ),
  );
}

function readActiveIdentity(input: {
  readonly store: EndpointStore;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<VerifiedAgentCard, DaemonManagementError> {
  return readDaemonRegistrationState(input).pipe(
    Effect.mapError(mapRegistrationFailure),
    Effect.flatMap((state) =>
      state.kind === "active"
        ? Effect.succeed(state.agentCard)
        : Effect.fail(managementFailure("not-registered")),
    ),
  );
}

function mapRegistrationFailure(
  error:
    | DaemonRegistrationPersistenceError
    | DaemonRegistrationRepresentationError
    | DaemonRegistrationUpstreamError,
): DaemonManagementError {
  switch (error._tag) {
    case "DaemonRegistrationPersistenceError":
      return persistenceFailure();
    case "DaemonRegistrationRepresentationError":
      return incompatibleDaemon();
    case "DaemonRegistrationUpstreamError":
      return managementFailure("dependency-unavailable");
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function mapRegistryFailure(error: unknown): DaemonManagementError {
  return error instanceof RegistryInvalidResponseError
    ? incompatibleDaemon()
    : managementFailure("dependency-unavailable");
}

function compareAddresses(left: string, right: string): number {
  return compareBytes(utf8Encoder.encode(left), utf8Encoder.encode(right));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const sharedLength = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.byteLength - right.byteLength;
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

function validateAddressForLocalAgent(
  address: MessageAddress,
  localAgentCard: VerifiedAgentCard,
): Effect.Effect<void, DaemonManagementError> {
  const names = addressNames(address);
  const valid = address.startsWith("agent:")
    ? names[0] !== localAgentCard.agentName
    : names.includes(localAgentCard.agentName);
  return valid
    ? Effect.void
    : Effect.fail(managementFailure("invalid-address"));
}

function addressNames(address: string): readonly string[] {
  const separator = address.indexOf(":");
  return address.slice(separator + 1).split(",");
}

function renderMembershipAddress(
  membership: Effect.Effect.Success<
    ReturnType<typeof verifyMembershipDescriptor>
  >,
  localAgentCard: VerifiedAgentCard,
): Effect.Effect<MessageAddress, DaemonManagementError> {
  const localMember = membership.members.find(
    (member) => member.agentId === localAgentCard.agentId,
  );
  if (localMember?.agentName !== localAgentCard.agentName) {
    return Effect.fail(persistenceFailure());
  }
  if (membership.members.length === 2) {
    const remote = membership.members.find(
      (member) => member.agentId !== localAgentCard.agentId,
    );
    return remote === undefined
      ? Effect.fail(persistenceFailure())
      : Schema.decodeUnknown(AgentAddress)(`agent:${remote.agentName}`).pipe(
          Effect.mapError(persistenceFailure),
        );
  }
  const names = membership.members.map((member) => member.agentName);
  names.sort(compareAscii);
  return Schema.decodeUnknown(GroupAddress)(`group:${names.join(",")}`).pipe(
    Effect.mapError(persistenceFailure),
  );
}

function decodeStoredMembership(
  stored: EndpointRecovery["memberships"][number],
  input: {
    readonly bootstrap: DaemonBootstrap;
    readonly localAgentCard: VerifiedAgentCard;
  },
): Effect.Effect<MessageAddress, DaemonManagementError> {
  return Effect.gen(function* () {
    const descriptor = yield* decodeCanonical(
      MembershipDescriptorSchema,
      stored.canonicalMembership,
    ).pipe(Effect.mapError(persistenceFailure));
    const membership = yield* verifyMembershipDescriptor(
      descriptor,
      input.bootstrap.configuration.registrySignerPublicKey,
    ).pipe(Effect.mapError(persistenceFailure));
    if (
      membership.descriptor.conversationId !== stored.conversationId ||
      membership.hash !== stored.membershipHash
    ) {
      return yield* Effect.fail(persistenceFailure());
    }
    return yield* renderMembershipAddress(membership, input.localAgentCard);
  });
}

function searchConversationAddresses(
  input: SearchConversationAddressesInput,
): Effect.Effect<ManagementSearchConversationsResult, DaemonManagementError> {
  return Effect.gen(function* () {
    if (input.request.afterAddress !== undefined) {
      yield* validateAddressForLocalAgent(
        input.request.afterAddress,
        input.localAgentCard,
      );
    }
    const memberships = new Map(
      input.recovery.memberships.map((membership) => [
        membership.conversationId,
        membership,
      ]),
    );
    const certifiedConversationIds = input.recovery.positions
      .filter((position) => position.headRecordHash !== undefined)
      .map((position) => position.conversationId);
    const addresses = yield* Effect.forEach(
      certifiedConversationIds,
      (conversationId) => {
        const membership = memberships.get(conversationId);
        return membership === undefined
          ? Effect.fail(persistenceFailure())
          : decodeStoredMembership(membership, input);
      },
      { concurrency: 1 },
    );
    addresses.sort(compareAddresses);
    for (let index = 1; index < addresses.length; index += 1) {
      if (addresses[index - 1] === addresses[index]) {
        return yield* Effect.fail(persistenceFailure());
      }
    }
    const after = input.request.afterAddress;
    const remaining =
      after === undefined
        ? addresses
        : addresses.filter((address) => compareAddresses(address, after) > 0);
    const page = remaining.slice(0, 50);
    return Object.freeze({
      kind: "page" as const,
      addresses: Object.freeze(page),
      hasMore: remaining.length > page.length,
    });
  });
}

function mapAddressResolutionFailure(error: SendError): DaemonManagementError {
  return error.reason === "invalid-address" ||
    error.reason === "membership-invalid"
    ? managementFailure("invalid-address")
    : managementFailure("unknown-agent");
}

function resolvedConversationId(input: {
  readonly address: MessageAddress;
  readonly localAgentCard: VerifiedAgentCard;
  readonly registry: RegistryService;
}): Effect.Effect<string, DaemonManagementError> {
  return Effect.gen(function* () {
    yield* validateAddressForLocalAgent(input.address, input.localAgentCard);
    const resolved = yield* resolveMessageAddress({
      localAgentCard: input.localAgentCard,
      registry: input.registry,
      to: input.address,
    }).pipe(Effect.mapError(mapAddressResolutionFailure));
    const first = resolved.memberCards[0];
    const second = resolved.memberCards[1];
    return yield* deriveConversationId([
      first.agentId,
      second.agentId,
      ...resolved.memberCards.slice(2).map((card) => card.agentId),
    ]).pipe(Effect.mapError(persistenceFailure));
  });
}

function mapHistoryStoreFailure(
  error: EndpointStoreError,
): DaemonManagementError {
  return managementFailure(historyFailureReasons[error.reason]);
}

function nonEmpty<Value>(
  values: readonly Value[],
): readonly [Value, ...Value[]] | undefined {
  const first = values[0];
  return first === undefined ? undefined : [first, ...values.slice(1)];
}

function decodeStoredEvidence(
  input: DecodeStoredEvidenceInput,
): Effect.Effect<
  readonly [VerifiedStoredEvidence, ...VerifiedStoredEvidence[]],
  DaemonManagementError
> {
  return Effect.gen(function* () {
    const decoded = yield* Effect.forEach(
      input.rows,
      (row) => decodeStoredEvidenceRow(row, input),
      { concurrency: 1 },
    );
    decoded.sort((left, right) =>
      compareAgentIds(left.signer.signerAgentId, right.signer.signerAgentId),
    );
    const result = nonEmpty(decoded);
    if (result === undefined) {
      return yield* Effect.fail(persistenceFailure());
    }
    return result;
  });
}

function decodeStoredEvidenceRow(
  row: ProtocolEvidence,
  input: DecodeStoredEvidenceInput,
): Effect.Effect<VerifiedStoredEvidence, DaemonManagementError> {
  return Effect.gen(function* () {
    if (!storedEvidenceRowMatches(row, input)) {
      return yield* Effect.fail(persistenceFailure());
    }
    const message = yield* decodeCanonical(
      SignedMessage,
      row.canonicalEvidence,
    ).pipe(Effect.mapError(persistenceFailure));
    const representation = yield* Schema.encode(SignedMessage)(message).pipe(
      Effect.mapError(persistenceFailure),
    );
    const verified = yield* verifyStableEvidence({
      representation,
      membership: input.membership,
    }).pipe(Effect.mapError(persistenceFailure));
    if (
      !evidenceStatementMatches(verified, input) ||
      row.evidenceKey !== verified.statement.signerAgentId
    ) {
      return yield* Effect.fail(persistenceFailure());
    }
    const encoded = yield* Schema.decodeUnknown(signedMessageRepresentation)(
      representation,
      exactOptions,
    ).pipe(Effect.mapError(persistenceFailure));
    return {
      representation,
      signer: {
        signerAgentId: verified.statement.signerAgentId,
        signature: encoded.signatures[0].signature,
      },
    };
  });
}

function storedEvidenceRowMatches(
  row: ProtocolEvidence,
  input: DecodeStoredEvidenceInput,
): boolean {
  return (
    row.kind === input.expectedKind &&
    row.subjectId === input.expectedSubject &&
    row.conversationId === input.recordCore.membership.conversationId
  );
}

function evidenceStatementMatches(
  verified: VerifiedEvidence,
  input: DecodeStoredEvidenceInput,
): boolean {
  switch (input.expectedKind) {
    case "action":
      return actionStatementMatches(verified, input.expectedSubject);
    case "durability":
      return durabilityStatementMatches(verified, input);
    default: {
      const exhaustive: never = input.expectedKind;
      return exhaustive;
    }
  }
}

function actionStatementMatches(
  verified: VerifiedEvidence,
  expectedSubject: string,
): boolean {
  return (
    verified.statement.kind === "action_signature" &&
    verified.statement.actionHash === expectedSubject
  );
}

function durabilityStatementMatches(
  verified: VerifiedEvidence,
  input: DecodeStoredEvidenceInput,
): boolean {
  if (verified.statement.kind !== "durability_vote") {
    return false;
  }
  return (
    verified.statement.recordHash === input.expectedSubject &&
    verified.statement.conversationId ===
      input.recordCore.membership.conversationId &&
    verified.statement.membershipHash ===
      expectedMembershipHash(input.recordCore)
  );
}

function expectedMembershipHash(recordCore: RecordCore): string {
  return recordCore.action.kind === "GENESIS"
    ? recordCore.action.postIntent.membershipHash
    : recordCore.action.membershipHash;
}

function decodeStoredAnchor(
  recovery: EndpointRecovery,
  recordCore: RecordCore,
): Effect.Effect<RouterAnchor, DaemonManagementError> {
  const stored = recovery.anchors.find(
    (anchor) =>
      anchor.conversationId === recordCore.membership.conversationId &&
      anchor.anchorHash === recordCore.anchorHash,
  );
  return stored === undefined
    ? Effect.fail(persistenceFailure())
    : decodeCanonical(RouterAnchorSchema, stored.canonicalAnchor).pipe(
        Effect.mapError(persistenceFailure),
      );
}

function decodeStoredRecord(
  input: DecodeStoredRecordInput,
): Effect.Effect<HistoryRecord, DaemonManagementError> {
  return Effect.gen(function* () {
    const { recordCore, verifiedCore } = yield* decodeStoredCore(input);
    const routerAnchor = yield* decodeStoredAnchor(input.recovery, recordCore);
    const { action, durability } = yield* decodeRecordEvidence({
      stored: input.stored,
      recordCore,
      membership: verifiedCore.membership,
      recordHash: verifiedCore.recordHash,
    });
    const complete = assembleCertifiedRecord({
      recordCore,
      recordHash: verifiedCore.recordHash,
      routerAnchor,
      actionRepresentations: mapNonEmpty(action, (item) => item.representation),
      durabilityRepresentations: mapNonEmpty(
        durability,
        (item) => item.representation,
      ),
    });
    yield* verifyCertifiedRecord({
      record: complete,
      registrySignerPublicKey:
        input.bootstrap.configuration.registrySignerPublicKey,
    }).pipe(Effect.mapError(persistenceFailure));
    return {
      recordHash: verifiedCore.recordHash,
      recordCore,
      routerAnchor,
      actionSignatures: mapNonEmpty(action, (item) => item.signer),
      durabilityVotes: mapNonEmpty(durability, (item) => item.signer),
    };
  });
}

function decodeStoredCore(input: DecodeStoredRecordInput): Effect.Effect<
  Readonly<{
    recordCore: RecordCore;
    verifiedCore: VerifiedRecordCore;
  }>,
  DaemonManagementError
> {
  return Effect.gen(function* () {
    const recordCore = yield* decodeCanonical(
      RecordCoreSchema,
      input.stored.canonicalRecordCore,
    ).pipe(Effect.mapError(persistenceFailure));
    const verifiedCore = yield* verifyRecordCore({
      recordCore,
      registrySignerPublicKey:
        input.bootstrap.configuration.registrySignerPublicKey,
    }).pipe(Effect.mapError(persistenceFailure));
    if (!storedRecordMatches(input.stored, recordCore, verifiedCore)) {
      return yield* Effect.fail(persistenceFailure());
    }
    return { recordCore, verifiedCore };
  });
}

function storedRecordMatches(
  stored: StoredCertifiedRecord,
  recordCore: RecordCore,
  verifiedCore: VerifiedRecordCore,
): boolean {
  return (
    storedRecordEnvelopeMatches(stored, recordCore, verifiedCore) &&
    storedRecordActionMatches(stored, recordCore) &&
    storedRecordChainMatches(stored, recordCore)
  );
}

function storedRecordEnvelopeMatches(
  stored: StoredCertifiedRecord,
  recordCore: RecordCore,
  verifiedCore: VerifiedRecordCore,
): boolean {
  return (
    verifiedCore.recordHash === stored.recordHash &&
    recordCore.membership.conversationId === stored.conversationId &&
    verifiedCore.membership.hash === stored.membershipHash
  );
}

function storedRecordActionMatches(
  stored: StoredCertifiedRecord,
  recordCore: RecordCore,
): boolean {
  return (
    recordCore.actionHash === stored.actionHash &&
    recordCore.action.postIntent.authorAgentId === stored.authorAgentId &&
    recordCore.action.postIntent.postId === stored.postId
  );
}

function storedRecordChainMatches(
  stored: StoredCertifiedRecord,
  recordCore: RecordCore,
): boolean {
  return (
    recordCore.anchorHash === stored.anchorHash &&
    (recordCore.action.previousRecordHash ?? undefined) ===
      stored.previousRecordHash
  );
}

function decodeRecordEvidence(input: {
  readonly stored: StoredCertifiedRecord;
  readonly recordCore: RecordCore;
  readonly membership: VerifiedMembership;
  readonly recordHash: VerifiedRecordCore["recordHash"];
}) {
  return Effect.gen(function* () {
    const action = yield* decodeStoredEvidence({
      rows: input.stored.actionEvidence,
      expectedKind: "action",
      expectedSubject: input.recordCore.actionHash,
      recordCore: input.recordCore,
      membership: input.membership,
    });
    const durability = yield* decodeStoredEvidence({
      rows: input.stored.durabilityEvidence,
      expectedKind: "durability",
      expectedSubject: input.recordHash,
      recordCore: input.recordCore,
      membership: input.membership,
    });
    return { action, durability };
  });
}

function assembleCertifiedRecord(input: {
  readonly recordCore: RecordCore;
  readonly recordHash: VerifiedRecordCore["recordHash"];
  readonly routerAnchor: RouterAnchor;
  readonly actionRepresentations: readonly [unknown, ...unknown[]];
  readonly durabilityRepresentations: readonly [unknown, ...unknown[]];
}): CertifiedRecord {
  return {
    moltzapVersion: input.recordCore.moltzapVersion,
    kind: "certified_record",
    actionCertifiedRecord: {
      moltzapVersion: input.recordCore.moltzapVersion,
      kind: "action_certified_record",
      recordHash: input.recordHash,
      recordCore: input.recordCore,
      routerAnchor: input.routerAnchor,
      actionCertificate: {
        moltzapVersion: input.recordCore.moltzapVersion,
        kind: "action_certificate",
        actionHash: input.recordCore.actionHash,
        signatures: input.actionRepresentations,
      },
    },
    durabilityCertificate: {
      moltzapVersion: input.recordCore.moltzapVersion,
      kind: "durability_certificate",
      recordHash: input.recordHash,
      votes: input.durabilityRepresentations,
    },
  };
}

function mapNonEmpty<Value, Result>(
  values: readonly [Value, ...Value[]],
  transform: (value: Value) => Result,
): readonly [Result, ...Result[]] {
  const [first, ...remaining] = values;
  return [transform(first), ...remaining.map(transform)];
}

function decodeHistoryPage(input: {
  readonly page: HistoryPage;
  readonly recovery: EndpointRecovery;
  readonly bootstrap: DaemonBootstrap;
}): Effect.Effect<ManagementReadConversationResult, DaemonManagementError> {
  return Effect.forEach(
    input.page.records,
    (stored) => decodeStoredRecord({ ...input, stored }),
    { concurrency: 1 },
  ).pipe(
    Effect.map((verified) =>
      Object.freeze({
        kind: "page" as const,
        records: Object.freeze(verified),
        continuation: input.page.continuation,
      }),
    ),
  );
}

function persistenceFailure(): DaemonManagementError {
  return managementFailure("persistence-failed");
}

function incompatibleDaemon(): DaemonManagementError {
  return managementFailure("incompatible-daemon");
}

function managementFailure(reason: ManagementFailure): DaemonManagementError {
  return new DaemonManagementError({ reason });
}

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
  (
    input: {
      readonly store: EndpointStore;
      readonly bootstrap: DaemonBootstrap;
    },
    registry: RegistryService,
  ): DaemonManagementOperations["searchAgents"] =>
  (request) =>
    readActiveIdentityForAgentSearch(input).pipe(
      Effect.flatMap(() => {
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
      }),
    );

const searchConversationsOperation =
  (input: {
    readonly store: EndpointStore;
    readonly bootstrap: DaemonBootstrap;
  }): DaemonManagementOperations["searchConversations"] =>
  (request) =>
    Effect.gen(function* () {
      const localAgentCard = yield* readActiveIdentityForLocalManagement(input);
      const recovery = yield* input.store
        .recover()
        .pipe(Effect.mapError(persistenceFailure));
      return yield* searchConversationAddresses({
        recovery,
        request,
        bootstrap: input.bootstrap,
        localAgentCard,
      });
    });

const readConversationOperation =
  (
    input: {
      readonly store: EndpointStore;
      readonly bootstrap: DaemonBootstrap;
    },
    registry: RegistryService,
  ): DaemonManagementOperations["readConversation"] =>
  (request) =>
    Effect.gen(function* () {
      const localAgentCard = yield* readActiveIdentityForLocalManagement(input);
      const storeRequest =
        "continuation" in request
          ? request
          : {
              conversationId: yield* resolvedConversationId({
                address: request.address,
                localAgentCard,
                registry,
              }),
              ...(request.afterRecordHash === undefined
                ? {}
                : { afterRecordHash: request.afterRecordHash }),
            };
      const page = yield* input.store
        .readConversation(storeRequest)
        .pipe(Effect.mapError(mapHistoryStoreFailure));
      const recovery = yield* input.store
        .recover()
        .pipe(Effect.mapError(persistenceFailure));
      return yield* decodeHistoryPage({
        page,
        recovery,
        bootstrap: input.bootstrap,
      });
    });

/**
 * Builds management operations with one captured Registry service.
 *
 * @param input Daemon bootstrap authority and its exclusively owned store.
 * @param input.store Durable endpoint state owned by this daemon.
 * @param input.bootstrap Fixed identity and service configuration.
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
      searchAgents: searchAgentsOperation(input, registry),
      searchConversations: searchConversationsOperation(input),
      readConversation: readConversationOperation(input, registry),
    };
    return Object.freeze(operations);
  }).pipe(Effect.withSpan("makeDaemonManagementOperations"));
