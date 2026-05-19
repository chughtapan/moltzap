/**
 * Vitest `ProvidedContext` keys published by `vitest.integration.globalSetup.ts`.
 * Kept alongside the integration tests so `inject(...)` has typed keys.
 *
 * Mirrors `packages/claude-code-channel/src/__tests__/vitest-provided.d.ts`
 * — both packages use the same `moltzap*`-prefixed inject keys (collision-
 * free, future-proof; see spec C #597 §"Verified facts" #5).
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
