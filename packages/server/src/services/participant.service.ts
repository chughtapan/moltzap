import type { Db } from "../db/client.js";
import type { ParticipantRef } from "@moltzap/protocol";
import { RpcError } from "../rpc/router.js";
import { ErrorCodes } from "@moltzap/protocol";
import type { AuthenticatedContext } from "../rpc/context.js";

/**
 * Shared utility for resolving and validating participant references.
 * Validates that the referenced user or agent actually exists.
 */
export class ParticipantService {
  constructor(private db: Db) {}

  async resolve(
    ref: ParticipantRef,
  ): Promise<{ exists: boolean; ownerUserId: string | null }> {
    if (ref.type === "user") {
      const row = await this.db
        .selectFrom("users")
        .select("id")
        .where("id", "=", ref.id)
        .where("status", "=", "active")
        .executeTakeFirst();
      return { exists: !!row, ownerUserId: ref.id };
    }

    if (ref.type === "agent") {
      const row = await this.db
        .selectFrom("agents")
        .select(["id", "owner_user_id"])
        .where("id", "=", ref.id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!row) return { exists: false, ownerUserId: null };
      return { exists: true, ownerUserId: row.owner_user_id };
    }

    return { exists: false, ownerUserId: null };
  }

  async requireExists(ref: ParticipantRef): Promise<string | null> {
    const resolved = await this.resolve(ref);
    if (!resolved.exists) {
      throw new RpcError(
        ErrorCodes.NotFound,
        `${ref.type} ${ref.id} not found`,
      );
    }
    return resolved.ownerUserId;
  }

  /** Extract a ParticipantRef from an authenticated context. */
  static refFromContext(ctx: AuthenticatedContext): ParticipantRef {
    if (ctx.kind === "agent") return { type: "agent", id: ctx.agentId };
    // JWT users resolve to active agent — MoltZap conversations are agent-only
    if (ctx.activeAgentId) return { type: "agent", id: ctx.activeAgentId };
    // No active agent = hard error. Contacts use ownerIdFromContext() instead.
    throw new RpcError(
      ErrorCodes.Forbidden,
      "No active agent. Claim an agent first.",
    );
  }

  /** Get the owner user ID for a context (the user themselves, or the agent's owner). */
  static ownerIdFromContext(ctx: AuthenticatedContext): string | null {
    return ctx.kind === "user" ? ctx.userId : ctx.ownerUserId;
  }

  /** Get owner user ID or throw Forbidden. Use in handlers that require a claimed agent. */
  static requireOwnerId(ctx: AuthenticatedContext): string {
    const userId = ParticipantService.ownerIdFromContext(ctx);
    if (!userId) {
      throw new RpcError(ErrorCodes.Forbidden, "Agent not claimed");
    }
    return userId;
  }
}
