import { Type, type Static } from "@sinclair/typebox";

export const InvitesCreateAgentParamsSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export type InvitesCreateAgentParams = Static<
  typeof InvitesCreateAgentParamsSchema
>;
