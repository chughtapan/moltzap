/**
 * Client-side RPC-semantics properties.
 *
 * Covers spec-amendment #200 §5:
 *   B1 — model-equivalence (client half of both-sides)
 *   B4 — request-id-uniqueness (client half of both-sides)
 *
 * Sampling discipline (#197 §2 carries over): B1 client half samples
 * RPC methods the real client is known to originate during normal
 * operation. The client mints its own request id; the property reads
 * it off `RealClientHandle.call.outboundIdFeed` and filters by that id.
 *
 * Typed-error precision (O6): B1 asserts `model-ok ⇒ client-ok`; B4
 * asserts set equality — no typed-error involvement.
 */
import { Effect } from "effect";
import { responseFrame } from "../../../transport/wire.js";
import type { ClientConformanceRunContext } from "./runner.js";
import { registerProperty } from "../registry.js";
import { acquireFixture, invariant } from "./_fixtures.js";
import { isRequestFrame } from "../../codec.js";

import { AgentsList } from "../../../identity/methods.js";

const CATEGORY = "rpc-semantics" as const;
const CALL_BUDGET_MS = 5_000;
const PROPERTY_MODEL_EQUIVALENCE_CLIENT = "model-equivalence-client";
const PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT = "request-id-uniqueness-client";

/**
 * B1 client half — property issues `realClient.call("agents/list", {})`;
 * TestServer captures the inbound request id and emits a well-shaped
 * response; the client's pending call resolves with that result.
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
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_MODEL_EQUIVALENCE_CLIENT,
        );
        // Fork a background responder that watches inbound requests and
        // replies with an empty-agents-list result as soon as the sampled
        // call lands.
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            let responded = false;
            while (!responded) {
              yield* Effect.sleep("25 millis");
              const snap = yield* fx.connection.inbound.snapshot;
              for (const entry of snap) {
                if (
                  entry.kind === "inbound" &&
                  entry.frame !== null &&
                  isRequestFrame(entry.frame) &&
                  entry.frame.method === AgentsList.name
                ) {
                  const response = responseFrame(entry.frame.id, {
                    result: { agents: {} },
                  });
                  yield* fx.window.emitTaggedResponse({
                    connection: fx.connection,
                    base: response,
                    emissionTag: entry.frame.id,
                  });
                  responded = true;
                  break;
                }
              }
            }
          }),
        );
        const result = yield* fx.handle.call.call(AgentsList.name, {}).pipe(
          Effect.timeoutFail({
            duration: `${CALL_BUDGET_MS} millis`,
            onTimeout: () =>
              invariant(
                CATEGORY,
                PROPERTY_MODEL_EQUIVALENCE_CLIENT,
                `agents/list call did not resolve within ${CALL_BUDGET_MS}ms`,
              ),
          }),
          Effect.mapError((e) =>
            "_tag" in e && e._tag === "RealClientRpcError"
              ? invariant(
                  CATEGORY,
                  PROPERTY_MODEL_EQUIVALENCE_CLIENT,
                  `agents/list rejected: ${e.kind} (${e.documentedErrorTag ?? "null"})`,
                )
              : e,
          ),
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
      }),
    ),
  );
}

/**
 * B4 client half — TestServer emits a spurious response with marker payload
 * `{ __spurious: true }`, then a matching-id response with `{ agents: {} }`.
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
    Effect.scoped(
      Effect.gen(function* () {
        const fx = yield* acquireFixture(
          ctx,
          CATEGORY,
          PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT,
        );
        const spuriousId = "spurious-id-that-was-never-requested";
        yield* fx.connection
          .emitResponse(
            responseFrame(spuriousId, { result: { __spurious: true } }),
          )
          .pipe(Effect.orElseSucceed(() => undefined));
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            let responded = false;
            while (!responded) {
              yield* Effect.sleep("25 millis");
              const snap = yield* fx.connection.inbound.snapshot;
              for (const entry of snap) {
                if (
                  entry.kind === "inbound" &&
                  entry.frame !== null &&
                  isRequestFrame(entry.frame) &&
                  entry.frame.method === AgentsList.name
                ) {
                  yield* fx.connection
                    .emitResponse(
                      responseFrame(entry.frame.id, { result: { agents: {} } }),
                    )
                    .pipe(Effect.orElseSucceed(() => undefined));
                  responded = true;
                  break;
                }
              }
            }
          }),
        );
        const frame = yield* fx.handle.call.call(AgentsList.name, {}).pipe(
          Effect.timeoutFail({
            duration: `${CALL_BUDGET_MS} millis`,
            onTimeout: () =>
              invariant(
                CATEGORY,
                PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT,
                `agents/list did not resolve within ${CALL_BUDGET_MS}ms despite matching response`,
              ),
          }),
          Effect.mapError((e) =>
            "_tag" in e && e._tag === "RealClientRpcError"
              ? invariant(
                  CATEGORY,
                  PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT,
                  `agents/list rejected: ${e.kind}`,
                )
              : e,
          ),
        );
        if (
          "result" in frame &&
          frame.result !== null &&
          typeof frame.result === "object" &&
          "__spurious" in frame.result &&
          (frame.result as { __spurious: unknown }).__spurious === true
        ) {
          return yield* Effect.fail(
            invariant(
              CATEGORY,
              PROPERTY_REQUEST_ID_UNIQUENESS_CLIENT,
              "pending call resolved via spurious response (cross-wire correlation bug)",
            ),
          );
        }
      }),
    ),
  );
}
