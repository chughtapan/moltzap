import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import {
  AgentCard,
  verifiedAgentCardSchema,
  type VerifiedAgentCard,
} from "../agent-card.js";
import { Ed25519PublicKey } from "../ed25519-public-key.js";
import {
  AuthenticationFailedError,
  InternalServerError,
  MalformedRequestError,
  MethodNotAllowedError,
  OverloadedError,
  PayloadTooLargeError,
  RouteNotFoundError,
  UnavailableError,
  UnsupportedMediaTypeError,
  VersionMismatchError,
} from "../http-errors.js";
import {
  AgentId,
  AgentName,
  OperationId,
  PrincipalId,
} from "../identity-values.js";
import { RegistryAdmission } from "./request-context.js";

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({
    parseOptions: {
      exact: true,
      onExcessProperty: "error",
    },
  });

/** Closed Registry bootstrap registration request. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const RegistryRegisterRequest = exactStruct({
  operationId: OperationId,
  principalId: PrincipalId,
  agentName: AgentName,
  publicKey: Ed25519PublicKey,
}).annotations({ identifier: "RegistryRegisterRequest" });
/** Validated Registry bootstrap registration request. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type RegistryRegisterRequest = typeof RegistryRegisterRequest.Type;

/** Closed Registry lookup selector. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const RegistryLookupRequest = Schema.Union(
  exactStruct({ agentId: AgentId }),
  exactStruct({ agentName: AgentName }),
).annotations({
  identifier: "RegistryLookupRequest",
  parseOptions: {
    exact: true,
    onExcessProperty: "error",
  },
});
/** Validated Registry lookup selector. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type RegistryLookupRequest = typeof RegistryLookupRequest.Type;

/** Closed Registry list continuation request. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Effect Schemas share the public domain name they decode.
export const RegistryListRequest = exactStruct({
  afterAgentId: Schema.optional(AgentId),
}).annotations({ identifier: "RegistryListRequest" });
/** Validated Registry list continuation request. */
// eslint-disable-next-line @typescript-eslint/no-redeclare -- The same-named Schema and type form one boundary model.
export type RegistryListRequest = typeof RegistryListRequest.Type;

/** Closed domain outcome from one bootstrap registration attempt. */
export type RegistryRegisterResult =
  | Readonly<{ kind: "registered"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "name_taken" }>
  | Readonly<{ kind: "key_already_registered" }>
  | Readonly<{ kind: "idempotency_conflict" }>;

/** Closed domain outcome from one public identity lookup. */
export type RegistryLookupResult =
  | Readonly<{ kind: "found"; agentCard: VerifiedAgentCard }>
  | Readonly<{ kind: "not_found" }>;

/** One deterministic page of complete immutable AgentCards. */
export type RegistryListResult = Readonly<{
  kind: "page";
  agentCards: readonly VerifiedAgentCard[];
  hasMore: boolean;
}>;

/** Package-private validated registration outcome. */
const registerResultSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("registered"),
    agentCard: verifiedAgentCardSchema,
  }),
  exactStruct({ kind: Schema.Literal("name_taken") }),
  exactStruct({ kind: Schema.Literal("key_already_registered") }),
  exactStruct({ kind: Schema.Literal("idempotency_conflict") }),
);

/** Package-private validated lookup outcome. */
const lookupResultSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("found"),
    agentCard: verifiedAgentCardSchema,
  }),
  exactStruct({ kind: Schema.Literal("not_found") }),
);

/** Package-private validated list outcome. */
const listResultSchema = exactStruct({
  kind: Schema.Literal("page"),
  agentCards: Schema.Array(verifiedAgentCardSchema),
  hasMore: Schema.Boolean,
});

/** Exact registration response representation used by both HTTP adapters. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private HTTP and storage adapters share this Schema; the package root does not export it.
export const registerResponseSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("registered"),
    agentCard: AgentCard,
  }),
  exactStruct({ kind: Schema.Literal("name_taken") }),
  exactStruct({ kind: Schema.Literal("key_already_registered") }),
  exactStruct({ kind: Schema.Literal("idempotency_conflict") }),
);

/** Exact lookup response representation used by both HTTP adapters. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- Private HTTP adapters share this Schema; the package root does not export it.
export const lookupResponseSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("found"),
    agentCard: AgentCard,
  }),
  exactStruct({ kind: Schema.Literal("not_found") }),
);

/** Exact list response representation used by both HTTP adapters. */
export const listResponseSchema = exactStruct({
  kind: Schema.Literal("page"),
  agentCards: Schema.Array(AgentCard),
  hasMore: Schema.Boolean,
});

const registerErrors = Schema.Union(
  MalformedRequestError,
  AuthenticationFailedError,
  RouteNotFoundError,
  MethodNotAllowedError,
  VersionMismatchError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  OverloadedError,
  UnavailableError,
  InternalServerError,
);

const publicReadErrors = Schema.Union(
  MalformedRequestError,
  RouteNotFoundError,
  MethodNotAllowedError,
  VersionMismatchError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  OverloadedError,
  UnavailableError,
  InternalServerError,
);

/** Private registration operation including its admission middleware. */
export const registerOperation = Rpc.make("register", {
  payload: RegistryRegisterRequest,
  success: registerResultSchema,
  error: registerErrors,
}).middleware(RegistryAdmission);

/** Private lookup operation. */
export const lookupOperation = Rpc.make("lookup", {
  payload: RegistryLookupRequest,
  success: lookupResultSchema,
  error: publicReadErrors,
});

/** Private deterministic list operation. */
export const listOperation = Rpc.make("list", {
  payload: RegistryListRequest,
  success: listResultSchema,
  error: publicReadErrors,
});

/** The package-private no-serialization Registry operation group. */
export const registryOperations = RpcGroup.make(
  registerOperation,
  lookupOperation,
  listOperation,
);
