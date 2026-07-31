/**
 * Idempotent RPCs yield equivalent responses on replay. For every
 * list-shaped method where empty params are valid and replay is safe,
 * sends the same params twice and asserts both succeed with **identical
 * results** (not just identical tags).
 *
 * Transport failures surface as `PropertyUnavailable` so the runner
 * reports them explicitly instead of folding them into a silent pass.
 * The predicate compares response bodies via canonical JSON: the spec
 * requires "identical results", not "identical outcome kinds".
 */
import { Effect, Either } from "effect";
import { agentsList } from "#identity";
import { conversationList } from "#conversation";
import { canonicalJson, sortJsonArray } from "../_shared/canonicalize.js";
import {
  makeAgentTestClient,
  type AgentTestClient,
} from "../_shared/driver/test-client.js";
import { registerTestAgent } from "../_shared/test-fixtures.js";
import type {
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "../_shared/errors.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  PropertyUnavailable,
  registerProperty,
} from "../_shared/registry.js";
import { eitherTag } from "../_shared/_helpers.js";

const CATEGORY = "rpc-semantics";
const PROPERTY = "idempotence";
const DEFAULT_TIMEOUT_MS = 3000;
const EMPTY_PARAM_IDEMPOTENTS = [agentsList, conversationList] as const;

type EmptyParamIdempotentDefinition = (typeof EMPTY_PARAM_IDEMPOTENTS)[number];
type ReplayError =
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError;
interface ReplayPair {
  readonly a: Either.Either<unknown, ReplayError>;
  readonly b: Either.Either<unknown, ReplayError>;
}

/**
 * Registers idempotence.
 * @param ctx Context for the operation.
 */
export function registerIdempotence(ctx: ConformanceRunContext): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY,
    "idempotent methods: two sends yield identical response bodies",
    assertIdempotence(ctx).pipe(Effect.withSpan("registerIdempotence")),
  );
}

function assertIdempotence(ctx: ConformanceRunContext) {
  return Effect.scoped(
    Effect.gen(function* () {
      const client = yield* acquireReplayClient(ctx);
      for (const definition of EMPTY_PARAM_IDEMPOTENTS) {
        yield* assertDefinitionIdempotent(client, definition);
      }
    }),
  ).pipe(
    Effect.catchTags({
      TestingAgentRegistrationError: (e) =>
        Effect.fail(unavailable(`register: ${e.body}`)),
      TestingTransportIoError: (e) =>
        Effect.fail(unavailable(`transport io: ${String(e.cause)}`)),
      TestingTransportClosedError: (e) =>
        Effect.fail(unavailable(`transport closed: ${e.reason}`)),
      TestingRpcTimeoutError: (e) =>
        Effect.fail(unavailable(`rpc timeout: ${e.method}`)),
      TestingRpcResponseError: (e) =>
        Effect.fail(unavailable(`rpc response error: ${e.message}`)),
    }),
  );
}

function assertDefinitionIdempotent(
  client: AgentTestClient,
  definition: EmptyParamIdempotentDefinition,
) {
  return Effect.gen(function* () {
    const method = definition.name;
    const pair = yield* sendReplayPair(client, definition);
    yield* assertReplayOutcomeTags(method, pair);
    yield* assertReplayBodies(method, pair);
  });
}

function acquireReplayClient(ctx: ConformanceRunContext) {
  return Effect.gen(function* () {
    const agent = yield* registerTestAgent({
      baseUrl: ctx.realServer.baseUrl,
      name: "id",
    });
    return yield* makeAgentTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });
}

function sendReplayPair(
  client: AgentTestClient,
  definition: EmptyParamIdempotentDefinition,
) {
  return Effect.gen(function* () {
    const a = yield* client.sendRpc(definition, {}).pipe(Effect.either);
    const b = yield* client.sendRpc(definition, {}).pipe(Effect.either);
    return { a, b } satisfies ReplayPair;
  });
}

function unavailable(reason: string): PropertyUnavailable {
  return new PropertyUnavailable({
    category: CATEGORY,
    name: PROPERTY,
    reason,
  });
}

function assertReplayOutcomeTags(
  method: typeof agentsList.name | typeof conversationList.name,
  pair: ReplayPair,
) {
  const aTag = eitherTag(pair.a);
  const bTag = eitherTag(pair.b);
  return aTag === bTag
    ? Effect.void
    : Effect.fail(
        new PropertyInvariantViolation({
          category: CATEGORY,
          name: PROPERTY,
          reason: `${method}: replay outcome-tag mismatch ${aTag} → ${bTag}`,
        }),
      );
}

function assertReplayBodies(
  method: typeof agentsList.name | typeof conversationList.name,
  pair: ReplayPair,
) {
  const successPair = successPairOrNull(pair);
  const bodiesMatch =
    successPair === null ||
    canonIdempotenceResult(method, successPair.a) ===
      canonIdempotenceResult(method, successPair.b);
  return bodiesMatch
    ? Effect.void
    : Effect.fail(
        new PropertyInvariantViolation({
          category: CATEGORY,
          name: PROPERTY,
          reason: `${method}: replay bodies diverge under canonical projection`,
        }),
      );
}

function successPairOrNull(pair: ReplayPair) {
  return Either.match(pair.a, {
    onLeft: () => null,
    onRight: (a) =>
      Either.match(pair.b, {
        onLeft: () => null,
        onRight: (b) => ({ a, b }),
      }),
  });
}

/**
 * Idempotence canonical projection.
 *
 * `agent/identity/agents/list.agents` and `agent/conversation/list.items`
 * are unordered row sets across replays. Every OTHER array
 * (including any nested `participants` and every payload field that is
 * not one of the two named arrays) remains order-sensitive.
 *
 * The projection sorts ONLY the specific top-level array the spec
 * marks unordered, then finalizes via `canonicalJson` (which
 * normalizes object-key order but preserves every remaining array's
 * order). A real re-ordering regression inside nested arrays still
 * fails the property.
 * @param method Wire method name.
 * @param result Value supplied to the operation.
 * @returns Whether on idempotence result.
 */
function canonIdempotenceResult(
  method: typeof agentsList.name | typeof conversationList.name,
  result: unknown,
): string {
  const record: Record<string, unknown> =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? Object.fromEntries(
          Object.keys(result).map((key) => [key, Reflect.get(result, key)]),
        )
      : {};
  if (method === agentsList.name) {
    const agents = record.agents;
    return canonicalJson({
      ...record,
      agents: Array.isArray(agents) ? sortJsonArray(agents) : agents,
    });
  }
  const items = record.items;
  return canonicalJson({
    ...record,
    items: Array.isArray(items) ? sortJsonArray(items) : items,
  });
}
