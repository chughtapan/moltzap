import type { AppHost } from "../app-host.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import type {
  AppsCreateParams,
  AppsAttestSkillParams,
  AppsGrantPermissionParams,
} from "@moltzap/protocol";
import { validators } from "@moltzap/protocol";
import { defineMethod } from "../../rpc/context.js";
import { ParticipantService } from "../../services/participant.service.js";

export function createAppHandlers(deps: {
  appHost: AppHost;
}): RpcMethodRegistry {
  return {
    "apps/create": defineMethod<AppsCreateParams>({
      validator: validators.appsCreateParams,
      handler: async (params, ctx) => {
        const session = await deps.appHost.createSession(
          params.appId,
          ctx.agentId,
          params.invitedAgentIds,
        );

        return { session };
      },
    }),

    "apps/attestSkill": defineMethod<AppsAttestSkillParams>({
      validator: validators.appsAttestSkillParams,
      handler: async (params, ctx) => {
        deps.appHost.resolveChallenge(
          params.challengeId,
          ctx.agentId,
          params.skillUrl,
          params.version,
        );

        return {};
      },
    }),

    "apps/grantPermission": defineMethod<AppsGrantPermissionParams>({
      validator: validators.appsGrantPermissionParams,
      handler: async (params, ctx) => {
        const ownerUserId = ParticipantService.requireOwnerId(ctx);

        deps.appHost.resolvePermission(
          ownerUserId,
          params.sessionId,
          params.agentId,
          params.resource,
          params.access,
        );

        return {};
      },
    }),
  };
}
