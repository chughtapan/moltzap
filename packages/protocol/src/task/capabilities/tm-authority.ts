import { Context } from "effect";
import type { Task } from "../tasks.js";
import type { AgentId } from "../../identity/index.js";

/**
 * Tier 1 capability — caller is the registered task manager for `task.id`.
 *
 * Value payload carries the `task` row already fetched by today's
 * `TaskService.loadTaskAsTmAuthority` check; consumers reuse the payload
 * instead of re-querying. `callerAgentId` lets refine-shape capabilities
 * (e.g. `MessageSendPermission.forTmBypass`) verify the same agent
 * authored the bypass decision.
 *
 * Consumed by the `task.service.ts` public methods (`closeWithLifecycle`,
 * `addParticipant`, `removeParticipant`, `createConversation`,
 * `closeConversation`, `storeMessage`) via the R-channel; handlers
 * wire the value with `Effect.provideServiceEffect(TmAuthority,
 * obtainTmAuthority(...))`.
 */
export interface TmAuthorityValue {
  readonly task: Task;
  readonly callerAgentId: AgentId;
}

export class TmAuthority extends Context.Tag("@moltzap/protocol/TmAuthority")<
  TmAuthority,
  TmAuthorityValue
>() {}
