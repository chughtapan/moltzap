/**
 * A representative sample of method names reaches the real server.
 * Full-set coverage is exercised by `schema-exhaustive-fuzz`; this
 * property asserts the wire path is alive for a small stratified
 * sample — cheap to re-run, catches regressions that render every RPC
 * unreachable.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import { arbitraryCallFor } from "../../arbitraries/rpc.js";
import { isRequestFrame, isResponseFrame } from "../../codec.js";
import { makeTestClient } from "../../test-client.js";
import { registerTestAgent } from "../../agent-registration.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  registerProperty,
} from "../_shared/registry.js";
import { AgentsList, ContactsList } from "../../../identity/methods.js";
import { Connect } from "../../../network/methods.js";
import { ConversationsList } from "../../../task/methods.js";

const CATEGORY = "schema-conformance" as const;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CAPTURE_CAPACITY = 64;

const COVERAGE_SAMPLE = [
  Connect.name,
  AgentsList.name,
  ConversationsList.name,
  ContactsList.name,
] as const;

export function registerRpcMapCoverage(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    "rpc-map-coverage",
    "a representative sample of method names reaches a real-server response",
    Effect.gen(function* () {
      for (const method of COVERAGE_SAMPLE) {
        const callArb = arbitraryCallFor(method);
        const [sampled] = fc.sample(callArb, { numRuns: 1, seed: ctx.seed });
        if (sampled === undefined) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "rpc-map-coverage",
              reason: `failed to sample call for ${method}`,
            }),
          );
        }
        const reached = yield* Effect.scoped(
          Effect.gen(function* () {
            const agent = yield* registerTestAgent({
              baseUrl: ctx.realServer.baseUrl,
              name: "cov",
            });
            const client = yield* makeTestClient({
              serverUrl: ctx.realServer.wsUrl,
              agentKey: agent.apiKey,
              agentId: agent.agentId,
              defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
              captureCapacity: DEFAULT_CAPTURE_CAPACITY,
            });
            // Exclude handshake frames so "reached" can't be satisfied
            // by the auto-connect reply — every method must produce its
            // OWN response with a matching request id.
            const handshakeEnd = (yield* client.snapshot).length;
            yield* client
              .sendRpc(sampled.definition, sampled.params)
              .pipe(Effect.either);
            const snap = (yield* client.snapshot).slice(handshakeEnd);
            const outbound = snap.find(
              (s) =>
                s.kind === "outbound" &&
                s.frame !== null &&
                isRequestFrame(s.frame) &&
                s.frame.method === sampled.method,
            );
            if (
              outbound?.frame === null ||
              outbound?.frame === undefined ||
              !isRequestFrame(outbound.frame)
            ) {
              return false;
            }
            const expectedId = outbound.frame.id;
            return snap.some(
              (s) =>
                s.kind === "inbound" &&
                s.frame !== null &&
                isResponseFrame(s.frame) &&
                s.frame.id === expectedId,
            );
          }),
        ).pipe(Effect.orElseSucceed(() => false));
        if (!reached) {
          return yield* Effect.fail(
            new PropertyInvariantViolation({
              category: CATEGORY,
              name: "rpc-map-coverage",
              reason: `method ${method} produced no observable response`,
            }),
          );
        }
      }
    }),
  );
}
