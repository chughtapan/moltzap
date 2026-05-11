/**
 * Unauthenticated caller → typed denial on an auth-gated RPC. Opens a
 * TestClient with `autoConnect: false` and calls `conversations/list`
 * without first completing `network/connect`; asserts the server replies
 * with a typed error (not a success, not a crash).
 */
import { Effect, Either } from "effect";
import {
  ForbiddenError,
  UnauthorizedError,
} from "../../../transport/wire-errors.js";
import { ConversationsList } from "@moltzap/protocol/task";
import { authorizationOutcome } from "../../models/dispatch.js";
import { initialReferenceState } from "../../models/state.js";
import { agentId } from "../_shared/test-fixtures.js";
import { RpcResponseError } from "../_shared/errors.js";
import { makeTestClient } from "../_shared/driver/test-client.js";
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

export function registerAuthorityNegative(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "unauthenticated agent → typed denial on conversations/list",
    Effect.scoped(
      Effect.gen(function* () {
        // We still need an agentKey to open the socket, but we skip
        // `network/connect` so the server sees an un-authed session.
        const agent = yield* registerTestAgent({
          baseUrl: ctx.realServer.baseUrl,
          name: "an",
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason: `agent registration failed: ${e.body}`,
              }),
          ),
        );
        const client = yield* makeTestClient({
          serverUrl: ctx.realServer.wsUrl,
          agentKey: agent.apiKey,
          agentId: agent.agentId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
          captureCapacity: DEFAULT_CAPTURE_CAPACITY,
          autoConnect: false,
        }).pipe(
          Effect.mapError(
            (e) =>
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason: `client acquire failed: ${String(e)}`,
              }),
          ),
        );
        const outcome = yield* client
          .sendRpc(ConversationsList, {})
          .pipe(Effect.either);
        const error = yield* Either.match(outcome, {
          onLeft: (failure) => Effect.succeed(failure),
          onRight: () =>
            Effect.fail(
              new PropertyInvariantViolation({
                category: CATEGORY,
                name: PROPERTY,
                reason:
                  "pre-handshake conversations/list returned success — expected typed denial",
              }),
            ),
        });
        // Narrow the Left: must be a typed auth-shaped RpcResponseError
        // (Unauthorized / Forbidden). A timeout or transport-close
        // would also surface as `Left` but does NOT satisfy the
        // property — it proves nothing about authorization.
        if (!(error instanceof RpcResponseError)) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `expected RpcResponseError, got ${error._tag}`,
            }),
          );
        }
        const code = error.code;
        const isAuthShaped =
          code === UnauthorizedError.code || code === ForbiddenError.code;
        if (!isAuthShaped) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `expected Unauthorized/Forbidden code (${UnauthorizedError.code} / ${ForbiddenError.code}), got ${code}`,
            }),
          );
        }
        // Oracle cross-check: the model also predicts deny for this
        // unauthenticated caller. Keeps the model honest alongside the
        // server.
        const modelVerdict = authorizationOutcome(
          initialReferenceState,
          {
            definition: ConversationsList,
            method: ConversationsList.name,
            params: {},
          },
          agentId("00000000-0000-4000-8000-000000000000"),
        );
        if (modelVerdict !== "deny-unauthenticated") {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: PROPERTY,
              reason: `model oracle disagrees: expected deny-unauthenticated, got ${modelVerdict}`,
            }),
          );
        }
      }),
    ),
  );
}
