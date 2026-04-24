/**
 * Vitest `ProvidedContext` keys published by `vitest.integration.globalSetup.ts`.
 * Kept alongside the integration tests so `inject(...)` has typed keys.
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
