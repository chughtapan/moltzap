/**
 * Schema-exhaustive fuzz — for every wire method, draws arbitrary
 * valid params, sends through a real TestClient, and asserts the server
 * survives. Reuses a single TestClient across the whole iteration so
 * the suite doesn't open 40+ sockets in serial; each method runs behind
 * the same post-call liveness probe.
 *
 * Iterates every wire method. Failure on any single method halts
 * the property with a `PropertyInvariantViolation` naming the offender,
 * so artifacts are actionable.
 */
import * as fc from "fast-check";
import { Effect } from "effect";
import {
  allRpcMethods,
  arbitraryCallFor,
  type ArbitraryRpcCall,
} from "../../arbitraries/rpc.js";
import { AgentsList } from "../../../identity/index.js";
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
import { leftOrNull } from "../_shared/_helpers.js";

const CATEGORY = "boundary" as const;
const PROPERTY = "schema-exhaustive-fuzz";
const DEFAULT_TIMEOUT_MS = 3000;
const FUZZ_CAPTURE_CAPACITY_PER_METHOD = 4;

const invariant = (reason: string): PropertyInvariantViolation =>
  new PropertyInvariantViolation({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });

export function registerSchemaExhaustiveFuzz(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "every wire method drawn → server survives & stays responsive",
    assertSchemaExhaustiveFuzz(ctx).pipe(
      Effect.withSpan("registerSchemaExhaustiveFuzz"),
    ),
  );
}

function assertSchemaExhaustiveFuzz(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* acquireFuzzClient(ctx);
      const samplesPerMethod = ctx.opts.numRuns ?? 1;
      for (const method of allRpcMethods) {
        const samples = yield* sampleMethodCalls(
          method,
          samplesPerMethod,
          ctx.seed,
        );
        for (const sampled of samples) {
          yield* sendFuzzCallAndProbe(client, sampled);
        }
      }
    }),
  );
}

function acquireFuzzClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "fuzz",
    }).pipe(Effect.mapError((e) => invariant(`register agent: ${e.body}`)));
    return yield* makeTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: allRpcMethods.length * FUZZ_CAPTURE_CAPACITY_PER_METHOD,
    }).pipe(Effect.mapError((e) => invariant(`client acquire: ${String(e)}`)));
  });
}

type FuzzMethod = (typeof allRpcMethods)[number];

function sampleMethodCalls(
  method: FuzzMethod,
  samplesPerMethod: number,
  seed: number,
) {
  const samples = fc.sample(arbitraryCallFor(method), {
    numRuns: samplesPerMethod,
    seed,
  });
  return samples.length === 0
    ? Effect.fail(invariant(`failed to sample call for ${method}`))
    : Effect.succeed(samples);
}

function sendFuzzCallAndProbe(client: TestClient, sampled: ArbitraryRpcCall) {
  return Effect.gen(function* () {
    yield* client
      .sendRpc(sampled.definition, sampled.params)
      .pipe(Effect.either);
    const post = yield* client.sendRpc(AgentsList, {}).pipe(Effect.either);
    const postFailure = leftOrNull(post);
    if (postFailure !== null) {
      return yield* Effect.fail(
        invariant(
          `server became unresponsive after ${sampled.method} (post-call ${postFailure._tag})`,
        ),
      );
    }
  });
}
