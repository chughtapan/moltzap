export {};

declare module "vitest" {
  export interface ProvidedContext {
    testPgHost: string;
    testPgPort: number;
  }
}
