export {};

declare module "vitest" {
  export interface ProvidedContext {
    testPgHost: string;
    testPgPort: number;
    testDbName: string;
    echoPort: number;
    baseUrl: string;
    wsUrl: string;
    containerAId: string;
    containerAAgentId: string;
    containerAApiKey: string;
    containerAUserId: string;
    containerASupabaseUid: string;
    containerBId: string;
    containerBAgentId: string;
    containerBApiKey: string;
    containerBUserId: string;
    containerBSupabaseUid: string;
  }
}
