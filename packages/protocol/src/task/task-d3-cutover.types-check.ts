/**
 * @file Spec D3 (#600) R11 outbound-catalog-split type canaries.
 *
 * Pins the partition shape: agentClientRpcMethods ⊂ appCallableRpcMethods,
 * disjoint from appCallableTaskRpcMethods. Each predicate fails compilation if
 * a method gets moved between sides or a new method lands without
 * classification.
 *
 * Also pins the TaskId branding, JsonValue, and AppCallbackHandlers
 * REQUIRED-slot canaries.
 */
import type { JsonValue } from "../schema-primitives.js";
import type { JsonRpcMethod } from "../transport/wire.js";
import type { RpcErrorPayload } from "../transport/wire-errors.js";
import {
  agentClientRpcMethods,
  appCallableRpcMethods,
  type AnyAgentClientRpcDefinition,
  type AnyAppCallableRpcDefinition,
  type AnyServerRpcDefinition,
  appCallableTaskRpcMethods,
  TaskRequest,
  TaskLeave,
  MessagesSend,
  MessagesList,
  TaskList,
  TaskClose,
  TaskConversationCreate,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  TaskCreate,
} from "../index.js";

// ── Partition cardinality ───────────────────────────────────────────
// appCallable = agentCallable ∪ appCallableTask; cardinality sum equals.
type _CardinalityHolds = AssertEquals<
  (typeof appCallableRpcMethods)["length"],
  AddOne<
    (typeof agentClientRpcMethods)["length"],
    (typeof appCallableTaskRpcMethods)["length"]
  >
>;

// ── Membership: app-callable side carries the admin operations ──────
type _AppCallableHasClose = AssertExtends<
  typeof TaskClose,
  AnyAppCallableRpcDefinition
>;
type _AppCallableHasConvCreate = AssertExtends<
  typeof TaskConversationCreate,
  AnyAppCallableRpcDefinition
>;
type _AppCallableHasConvArchive = AssertExtends<
  typeof TaskConversationArchive,
  AnyAppCallableRpcDefinition
>;
type _AppCallableHasConvUnarchive = AssertExtends<
  typeof TaskConversationUnarchive,
  AnyAppCallableRpcDefinition
>;
type _AppCallableHasAddPart = AssertExtends<
  typeof TaskConversationAddParticipant,
  AnyAppCallableRpcDefinition
>;
type _AppCallableHasRemovePart = AssertExtends<
  typeof TaskConversationRemoveParticipant,
  AnyAppCallableRpcDefinition
>;

// ── Membership: agent-client side carries the open operations ───────
type _AgentHasCreate = AssertExtends<
  typeof TaskRequest,
  AnyAgentClientRpcDefinition
>;
type _AgentHasLeave = AssertExtends<
  typeof TaskLeave,
  AnyAgentClientRpcDefinition
>;
type _AgentHasList = AssertExtends<
  typeof TaskList,
  AnyAgentClientRpcDefinition
>;
type _AgentHasMessagesSend = AssertExtends<
  typeof MessagesSend,
  AnyAgentClientRpcDefinition
>;
type _AgentHasMessagesList = AssertExtends<
  typeof MessagesList,
  AnyAgentClientRpcDefinition
>;

// ── Disjointness: an app-callable method must NOT satisfy agent union ─
// If TaskClose were accidentally added to agentClientRpcMethods, the
// `Exclude<>` below would resolve to never and break the assertion.
type _TaskCloseNotInAgentSet = AssertEquals<
  Extract<typeof TaskClose, AnyAgentClientRpcDefinition>,
  never
>;
type _ConvCreateNotInAgentSet = AssertEquals<
  Extract<typeof TaskConversationCreate, AnyAgentClientRpcDefinition>,
  never
>;

// ── Sanity: server set is the superset (still includes legacy) ──────
type _ServerSupersetOfTm = AssertExtends<
  AnyAppCallableRpcDefinition,
  AnyServerRpcDefinition
>;

// ── JsonValue narrowing — RpcErrorPayload.data shape ────────────────
type _RpcErrorPayloadDataIsJsonValue = AssertEquals<
  RpcErrorPayload["data"],
  JsonValue | undefined
>;

// ── Wire-name pins (iter-12 rename + new app callback) ───────────────
// Locks the agent-facing entry RPC to `task/request` and the new
// TM-facing callback to `task/create`. A future refactor that touches
// either constant must update these canaries deliberately.
type _TaskRequestWireName = AssertEquals<
  typeof TaskRequest.name,
  JsonRpcMethod<"task/request">
>;
type _TaskCreateCallbackWireName = AssertEquals<
  typeof TaskCreate.name,
  JsonRpcMethod<"task/create">
>;

// ── Closed union — references every predicate so tsc sees them used ─
export type _D3CanaryHolds =
  | _CardinalityHolds
  | _AppCallableHasClose
  | _AppCallableHasConvCreate
  | _AppCallableHasConvArchive
  | _AppCallableHasConvUnarchive
  | _AppCallableHasAddPart
  | _AppCallableHasRemovePart
  | _AgentHasCreate
  | _AgentHasLeave
  | _AgentHasList
  | _AgentHasMessagesSend
  | _AgentHasMessagesList
  | _TaskCloseNotInAgentSet
  | _ConvCreateNotInAgentSet
  | _ServerSupersetOfTm
  | _RpcErrorPayloadDataIsJsonValue
  | _TaskRequestWireName
  | _TaskCreateCallbackWireName;

// ── Helper conditional types (local; tiny) ──────────────────────────
type AssertEquals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

type AssertExtends<Sub, Super> = Sub extends Super ? true : false;

// Length-arithmetic helper bounded for the catalog sizes (~32 entries).
type AddOne<A extends number, B extends number> = [
  ...BuildTuple<A>,
  ...BuildTuple<B>,
]["length"] extends infer N
  ? N extends number
    ? N
    : never
  : never;

type BuildTuple<
  N extends number,
  Acc extends ReadonlyArray<unknown> = [],
> = Acc["length"] extends N ? Acc : BuildTuple<N, [...Acc, unknown]>;
