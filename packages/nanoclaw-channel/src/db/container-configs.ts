// Stub matching the subset of nanoclaw's src/db/container-configs.ts that
// moltzap.ts touches; resolves against the real sqlite-backed module inside
// a nanoclaw checkout.
const providers = new Map<string, string | null>();

export function ensureContainerConfig(
  agentGroupId: string,
  provider?: string | null,
): void {
  if (providers.has(agentGroupId)) return;
  providers.set(agentGroupId, provider ?? null);
}

/**
 * Test hook; the real nanoclaw module persists to sqlite.
 * @internal
 */
export function hasContainerConfig(agentGroupId: string): boolean {
  return providers.has(agentGroupId);
}

const scalarUpdates = new Map<string, Record<string, unknown>>();
const jsonUpdates = new Map<string, Record<string, unknown>>();

export function updateContainerConfigScalars(
  agentGroupId: string,
  updates: Partial<{
    provider: string | null;
    model: string | null;
    effort: string | null;
    image_tag: string | null;
    assistant_name: string | null;
    max_messages_per_prompt: number | null;
    cli_scope: string | null;
  }>,
): void {
  scalarUpdates.set(agentGroupId, {
    ...scalarUpdates.get(agentGroupId),
    ...updates,
  });
}

export function updateContainerConfigJson(
  agentGroupId: string,
  column:
    | "skills"
    | "mcp_servers"
    | "packages_apt"
    | "packages_npm"
    | "additional_mounts",
  value: unknown,
): void {
  jsonUpdates.set(agentGroupId, {
    ...jsonUpdates.get(agentGroupId),
    [column]: value,
  });
}

/**
 * Test hook; the real nanoclaw module persists to sqlite.
 * @internal
 */
export function recordedContainerConfig(agentGroupId: string): {
  readonly scalars: Record<string, unknown>;
  readonly json: Record<string, unknown>;
} {
  return {
    scalars: scalarUpdates.get(agentGroupId) ?? {},
    json: jsonUpdates.get(agentGroupId) ?? {},
  };
}

/**
 * Test hook; clears recorded updates between cases.
 * @internal
 */
export function resetRecordedContainerConfigs(): void {
  scalarUpdates.clear();
  jsonUpdates.clear();
}
