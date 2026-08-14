/** @file Exact private MCP schemas for daemon management and history reads. */

import { AgentCard, AgentName, PrincipalId } from "@moltzap/identity";
import {
  OperationId,
  RegistryListRequest,
  RegistryLookupRequest,
} from "@moltzap/identity/registry";
import { JSONSchema, Schema } from "effect";
import { ConversationId } from "./contract.js";
import { CertifiedRecord, RecordHash } from "./endpoint/representation.js";

const exactOptions = {
  exact: true,
  onExcessProperty: "error" as const,
};

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({ parseOptions: exactOptions });

const encodedAgentCard = Schema.encodedSchema(AgentCard);

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

/** Empty exact request used by status. */
export const managementEmptyRequestSchema = exactStruct({});

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
  afterConversationId: Schema.optional(ConversationId),
});

/** Identifier-only local-conversation page. */
export const managementSearchConversationsResultSchema = exactStruct({
  kind: Schema.Literal("page"),
  conversationIds: Schema.Array(ConversationId),
  hasMore: Schema.Boolean,
});

const canonicalContinuation = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/u),
);

/** Frozen certified-history page selector or process-local continuation. */
export const managementReadConversationRequestSchema = Schema.Union(
  exactStruct({
    conversationId: ConversationId,
    afterRecordHash: Schema.optional(RecordHash),
  }),
  exactStruct({ continuation: canonicalContinuation }),
).annotations({ parseOptions: exactOptions });

/** Complete proof-bearing local certified-history page. */
export const managementReadConversationResultSchema = exactStruct({
  kind: Schema.Literal("page"),
  records: Schema.Array(CertifiedRecord),
  continuation: Schema.NullOr(canonicalContinuation),
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

const makeJsonSchema = <A, I>(schema: Schema.Schema<A, I>) =>
  JSONSchema.make(schema, { target: "jsonSchema2020-12" });

/** JSON Schemas advertised by the official MCP catalog. */
export const managementJsonSchemas = Object.freeze({
  emptyRequest: makeJsonSchema(managementEmptyRequestSchema),
  readConversationRequest: makeJsonSchema(
    managementReadConversationRequestSchema,
  ),
  readConversationResult: makeJsonSchema(
    managementReadConversationResultSchema,
  ),
  registerRequest: makeJsonSchema(managementRegisterRequestSchema),
  registerResult: makeJsonSchema(managementRegisterResultSchema),
  searchAgentsRequest: makeJsonSchema(managementSearchAgentsRequestSchema),
  searchAgentsResult: makeJsonSchema(managementSearchAgentsResultSchema),
  searchConversationsRequest: makeJsonSchema(
    managementSearchConversationsRequestSchema,
  ),
  searchConversationsResult: makeJsonSchema(
    managementSearchConversationsResultSchema,
  ),
  statusResult: makeJsonSchema(managementStatusResultSchema),
});
