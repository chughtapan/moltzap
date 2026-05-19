/**
 * @file Auto-provision dispatcher — Spec F G6.
 *
 * Stub signature only. Impl-staff fills body (see
 * `packages/protocol/docs/architecture/11-typed-dispatcher.md → §5
 * Dispatcher implementation`).
 *
 * The dispatcher receives:
 *   1. an inbound request frame already validated by the wire decoders
 *      (`decodeServerInbound` / `decodeClientInbound`);
 *   2. the per-kind handler table (immutable, value-passed at
 *      construction);
 *   3. the `CapabilityProviderTable` (from the factory config);
 *   4. the per-request `Ctx` (e.g., `DispatchContext` server-side).
 *
 * For each inbound frame:
 *   - look up the slot by `frame.method`. Missing → wire
 *     `MethodNotFound` (-32601);
 *   - if the slot is OPTIONAL and the handler-table value is absent,
 *     synthesize the fail-CLOSED default response (per
 *     `defaults.ts → SlotDisposition`);
 *   - read `slot.definition.capabilities` (Shape B per-definition
 *     metadata). For each `CapabilityDescriptor`, look up the
 *     `CapabilityProviderTable[tag._tag]` entry, call it with
 *     `argsOf(params, ctx)`, and thread
 *     `Effect.provideServiceEffect(tag, providerEffect)` over the
 *     handler effect;
 *   - run the handler effect, map outcome to a wire `ResponseFrame`.
 *
 * Outbound calls / notifications go through an internalized originator
 * (formerly `makeJsonRpcClient`'s body, now private helpers consumed by
 * the three factories).
 */
import { Effect } from "effect";
import type {
  ServerConnection,
  AgentClientConnection,
  TaskMasterConnection,
  ServerConnectionConfig,
  AgentClientConnectionConfig,
  TaskMasterConnectionConfig,
} from "./connection.js";
import type { Context, Scope } from "effect";

/**
 * Build the server-side dispatcher. STUB.
 *
 * The result is a `ServerConnection`; the runtime body wires the
 * inbound frame loop (per the file header) plus the outbound originator
 * surface. Impl-staff fills the body.
 */
export function buildServerDispatcher<
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
>(
  config: ServerConnectionConfig<Ctx, Caps>,
): Effect.Effect<ServerConnection, never, Scope.Scope> {
  return Effect.dieMessage(
    `buildServerDispatcher(idPrefix=${config.idPrefix}): stub — Spec F impl-staff body pending`,
  );
}

/**
 * Build the agent-client dispatcher. STUB. Body wires the originator
 * only (no inbound handler dispatch — catalog is empty).
 */
export function buildAgentClientDispatcher<
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
>(
  config: AgentClientConnectionConfig<Ctx, Caps>,
): Effect.Effect<AgentClientConnection, never, Scope.Scope> {
  return Effect.dieMessage(
    `buildAgentClientDispatcher(idPrefix=${config.idPrefix}): stub — Spec F impl-staff body pending`,
  );
}

/**
 * Build the TM dispatcher. STUB. Body wires both the inbound dispatch
 * loop (against `taskCallbackMethods`) and the outbound originator
 * (against `rpcMethods`).
 */
export function buildTaskMasterDispatcher<
  Ctx,
  Caps extends Context.Tag<unknown, unknown>,
>(
  config: TaskMasterConnectionConfig<Ctx, Caps>,
): Effect.Effect<TaskMasterConnection, never, Scope.Scope> {
  return Effect.dieMessage(
    `buildTaskMasterDispatcher(idPrefix=${config.idPrefix}): stub — Spec F impl-staff body pending`,
  );
}
