import { Context } from "effect";
import type { Task } from "../tasks.js";

/**
 * Capability — caller's WS connection IS the registered remote-app
 * connection for `task.appId`. The obtain helper resolves the proof
 * via `AppHost.isAppConnection(task.appId, callerConnId)`; the bind
 * is stable across requests on the same WS and invalidated by the
 * connection's Scope finalizer.
 *
 * Value payload carries the `task` row already fetched by the obtain
 * helper so consumers don't re-query.
 */
export interface TmAuthorityValue {
  readonly task: Task;
}

export class TmAuthority extends Context.Tag("@moltzap/protocol/TmAuthority")<
  TmAuthority,
  TmAuthorityValue
>() {}
