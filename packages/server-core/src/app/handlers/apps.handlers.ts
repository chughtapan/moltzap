import type { AppHost } from "../app-host.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import type {
  AppsCreateParams,
  AppsAttestSkillParams,
  AppsGrantPermissionParams,
} from "@moltzap/protocol";
import { validators, ErrorCodes } from "@moltzap/protocol";
import { defineMethod } from "../../rpc/context.js";
import { RpcError } from "../../rpc/router.js";

export function createAppHandlers(deps: {
  appHost: AppHost;
}): RpcMethodRegistry {
  return {
    "apps/create": defineMethod<AppsCreateParams>({
      validator: validators.appsCreateParams,
      handler: async (params, ctx) => {
        if (ctx.kind !== "agent") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Only agents can create app sessions",
          );
        }

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
        if (ctx.kind !== "agent") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Only agents can attest skills",
          );
        }

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
        if (ctx.kind !== "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Only users can grant permissions",
          );
        }

        deps.appHost.resolvePermission(
          ctx.userId,
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
