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
