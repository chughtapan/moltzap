/** @file Exact private MCP schemas for daemon management and history reads. */

import { AgentCard, AgentId, AgentName, PrincipalId } from "@moltzap/identity";
import {
  OperationId,
  RegistryListRequest,
  RegistryLookupRequest,
} from "@moltzap/identity/registry";
import { Either, Encoding, Schema } from "effect";
import { AgentAddress, GroupAddress } from "./contract.js";
import {
  RecordCore,
  RecordHash,
  RouterAnchor,
} from "./endpoint/representation.js";

const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({ parseOptions: exactOptions });

const encodedAgentCard = Schema.encodedSchema(AgentCard);
const utf8Encoder = new TextEncoder();

const messageAddress = Schema.Union(AgentAddress, GroupAddress).annotations({
  identifier: "MessageAddress",
});

function addressesAreOrdered(addresses: readonly string[]): boolean {
  for (let index = 1; index < addresses.length; index += 1) {
    const previous = addresses[index - 1];
    const current = addresses[index];
    if (
      previous === undefined ||
      current === undefined ||
      compareBytes(utf8Encoder.encode(previous), utf8Encoder.encode(current)) >=
        0
    ) {
      return false;
    }
  }
  return true;
}

function canonicalBase64UrlBytes(value: string, byteLength: number): boolean {
  return Either.match(Encoding.decodeBase64Url(value), {
    onLeft: () => false,
    onRight: (bytes) =>
      bytes.byteLength === byteLength &&
      Encoding.encodeBase64Url(bytes) === value,
  });
}

function agentIdsAreOrdered(agentIds: readonly string[]): boolean {
  for (let index = 1; index < agentIds.length; index += 1) {
    const previous = agentIds[index - 1];
    const current = agentIds[index];
    if (previous === undefined || current === undefined) {
      return false;
    }
    const previousBytes = Either.getOrUndefined(
      Encoding.decodeBase64Url(previous.slice(4)),
    );
    const currentBytes = Either.getOrUndefined(
      Encoding.decodeBase64Url(current.slice(4)),
    );
    if (
      previousBytes === undefined ||
      currentBytes === undefined ||
      compareBytes(previousBytes, currentBytes) >= 0
    ) {
      return false;
    }
  }
  return true;
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

const historyContinuation = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/u),
  Schema.filter((value) => canonicalBase64UrlBytes(value, 32)),
);

const ed25519Signature = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{86}$/u),
  Schema.filter((value) => canonicalBase64UrlBytes(value, 64)),
);

const signerEvidence = exactStruct({
  signerAgentId: AgentId,
  signature: ed25519Signature,
});

const orderedSignerEvidence = Schema.NonEmptyArray(signerEvidence).pipe(
  Schema.maxItems(32),
  Schema.filter((evidence) =>
    agentIdsAreOrdered(evidence.map((item) => item.signerAgentId)),
  ),
);

const historyRecord = exactStruct({
  recordHash: RecordHash,
  recordCore: RecordCore,
  routerAnchor: RouterAnchor,
  actionSignatures: orderedSignerEvidence,
  durabilityVotes: orderedSignerEvidence,
});

/** Closed local registration input; configured secrets are never tool fields. */
export const managementRegisterRequestSchema = exactStruct({
  operationId: OperationId,
  principalId: PrincipalId,
  agentName: AgentName,
});

/** Exact Registry domain outcomes returned by daemon registration. */
export const managementRegisterResultSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("registered"),
    agentCard: encodedAgentCard,
  }),
  exactStruct({ kind: Schema.Literal("name_taken") }),
  exactStruct({ kind: Schema.Literal("key_already_registered") }),
  exactStruct({ kind: Schema.Literal("idempotency_conflict") }),
).annotations({ parseOptions: exactOptions });

/** Closed daemon lifecycle visible to the loopback operator. */
export const managementStatusResultSchema = Schema.Union(
  exactStruct({ kind: Schema.Literal("unregistered") }),
  exactStruct({
    kind: Schema.Literal("active"),
    agentCard: encodedAgentCard,
  }),
).annotations({ parseOptions: exactOptions });

/** Exact Registry lookup-or-list selector used by agent discovery. */
export const managementSearchAgentsRequestSchema = Schema.Union(
  RegistryLookupRequest,
  RegistryListRequest,
).annotations({ parseOptions: exactOptions });

/** Direct projection of exact Registry lookup and list results. */
export const managementSearchAgentsResultSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("found"),
    agentCard: encodedAgentCard,
  }),
  exactStruct({ kind: Schema.Literal("not_found") }),
  exactStruct({
    kind: Schema.Literal("page"),
    agentCards: Schema.Array(encodedAgentCard),
    hasMore: Schema.Boolean,
  }),
).annotations({ parseOptions: exactOptions });

/** Canonically ordered local-conversation page selector. */
export const managementSearchConversationsRequestSchema = exactStruct({
  afterAddress: Schema.optional(messageAddress),
});

/** Canonically ordered local-conversation address page. */
export const managementSearchConversationsResultSchema = exactStruct({
  kind: Schema.Literal("page"),
  addresses: Schema.Array(messageAddress).pipe(Schema.maxItems(50)),
  hasMore: Schema.Boolean,
}).pipe(
  Schema.filter(
    (page) =>
      addressesAreOrdered(page.addresses) &&
      (!page.hasMore || page.addresses.length > 0),
  ),
);

/** Frozen certified-history page selector or process-local continuation. */
export const managementReadConversationRequestSchema = Schema.Union(
  exactStruct({
    address: messageAddress,
    afterRecordHash: Schema.optional(RecordHash),
  }),
  exactStruct({ continuation: historyContinuation }),
).annotations({ parseOptions: exactOptions });

/** Complete proof-bearing local certified-history page. */
export const managementReadConversationResultSchema = exactStruct({
  kind: Schema.Literal("page"),
  records: Schema.Array(historyRecord).pipe(Schema.maxItems(50)),
  continuation: Schema.NullOr(historyContinuation),
});

/** Decoded local registration request. */
export type ManagementRegisterRequest =
  typeof managementRegisterRequestSchema.Type;
/** Encoded Registry registration result crossing MCP. */
export type ManagementRegisterResult =
  typeof managementRegisterResultSchema.Type;
/** Encoded daemon status crossing MCP. */
export type ManagementStatusResult = typeof managementStatusResultSchema.Type;
/** Decoded exact Registry selector crossing MCP. */
export type ManagementSearchAgentsRequest =
  typeof managementSearchAgentsRequestSchema.Type;
/** Encoded exact Registry result crossing MCP. */
export type ManagementSearchAgentsResult =
  typeof managementSearchAgentsResultSchema.Type;
/** Decoded local conversation search request. */
export type ManagementSearchConversationsRequest =
  typeof managementSearchConversationsRequestSchema.Type;
/** Encoded local conversation search result. */
export type ManagementSearchConversationsResult =
  typeof managementSearchConversationsResultSchema.Type;
/** Decoded local certified-history request. */
export type ManagementReadConversationRequest =
  typeof managementReadConversationRequestSchema.Type;
/** Encoded proof-bearing local certified-history result. */
export type ManagementReadConversationResult =
  typeof managementReadConversationResultSchema.Type;
