/**
 * Client-side RPC-semantics properties:
 *   model-equivalence-client — response-correlation: a well-shaped
 *     response on the client's own request id resolves its pending call.
 *   request-id-uniqueness — client half of the both-sides property whose
 *     server half lives in `transport/request-id-uniqueness.ts`.
 *
 * Both drive `agents/list` through the real client. The client mints its
 * own request id; each property reads that id off the captured outbound
 * frame and scripts the TestServer's reply around it.
 *
 * `model-equivalence-client` asserts the call resolves with a `result`
 * (correct id-to-deferred routing). `request-id-uniqueness` asserts a
 * spurious-id response never resolves a pending call while a matching-id
 * one does.
 */
import { Effect, type Scope } from "effect";
import type { JsonRpcId } from "../../../transport/index.js";
import { responseFrame } from "../../index.js";
import type { ClientConformanceRunContext } from "./runner.js";
import { registerProperty } from "../_shared/registry.js";
import type { PropertyFailure } from "../_shared/registry.js";
import { acquireFixture, invariant, type ClientFixture } from "./_fixtures.js";
import { isRequestFrame } from "../_shared/frame-mutator.js";
import type { CapturedFrame } from "../_shared/captures.js";

import { AgentsList } from "../../../identity/index.js";

const CATEGORY = "rpc-semantics" as const;
const CALL_BUDGET_MS = 5_000;
const PROPERTY_MODEL_EQUIVALENCE_CLIENT = "model-equivalence-client";
const PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT = "request-id-uniqueness-client";

/**
 * Response-correlation property — issues `realClient.call("agents/list",
 * {})`; the TestServer captures the inbound request id and emits a
 * well-shaped response carrying that id; the client's pending call must
 * resolve with that result.
 *
 * Discriminates: a client that routes the response to the wrong
 * pending call (id-to-deferred mis-match) fails — the promise will
 * never resolve within the budget.
 */
export function registerModelEquivalenceClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_MODEL_EQUIVALENCE_CLIENT,
    "scripted response to sampled RPC resolves the real client's pending call",
    Effect.scoped(runModelEquivalenceClient(ctx)),
  );
}

function runModelEquivalenceClient(
  ctx: ClientConformanceRunContext,
): Effect.Effect<void, PropertyFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const fx = yield* acquireFixture(
      ctx,
      CATEGORY,
      PROPERTY_MODEL_EQUIVALENCE_CLIENT,
    );
    yield* forkAgentsListResponder(fx, emitTaggedAgentsListResponse);
    const result = yield* callAgentsList(
      fx,
      PROPERTY_MODEL_EQUIVALENCE_CLIENT,
      `agents/list call did not resolve within ${CALL_BUDGET_MS}ms`,
      (error) =>
        `agents/list rejected: ${error.kind} (${error.documentedErrorTag ?? "null"})`,
    );
    if (!("result" in result)) {
      return yield* Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_MODEL_EQUIVALENCE_CLIENT,
          "real client surfaced non-response frame",
        ),
      );
    }
  }).pipe(Effect.withSpan("registerModelEquivalenceClient"));
}

/**
 * Client half of `request-id-uniqueness` — TestServer emits a spurious
 * response with marker payload `{ __spurious: true }`, then a matching-id
 * response with `{ agents: [] }`.
 * A correctly correlating client returns the matching payload.
 */
export function registerRequestIdUniquenessClient(
  ctx: ClientConformanceRunContext,
): void {
  registerProperty(
    ctx,
    CATEGORY,
    PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT,
    "spurious response ids don't resolve pending calls; matching ids do",
    Effect.scoped(runRequestIdUniquenessClient(ctx)),
  );
}

function runRequestIdUniquenessClient(
  ctx: ClientConformanceRunContext,
): Effect.Effect<void, PropertyFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const fx = yield* acquireFixture(
      ctx,
      CATEGORY,
      PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT,
    );
    yield* emitSpuriousAgentsListResponse(fx);
    yield* forkAgentsListResponder(fx, emitPlainAgentsListResponse);
    const frame = yield* callAgentsList(
      fx,
      PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT,
      `agents/list did not resolve within ${CALL_BUDGET_MS}ms despite matching response`,
      (error) => `agents/list rejected: ${error.kind}`,
    );
    if (isSpuriousResult(frame)) {
      return yield* Effect.fail(
        invariant(
          CATEGORY,
          PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT,
          "pending call resolved via spurious response (cross-wire correlation bug)",
        ),
      );
    }
  }).pipe(Effect.withSpan("registerRequestIdUniquenessClient"));
}

