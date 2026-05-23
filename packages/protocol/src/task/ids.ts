import { type Static } from "@sinclair/typebox";
import { brandedId } from "../schema-primitives.js";

export const TaskId = brandedId("TaskId");
export type TaskId = Static<typeof TaskId>;

export const AppId = brandedId("AppId");
export type AppId = Static<typeof AppId>;

export const DEFAULT_APP_ID = "e12fe562-ed1f-4d2d-bed5-68b8edfa41cb" as AppId;
