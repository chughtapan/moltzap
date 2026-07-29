import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import { Data, Effect } from "effect";
import { serverBaseUrl, type ServerBaseUrl } from "@moltzap/protocol/network";
import {
  resetCoreTestDb,
  startCoreTestServer,
  stopCoreTestServer,
} from "@moltzap/server-core/test-utils";
import { INTEGRATION_HOOK_TIMEOUT_MS } from "./constants.js";

let baseUrl = "";
let wsUrl = "";

class ServiceIntegrationHookError extends Data.TaggedError(
  "ServiceIntegrationHookError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

const hookPromise = <A>(operation: string, evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new ServiceIntegrationHookError({ operation, cause }),
  });

export function setupServiceIntegration(): void {
  beforeAll(
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const pgHost = inject("testPgHost");
          const pgPort = inject("testPgPort");
          const server = yield* hookPromise("startCoreTestServer", () =>
            startCoreTestServer({ pgHost, pgPort }),
          );
          baseUrl = server.baseUrl;
          wsUrl = server.wsUrl;
        }).pipe(Effect.withSpan("setupServiceIntegration")),
      ),
    INTEGRATION_HOOK_TIMEOUT_MS,
  );

  afterAll(() =>
    Effect.runPromise(
      hookPromise("stopCoreTestServer", () => stopCoreTestServer()),
    ),
  );

  beforeEach(() =>
    Effect.runPromise(hookPromise("resetCoreTestDb", () => resetCoreTestDb())),
  );
}

export function coreBaseUrl(): ServerBaseUrl {
  return serverBaseUrl(baseUrl);
}

export function coreWsUrl(): string {
  return wsUrl;
}
