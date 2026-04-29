import { Context, Data, Effect } from "effect";
import type {
  AgentId,
  ConversationId,
  MutationAttempt,
  TaskId,
  TaskManagerAction,
  TaskMessagePayload,
} from "@moltzap/protocol/task";

export class DefaultTmStorageFailed extends Data.TaggedError(
  "DefaultTmStorageFailed",
)<{
  readonly taskId: TaskId;
  readonly conversationId: ConversationId | null;
  readonly detail: string;
}> {}

export class DefaultTmTaskClosed extends Data.TaggedError(
  "DefaultTmTaskClosed",
)<{
  readonly taskId: TaskId;
}> {}

/**
 * DM-specific rejection surfaced when a caller attempts a participant
 * mutation on a DM-bound task. Spec #137 round-2 goal 2: DM immutability
 * lives in the default DM task manager (not in slice B's CRUD, which spec
 * #136 round-3 made mechanical).
 */
export class DmImmutableError extends Data.TaggedError("DmImmutableError")<{
  readonly taskId: TaskId;
  readonly participantId: AgentId;
  readonly detail: "add_participant_forbidden" | "remove_participant_forbidden";
}> {}

export type DefaultTaskManagerError =
  | DefaultTmStorageFailed
  | DefaultTmTaskClosed
  | DmImmutableError;

/**
 * Default group passthrough TM (replaces round-2's `DefaultPassthroughTaskManager`).
 * Runs in-process with the task layer; no network hop. Calls slice B
 * `TaskService.storeMessage`, reads the participant set via slice B
 * `TaskService.listParticipants`, and returns `Forward(participants \ sender)`.
 * The per-recipient `NetworkDeliveryService.send` fan-out happens AFTER
 * `handle` returns, at the task-layer switch site; any fan-out failure
 * surfaces there with a task-layer-switch-owned tag (NOT on this channel).
 */
export interface DefaultGroupTaskManager {
  readonly handle: (
    payload: TaskMessagePayload,
  ) => Effect.Effect<
    TaskManagerAction,
    DefaultTmStorageFailed | DefaultTmTaskClosed,
    never
  >;
}

export class DefaultGroupTaskManagerTag extends Context.Tag(
  "DefaultGroupTaskManager",
)<DefaultGroupTaskManagerTag, DefaultGroupTaskManager>() {}

export const makeDefaultGroupTaskManager = (): Effect.Effect<
  DefaultGroupTaskManager,
  never,
  never
> => {
  throw new Error("not implemented");
};

/**
 * Default DM task manager. Exactly two participants. Enforces:
 *   - uniqueness at creation via `lookupExistingDm(a, b)` (SELECT-before-INSERT
 *     against `task_manager_endpoints` + slice B `TaskService.listParticipants`);
 *     best-effort — spec #136 round-3 dropped the DB partial unique index.
 *   - immutability at mutation via `validateAction(taskId, action)`; the
 *     task-layer wire surface consults this before calling
 *     `TaskService.addParticipant` / `removeParticipant` on a DM-bound task
 *     and surfaces `DmImmutableError` on rejection.
 *   - store-and-fan-out via `handle(payload)` (same semantics as the group TM;
 *     `Forward` always carries a 1-element recipient list since DM has two
 *     participants).
 */
export interface DefaultDmTaskManager {
  readonly handle: (
    payload: TaskMessagePayload,
  ) => Effect.Effect<
    TaskManagerAction,
    DefaultTmStorageFailed | DefaultTmTaskClosed,
    never
  >;

  readonly lookupExistingDm: (
    a: AgentId,
    b: AgentId,
  ) => Effect.Effect<TaskId | null, DefaultTmStorageFailed, never>;

  // Validates a task-layer mutation attempt (NOT a TaskManagerAction return
  // value). `MutationAttempt` is the typed CRUD-call-gate union defined in
  // @moltzap/protocol/task covering {AddParticipantAttempt,
  // RemoveParticipantAttempt, CloseTaskAttempt}. The task-layer wire surface
  // calls this BEFORE invoking the corresponding TaskService mutation, and
  // bounces the caller with DmImmutableError on reject. This removes the
  // round-3 special case `kind === "default-dm"` from the task-layer code path.
  readonly validateAction: (
    taskId: TaskId,
    attempt: MutationAttempt,
  ) => Effect.Effect<void, DmImmutableError, never>;
}

export class DefaultDmTaskManagerTag extends Context.Tag(
  "DefaultDmTaskManager",
)<DefaultDmTaskManagerTag, DefaultDmTaskManager>() {}

export const makeDefaultDmTaskManager = (): Effect.Effect<
  DefaultDmTaskManager,
  never,
  never
> => {
  throw new Error("not implemented");
};
