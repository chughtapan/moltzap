export {};

declare module "vitest" {
  export interface ProvidedContext {
    baseUrl: string;
    wsUrl: string;
    containerAId: string;
    containerAAgentId: string;
    containerAApiKey: string;
    containerBId: string;
    containerBAgentId: string;
    containerBApiKey: string;
  }
}
