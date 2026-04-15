import type { Db } from "../db/client.js";
import { RpcError } from "../rpc/router.js";
import { ErrorCodes } from "@moltzap/protocol";
import type { AuthenticatedContext } from "../rpc/context.js";

/**
 * Shared utility for resolving and validating agent references.
 */
export class ParticipantService {
  constructor(private db: Db) {}

  async resolve(
    agentId: string,
  ): Promise<{ exists: boolean; ownerUserId: string | null }> {
    const row = await this.db
      .selectFrom("agents")
      .select(["id", "owner_user_id"])
      .where("id", "=", agentId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!row) return { exists: false, ownerUserId: null };
    return { exists: true, ownerUserId: row.owner_user_id };
  }

  async requireExists(agentId: string): Promise<string | null> {
    const resolved = await this.resolve(agentId);
    if (!resolved.exists) {
      throw new RpcError(ErrorCodes.NotFound, `Agent ${agentId} not found`);
    }
    return resolved.ownerUserId;
  }

  /** Get the owner user ID for a context. */
  static ownerIdFromContext(ctx: AuthenticatedContext): string | null {
    return ctx.ownerUserId;
  }

  /** Get owner user ID or throw Forbidden. Use in handlers that require a claimed agent. */
  static requireOwnerId(ctx: AuthenticatedContext): string {
    const userId = ctx.ownerUserId;
    if (!userId) {
      throw new RpcError(ErrorCodes.Forbidden, "Agent not claimed");
    }
    return userId;
  }
}
