import type { Db } from "../db/client.js";
import type { Logger } from "../logger.js";
import type { RegisterParams } from "@moltzap/protocol";
import {
  generateApiKey,
  generateClaimToken,
  parseApiKey,
  hashSecret,
} from "../auth/agent-auth.js";

export class AuthService {
  constructor(
    private db: Db,
    private logger: Logger,
  ) {}

  async registerAgent(
    params: RegisterParams,
  ): Promise<{ agentId: string; apiKey: string }> {
    const { apiKey, keyId, secretHash } = generateApiKey();

    const result = await this.db
      .insertInto("agents")
      .values({
        name: params.name,
        description: params.description ?? null,
        api_key_id: keyId,
        api_key_secret_hash: secretHash,
        claim_token: generateClaimToken(),
        status: "active",
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();

    const agentId = result.id;

    this.logger.info({ agentId, name: params.name }, "Agent registered");

    return { agentId, apiKey };
  }

  async authenticateAgent(apiKey: string): Promise<{
    agentId: string;
    status: string;
    ownerUserId: string | null;
  } | null> {
    const parsed = parseApiKey(apiKey);
    if (!parsed) return null;

    const row = await this.db
      .selectFrom("agents")
      .select(["id", "api_key_secret_hash", "status", "owner_user_id"])
      .where("api_key_id", "=", parsed.keyId)
      .where("status", "!=", "suspended")
      .executeTakeFirst();

    if (!row) return null;
    if (hashSecret(parsed.secret) !== row.api_key_secret_hash) return null;

    return {
      agentId: row.id,
      status: row.status,
      ownerUserId: row.owner_user_id ?? null,
    };
  }
}
