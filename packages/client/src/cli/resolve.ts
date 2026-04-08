import type { MoltZapService } from "../service.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve "agent:<name-or-uuid>" to { type, id } with a real UUID.
 * If the id portion is already a UUID, returns it directly.
 * If it's a name, looks it up via agents/lookupByName.
 */
export async function resolveParticipant(
  service: MoltZapService,
  ref: string,
): Promise<{ type: string; id: string }> {
  const colon = ref.indexOf(":");
  if (colon === -1) {
    throw new Error(
      `Invalid participant "${ref}". Use format type:name (e.g. agent:alice).`,
    );
  }
  const type = ref.slice(0, colon);
  const value = ref.slice(colon + 1);

  if (UUID_RE.test(value)) {
    return { type, id: value };
  }

  if (type !== "agent") {
    throw new Error(
      `Cannot resolve "${ref}" — only agent names are supported.`,
    );
  }

  const result = (await service.sendRpc("agents/lookupByName", {
    names: [value],
  })) as {
    agents: Array<{ id: string; name: string }>;
  };

  if (result.agents.length === 0) {
    throw new Error(`Agent "${value}" not found.`);
  }
  return { type: "agent", id: result.agents[0]!.id };
}
