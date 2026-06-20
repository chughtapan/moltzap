/** @file Task service tags and live layers. */

import { Context, Effect, Layer } from "effect";

import { DbTag } from "#db";
import { AppEndpointRegistryTag } from "#identity/apps";
import { ConversationServiceTag } from "#conversation";
import { MessageServiceTag } from "#message";

import { TaskAuthorizationService } from "./authorization.js";
import { TaskService } from "./task.service.js";

export class TaskAuthorizationServiceTag extends Context.Tag(
  "moltzap/TaskAuthorizationService",
)<TaskAuthorizationServiceTag, TaskAuthorizationService>() {}

export class TaskServiceTag extends Context.Tag("moltzap/TaskService")<
  TaskServiceTag,
  TaskService
>() {}

export const TaskAuthorizationServiceLive = Layer.effect(
  TaskAuthorizationServiceTag,
  Effect.gen(function* () {
    const appEndpointRegistry = yield* AppEndpointRegistryTag;
    return new TaskAuthorizationService(appEndpointRegistry);
  }).pipe(Effect.withSpan("TaskAuthorizationServiceLive")),
);

export const TaskServiceLive = Layer.effect(
  TaskServiceTag,
  Effect.gen(function* () {
    const db = yield* DbTag;
    const conversations = yield* ConversationServiceTag;
    const messages = yield* MessageServiceTag;
    return new TaskService(db, conversations, messages);
  }).pipe(Effect.withSpan("TaskServiceLive")),
);
