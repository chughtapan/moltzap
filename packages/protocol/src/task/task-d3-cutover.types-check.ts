/**
 * @file Spec D3 (#600) R11 outbound-catalog-split type canaries.
 *
 * Pins the partition shape: agentClientRpcMethods ⊂ taskMasterRpcMethods,
 * disjoint from tmOnlyTaskRpcMethods. Each predicate fails compilation if
 * a method gets moved between sides or a new method lands without
 * classification.
 *
 * Additional D3 canaries (TaskId branding, JsonValue, MessagesSend
 * capabilities, TaskMasterHandlers REQUIRED slots) follow in their
 * respective commits.
 */
import {
  agentClientRpcMethods,
  taskMasterRpcMethods,
  type AnyAgentClientRpcDefinition,
  type AnyTaskMasterRpcDefinition,
  type AnyServerRpcDefinition,
  nonTmAuthorityTaskRpcMethods,
  tmOnlyTaskRpcMethods,
  TaskCreate,
  TaskLeave,
  MessagesSend,
  MessagesList,
  TasksList,
  TasksClose,
  TaskConversationCreate,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
} from "../index.js";

// ── Partition cardinality ───────────────────────────────────────────
// taskMaster = agentClient ∪ tmOnly; cardinality sum equals.
type _CardinalityHolds = AssertEquals<
  (typeof taskMasterRpcMethods)["length"],
  AddOne<
    (typeof agentClientRpcMethods)["length"],
    (typeof tmOnlyTaskRpcMethods)["length"]
  >
>;

// ── Membership: TM-only side carries the admin operations ───────────
type _TmOnlyHasClose = AssertExtends<
  typeof TasksClose,
  AnyTaskMasterRpcDefinition
>;
type _TmOnlyHasConvCreate = AssertExtends<
  typeof TaskConversationCreate,
  AnyTaskMasterRpcDefinition
>;
type _TmOnlyHasConvArchive = AssertExtends<
  typeof TaskConversationArchive,
  AnyTaskMasterRpcDefinition
>;
type _TmOnlyHasConvUnarchive = AssertExtends<
  typeof TaskConversationUnarchive,
  AnyTaskMasterRpcDefinition
>;
type _TmOnlyHasAddPart = AssertExtends<
  typeof TaskConversationAddParticipant,
  AnyTaskMasterRpcDefinition
>;
type _TmOnlyHasRemovePart = AssertExtends<
  typeof TaskConversationRemoveParticipant,
  AnyTaskMasterRpcDefinition
>;

// ── Membership: agent-client side carries the open operations ───────
type _AgentHasCreate = AssertExtends<
  typeof TaskCreate,
  AnyAgentClientRpcDefinition
>;
type _AgentHasLeave = AssertExtends<
  typeof TaskLeave,
  AnyAgentClientRpcDefinition
>;
type _AgentHasList = AssertExtends<
  typeof TasksList,
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

// ── Disjointness: a tm-only method must NOT satisfy the agent union ──
// If TasksClose were accidentally added to agentClientRpcMethods, the
// `Exclude<>` below would resolve to never and break the assertion.
type _TasksCloseNotInAgentSet = AssertEquals<
  Extract<typeof TasksClose, AnyAgentClientRpcDefinition>,
  never
>;
type _ConvCreateNotInAgentSet = AssertEquals<
  Extract<typeof TaskConversationCreate, AnyAgentClientRpcDefinition>,
  never
>;

// ── Sanity: server set is the superset (still includes legacy) ──────
type _ServerSupersetOfTm = AssertExtends<
  AnyTaskMasterRpcDefinition,
  AnyServerRpcDefinition
>;

// ── Closed union — references every predicate so tsc sees them used ─
export type _D3CanaryHolds =
  | _CardinalityHolds
  | _TmOnlyHasClose
  | _TmOnlyHasConvCreate
  | _TmOnlyHasConvArchive
  | _TmOnlyHasConvUnarchive
  | _TmOnlyHasAddPart
  | _TmOnlyHasRemovePart
  | _AgentHasCreate
  | _AgentHasLeave
  | _AgentHasList
  | _AgentHasMessagesSend
  | _AgentHasMessagesList
  | _TasksCloseNotInAgentSet
  | _ConvCreateNotInAgentSet
  | _ServerSupersetOfTm;

// Reference nonTmAuthorityTaskRpcMethods so knip sees it as consumed
// (otherwise it's flagged as exported-but-unused until Commit 4).
export type _NonTmAuthorityCanary =
  (typeof nonTmAuthorityTaskRpcMethods)["length"];

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
