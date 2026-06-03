/**
 * Unauthenticated caller → typed denial on an auth-gated RPC. Opens a
 * TestClient with `autoConnect: false` and calls `task/list`
 * without first completing `network/connect`; asserts the server replies
 * with a typed error (not a success, not a crash).
 */
import { Effect, Either } from "effect";
import { TaskList } from "../../../task/index.js";
import { RpcResponseError } from "../_shared/errors.js";
import {
  makeTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";

const CATEGORY = "rpc-semantics" as const;
const PROPERTY = "authority-negative";
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

const invariant = (reason: string): PropertyInvariantViolation =>
  new PropertyInvariantViolation({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });

export function registerAuthorityNegative(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "unauthenticated agent → typed denial on task/list",
    assertAuthorityNegative(ctx).pipe(
      Effect.withSpan("registerAuthorityNegative"),
    ),
  );
}

function assertAuthorityNegative(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* acquirePreHandshakeClient(ctx);
      yield* assertTaskListDenied(client);
    }),
  );
}

function acquirePreHandshakeClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "an",
    }).pipe(
      Effect.mapError((e) => invariant(`agent registration failed: ${e.body}`)),
    );
    return yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
      autoConnect: false,
    }).pipe(
      Effect.mapError((e) => invariant(`client acquire failed: ${String(e)}`)),
    );
  });
}

function assertTaskListDenied(client: TestClient) {
  return Effect.gen(function* () {
    const outcome = yield* client.sendRpc(TaskList, {}).pipe(Effect.either);
    const error = yield* Either.match(outcome, {
      onLeft: (failure) => Effect.succeed(failure),
      onRight: () =>
        Effect.fail(
          invariant(
            "pre-handshake task/list returned success — expected typed denial",
          ),
        ),
    });
    yield* assertAuthResponseError(error);
  });
}

function assertAuthResponseError(error: unknown) {
  if (!(error instanceof RpcResponseError)) {
    return Effect.fail(
      invariant(`expected RpcResponseError, got ${String(error)}`),
    );
  }
  const isAuthShaped =
    error.tag === "Unauthorized" || error.tag === "Forbidden";
  return isAuthShaped
    ? Effect.void
    : Effect.fail(
        invariant(`expected Unauthorized/Forbidden error, got ${error.tag}`),
      );
}
