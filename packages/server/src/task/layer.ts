/** @file Task service tags and live layers. */

import { Context, Effect, Layer } from "effect";
import { taskCreate } from "@moltzap/protocol/task";
import type { AppId } from "@moltzap/protocol/identity";
import type { ParamsOf, ResultOf } from "@moltzap/protocol/rpc";

import { DbTag } from "#db";
import {
  AppEndpointRegistryTag,
  callAppRpc,
  type AppEndpointRegistry,
  wrapHookEffectWithEnvelope,
} from "#identity/apps";
import { ConversationServiceTag } from "#conversation";
import { MessageServiceTag } from "#message";

import { TaskService } from "./task.service.js";

type TaskCreateVerdict = ResultOf<typeof taskCreate>["verdict"];

class TaskAuthorizationService {
  private readonly apps: AppEndpointRegistry;

  constructor(apps: AppEndpointRegistry) {
    this.apps = apps;
  }

  authorizeCreate(
    appId: AppId,
    ctx: ParamsOf<typeof taskCreate>,
  ): Effect.Effect<TaskCreateVerdict> {
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
            definition: taskCreate,
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
      default: {
        const exhaustive: never = policy;
        return exhaustive;
      }
    }
  }
}

/** Implements task authorization service tag. */
export class TaskAuthorizationServiceTag extends Context.Tag(
  "moltzap/TaskAuthorizationService",
)<TaskAuthorizationServiceTag, TaskAuthorizationService>() {}

/** Implements task service tag. */
export class TaskServiceTag extends Context.Tag("moltzap/TaskService")<
  TaskServiceTag,
  TaskService
>() {}

/** Provides the task authorization service live runtime value. */
export const taskAuthorizationServiceLive = Layer.effect(
  TaskAuthorizationServiceTag,
  Effect.gen(function* () {
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new TaskAuthorizationService(appEndpointRegistry);
  }).pipe(Effect.withSpan("TaskAuthorizationServiceLive")),
);

/** Provides the task service live runtime value. */
export const taskServiceLive = Layer.effect(
  TaskServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const messages = yield* MessageServiceTag;
    return new TaskService(db, conversations, messages);
  }).pipe(Effect.withSpan("TaskServiceLive")),
);
