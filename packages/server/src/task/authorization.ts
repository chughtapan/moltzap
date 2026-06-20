import { Effect } from "effect";
import { TaskCreate } from "@moltzap/protocol/task";
import type { AppId } from "@moltzap/protocol/identity";
import type { ParamsOf, ResultOf } from "@moltzap/protocol/rpc";
import {
  callAppRpc,
  type AppEndpointRegistry,
  wrapHookEffectWithEnvelope,
} from "#identity/apps";

export type TaskCreateVerdict = ResultOf<typeof TaskCreate>["verdict"];

export class TaskAuthorizationService {
  constructor(private readonly apps: AppEndpointRegistry) {}

  authorizeCreate(
    appId: AppId,
    ctx: ParamsOf<typeof TaskCreate>,
  ): Effect.Effect<TaskCreateVerdict, never> {
    const entry = this.apps.lookupApp(appId);
    if (entry === undefined) {
      return Effect.succeed({
        decision: "reject",
        reason: "app_unreachable",
      });
    }
    const policy = entry.manifest.hooks.task_create;
    switch (policy.kind) {
      case "accept":
        return Effect.succeed({ decision: "accept" });
      case "reject":
        return Effect.succeed({
          decision: "reject",
          reason: policy.reason,
        });
      case "hook": {
        const timeoutMs = policy.timeoutMs;
        return wrapHookEffectWithEnvelope({
          raw: callAppRpc(entry, {
            definition: TaskCreate,
            params: ctx,
          }).pipe(Effect.map((envelope) => envelope.verdict)),
          timeoutMs,
          timeoutLogMessage: "app/task/create timed out",
          timeoutLogContext: { taskId: ctx.taskId, appId, timeoutMs },
          errorLogMessage: "app/task/create error",
          errorLogContext: { taskId: ctx.taskId, appId },
          onTimeout: () => ({
            decision: "reject",
            reason: "timeout",
          }),
          onError: () => ({
            decision: "reject",
            reason: "app_unreachable",
          }),
        });
      }
    }
  }
}
