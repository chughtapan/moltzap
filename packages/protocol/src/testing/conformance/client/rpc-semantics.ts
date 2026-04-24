/**
 * Client-side RPC-semantics properties.
 *
 * Covers spec-amendment #200 §5:
 *   B1 — model-equivalence (client half of both-sides)
 *   B4 — request-id-uniqueness (client half of both-sides)
 *
 * Sampling discipline (#197 §2 carries over): B1 client half samples via
 * `arbitraryConfidentCall()` (derived from `applyCall` at module load,
 * not a hand-list). `numRuns ≥ max(10, 2K)`.
 *
 * Handshake-noise guard (O7): every observation filters by the sampled
 * call's request ID (minted by the real client's own id generator, read
 * off `RealClientHandle.call.outboundIdFeed`). Auto-connect hellos
 * never match a sampled ID.
 *
 * Typed-error precision (O6): B1 client half asserts `model-ok ⇒
 * client-ok`; when both sides' outcome is error, both error-tags need
 * not match exactly (model-imprecision is not a protocol violation).
 * B4 asserts set equality — no typed error involvement.
 */
import type { ClientConformanceRunContext } from "./runner.js";

/**
 * B1 client half — TestServer scripts a response to a sampled RPC the
 * real client just issued (`realClient.call(method, params)`). The
 * reference model (`applyCall`) predicts ok/error per
 * `arbitraryConfidentCall`; if model predicts ok, the client's awaited
 * promise must resolve to ok. If model predicts error, the response
 * is `arbitrary-broken` and the client's rejection is logged (not
 * asserted — conditional oracle per architect #197).
 *
 * Predicate (conjunction):
 *   - `call.outboundIdFeed` includes the sampled id
 *   - TestServer observes inbound request with that id
 *   - TestServer emits tagged response with matching id
 *   - if model._tag === "ok": real client's promise resolves ok
 *   - if model._tag === "error": no assertion (conditional)
 *
 * Discriminates: a client that routes the response to the wrong
 * pending call (id-to-deferred mis-match) fails.
 */
export function registerModelEquivalenceClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}

/**
 * B4 client half — TestServer emits a response with id X to the real
 * client's outstanding call on id X; the client resolves that call
 * exactly once. TestServer also emits a spurious response with id Y
 * (never requested); client must drop it OR surface a documented
 * protocol error (never misroute to another pending call).
 *
 * Predicate (conjunction):
 *   - real client's pending-call map has exactly one resolution per
 *     emitted matching response
 *   - no call on id ≠ Y is resolved by the spurious response
 *   - spurious response results in either silent drop OR a single
 *     documented protocol-error surface
 *
 * Discriminates: a client that resolves pending call P with a
 * response frame whose id belongs to some other call fails.
 */
export function registerRequestIdUniquenessClient(
  ctx: ClientConformanceRunContext,
): void {
  throw new Error("not implemented");
}