type AgentsListResponseEmitter = (
  fx: ClientFixture,
  id: JsonRpcId,
) => Effect.Effect<void>;

function forkAgentsListResponder(
  fx: ClientFixture,
  emit: AgentsListResponseEmitter,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.forkScoped(respondToNextAgentsListRequest(fx, emit)).pipe(
    Effect.asVoid,
  );
}

function respondToNextAgentsListRequest(
  fx: ClientFixture,
  emit: AgentsListResponseEmitter,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("25 millis");
      const requestId = yield* findAgentsListRequestId(fx);
      if (requestId !== null) {
        yield* emit(fx, requestId);
        return;
      }
    }
  });
}

function findAgentsListRequestId(
  fx: ClientFixture,
): Effect.Effect<JsonRpcId | null> {
  return Effect.map(fx.connection.inbound.snapshot, findAgentsListIdInSnapshot);
}

function findAgentsListIdInSnapshot(
  snapshot: ReadonlyArray<CapturedFrame>,
): JsonRpcId | null {
  for (const entry of snapshot) {
    if (
      entry.kind === "inbound" &&
      entry.frame !== null &&
      isRequestFrame(entry.frame) &&
      entry.frame.method === AgentsList.name
    ) {
      return entry.frame.id;
    }
  }
  return null;
}

function emitTaggedAgentsListResponse(
  fx: ClientFixture,
  id: JsonRpcId,
): Effect.Effect<void> {
  const response = responseFrame(id, { result: { agents: [] } });
  return fx.window
    .emitTaggedResponse({
      connection: fx.connection,
      base: response,
      emissionTag: id,
    })
    .pipe(Effect.asVoid);
}

function emitPlainAgentsListResponse(
  fx: ClientFixture,
  id: JsonRpcId,
): Effect.Effect<void> {
  return fx.connection
    .emitResponse(responseFrame(id, { result: { agents: [] } }))
    .pipe(Effect.orElseSucceed(() => undefined));
}

// A numeric id no pending call ever minted (the native engine's ids start near
// zero). The JSON-RPC wire id is numeric — `RpcMessage.RequestId` parses it with
// `BigInt(id)` — so a stray response still rides a well-formed id; the "spurious"
// part is that nothing is pending for it, which the client must drop.
const SPURIOUS_RESPONSE_ID = "999999999999" as JsonRpcId;

function emitSpuriousAgentsListResponse(
  fx: ClientFixture,
): Effect.Effect<void> {
  return fx.connection
    .emitResponse(
      responseFrame(SPURIOUS_RESPONSE_ID, {
        result: { __spurious: true },
      }),
    )
    .pipe(Effect.orElseSucceed(() => undefined));
}

function callAgentsList(
  fx: ClientFixture,
  propertyName: string,
  timeoutMessage: string,
  rejectionMessage: (error: {
    readonly kind: string;
    readonly documentedErrorTag?: string | null;
  }) => string,
) {
  return fx.handle.call.call(AgentsList.name, {}).pipe(
    Effect.timeoutFail({
      duration: `${CALL_BUDGET_MS} millis`,
      onTimeout: () => invariant(CATEGORY, propertyName, timeoutMessage),
    }),
    Effect.mapError((error) =>
      isRealClientRpcError(error)
        ? invariant(CATEGORY, propertyName, rejectionMessage(error))
        : error,
    ),
  );
}

function isRealClientRpcError(error: unknown): error is {
  readonly _tag: "RealClientRpcError";
  readonly kind: string;
  readonly documentedErrorTag?: string | null;
} {
  if (!isObject(error)) return false;
  return hasRealClientRpcErrorTag(error) && hasStringKind(error);
}

function hasRealClientRpcErrorTag(
  error: Readonly<Record<string, unknown>>,
): boolean {
  return error._tag === "RealClientRpcError";
}

function hasStringKind(error: Readonly<Record<string, unknown>>): boolean {
  return typeof error.kind === "string";
}

function isSpuriousResult(frame: unknown): boolean {
  if (!hasResult(frame)) return false;
  const result = frame.result;
  return isObject(result) && result.__spurious === true;
}

function hasResult(frame: unknown): frame is { readonly result: unknown } {
  return frame !== null && typeof frame === "object" && "result" in frame;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object";
}
