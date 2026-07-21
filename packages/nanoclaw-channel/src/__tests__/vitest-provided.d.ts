/**
 * Vitest `ProvidedContext` keys published by `vitest.integration.globalSetup.ts`.
 * Kept alongside the integration tests so `inject(...)` has typed keys.
 *
 * Mirrors `packages/openclaw-channel/src/__tests__/vitest-provided.d.ts`
 * — both packages use the same `moltzap*`-prefixed inject keys, which are
 * collision-free across packages.
 */

import "vitest";

declare module "vitest" {
  interface ProvidedContext {
    moltzapBaseUrl: string;
    moltzapWsUrl: string;
    agentAAgentId: string;
    agentAApiKey: string;
    agentBAgentId: string;
    agentBApiKey: string;
  }
}
