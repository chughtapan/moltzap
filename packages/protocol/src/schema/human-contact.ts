import { Type, type Static } from "@sinclair/typebox";
import { brandedId, stringEnum } from "../helpers.js";
import { defineRpc } from "../rpc.js";
import { UserId } from "./primitives.js";

const TaskId = brandedId("TaskId");
const AppId = brandedId("AppId");

export const HumanContactTypeSchema = stringEnum([
  "permission_grant",
  "notification",
  "approval_gate",
  "onboarding_prompt",
]);

export const PermissionGrantRequestSchema = Type.Object(
  {
    type: Type.Literal("permission_grant"),
    taskId: TaskId,
    userId: UserId,
    appId: AppId,
    resource: Type.String(),
    access: Type.Array(Type.String()),
    prompt: Type.String(),
    timeoutMs: Type.Integer(),
  },
  { additionalProperties: false },
);

export const NotificationRequestSchema = Type.Object(
  {
    type: Type.Literal("notification"),
    taskId: TaskId,
    userId: UserId,
    appId: AppId,
    prompt: Type.String(),
    timeoutMs: Type.Integer(),
  },
  { additionalProperties: false },
);

export const ApprovalGateRequestSchema = Type.Object(
  {
    type: Type.Literal("approval_gate"),
    taskId: TaskId,
    userId: UserId,
    appId: AppId,
    prompt: Type.String(),
    timeoutMs: Type.Integer(),
  },
  { additionalProperties: false },
);

export const OnboardingPromptRequestSchema = Type.Object(
  {
    type: Type.Literal("onboarding_prompt"),
    taskId: TaskId,
    userId: UserId,
    appId: AppId,
    prompt: Type.String(),
    timeoutMs: Type.Integer(),
  },
  { additionalProperties: false },
);

export const HumanContactRequestSchema = Type.Union([
  PermissionGrantRequestSchema,
  NotificationRequestSchema,
  ApprovalGateRequestSchema,
  OnboardingPromptRequestSchema,
]);

export const PermissionGrantResponseSchema = Type.Object(
  {
    type: Type.Literal("permission_grant"),
    access: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const NotificationResponseSchema = Type.Object(
  {
    type: Type.Literal("notification"),
    acknowledgedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export const ApprovalGateResponseSchema = Type.Object(
  {
    type: Type.Literal("approval_gate"),
    approved: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const OnboardingPromptResponseSchema = Type.Object(
  {
    type: Type.Literal("onboarding_prompt"),
    completed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const HumanContactResponseSchema = Type.Union([
  PermissionGrantResponseSchema,
  NotificationResponseSchema,
  ApprovalGateResponseSchema,
  OnboardingPromptResponseSchema,
]);

export const HumanContactRequiredEventSchema = Type.Object(
  {
    requestId: Type.String({ format: "uuid" }),
    request: HumanContactRequestSchema,
  },
  { additionalProperties: false },
);

export const HumanContactResolve = defineRpc({
  name: "humanContact/resolve",
  params: Type.Object(
    {
      requestId: Type.String({ format: "uuid" }),
      response: HumanContactResponseSchema,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const HumanContactReject = defineRpc({
  name: "humanContact/reject",
  params: Type.Object(
    {
      requestId: Type.String({ format: "uuid" }),
      reason: Type.String(),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const HumanContactGrantsList = defineRpc({
  name: "humanContact/grants/list",
  params: Type.Object(
    { appId: Type.Optional(AppId) },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      grants: Type.Array(
        Type.Object(
          {
            appId: AppId,
            resource: Type.String(),
            access: Type.Array(Type.String()),
            grantedAt: Type.String({ format: "date-time" }),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
});

export const HumanContactGrantsRevoke = defineRpc({
  name: "humanContact/grants/revoke",
  params: Type.Object(
    { appId: AppId, resource: Type.String() },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export type HumanContactType = Static<typeof HumanContactTypeSchema>;
export type HumanContactRequest = Static<typeof HumanContactRequestSchema>;
export type HumanContactResponse = Static<typeof HumanContactResponseSchema>;
export type PermissionGrantRequest = Static<
  typeof PermissionGrantRequestSchema
>;
export type PermissionGrantResponse = Static<
  typeof PermissionGrantResponseSchema
>;
export type NotificationRequest = Static<typeof NotificationRequestSchema>;
export type NotificationResponse = Static<typeof NotificationResponseSchema>;
export type ApprovalGateRequest = Static<typeof ApprovalGateRequestSchema>;
export type ApprovalGateResponse = Static<typeof ApprovalGateResponseSchema>;
export type OnboardingPromptRequest = Static<
  typeof OnboardingPromptRequestSchema
>;
export type OnboardingPromptResponse = Static<
  typeof OnboardingPromptResponseSchema
>;
export type HumanContactRequiredEvent = Static<
  typeof HumanContactRequiredEventSchema
>;
