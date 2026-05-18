/**
 * In-process registry of app-TM handlers.
 *
 * Phase 9b consumer-migration (sub-issue #460 round 3 R14): the
 * `tm:app:&lt;id>` `EndpointAddressKind` exists for default DM / group TMs
 * and (in a future arena cutover) any in-process TM that does not
 * authenticate as an agent. `network.send` dispatches `app`-kind
 * addresses through this registry — the handler runs on the server's
 * Effect runtime, no WebSocket round-trip.
 *
 * The default TMs' stable addresses are minted at module load via
 * deterministic UUIDs so every server boot binds the same address. Apps
 * that want to register a custom in-process TM call {@link register}
 * with an arbitrary `tm:app:&lt;uuid>` address.
 */
import { Effect, HashMap, Ref } from "effect";
import {
  endpointAddress as brandEndpointAddress,
  type EndpointAddress,
} from "@moltzap/protocol/network";
import type { OpaquePayload } from "./network-send.js";

/**
 * Stable `EndpointAddress` for the default DM TM. Used by
 * `conversations/create` when the caller does not own a TM and the
 * conversation type is `dm`. Phase 9b consumer-migration (sub-issue
 * #460 round 3 R12 + R14): every conversation now belongs to a task
 * with a registered TM; non-app DMs route through this stable address.
 */
export const DEFAULT_DM_TM_ADDRESS: EndpointAddress = brandEndpointAddress(
  "tm:app:00000000-0000-4d11-8000-000000000d11",
);

/**
 * Stable `EndpointAddress` for the default group TM. Same role as
 * {@link DEFAULT_DM_TM_ADDRESS} for `type: "group"` conversations.
 */
export const DEFAULT_GROUP_TM_ADDRESS: EndpointAddress = brandEndpointAddress(
  "tm:app:00000000-0000-4691-8000-000000000691",
);

/**
 * Pick the default TM endpoint for a conversation type. The DM/group
 * split is preserved as separate addresses (rather than one shared
 * default) so future differentiation (display semantics, rate limits)
 * can land without rewiring `tasks.tm_endpoint_address` for existing
 * rows.
 */
export function defaultTmAddressForType(type: "dm" | "group"): EndpointAddress {
  switch (type) {
    case "dm":
      return DEFAULT_DM_TM_ADDRESS;
    case "group":
      return DEFAULT_GROUP_TM_ADDRESS;
    default: {
      const _absurd: never = type;
      return _absurd;
    }
  }
}

/**
 * In-process app-TM handler. Receives the opaque wire frame
 * `network.send` would have written to a remote TM and runs on the
 * server's Effect runtime. Phase 9b's default handlers are no-op
 * observers (the existing `MessageService.send` insert+broadcast flow
 * runs regardless); future Phase 11+ arena cutover may wire richer
 * TM-driven storage authority.
 *
 * The error channel is `never`: the handler must absorb its own
 * failures (log + drop) rather than propagating them to the
 * `messages/send` caller. `network.send`'s caller-facing error tags
 * cover delivery liveness only; application-level handler errors are
 * the TM's own concern.
 */
export type AppTmHandler = (
  payload: OpaquePayload,
) => Effect.Effect<void, never>;

/**
 * Map-backed registry. `Ref` rather than a plain `Map` so the resolver
 * stays consistent under concurrent boot-time `register` calls (none
 * today, but the contract holds for future). Lookups are read-only
 * snapshots.
 */
export class AppTmRegistry {
  static readonly make: Effect.Effect<AppTmRegistry> = Effect.map(
    Ref.make<HashMap.HashMap<EndpointAddress, AppTmHandler>>(HashMap.empty()),
    (state) => new AppTmRegistry(state),
  );

  private constructor(
    private readonly state: Ref.Ref<
      HashMap.HashMap<EndpointAddress, AppTmHandler>
    >,
  ) {}

  register(
    address: EndpointAddress,
    handler: AppTmHandler,
  ): Effect.Effect<void> {
    return Ref.update(this.state, (m) => HashMap.set(m, address, handler));
  }

  /**
   * Look up the handler for an address. Returns `undefined` when no
   * handler is registered — the caller (`NetworkSendService`) maps
   * that to `RecipientNotResolved` so the failure semantics match the
   * `tm:agent:&lt;id>` path's "agent has no live connection" branch.
   */
  resolve(address: EndpointAddress): Effect.Effect<AppTmHandler | undefined> {
    return Effect.map(Ref.get(this.state), (m) => {
      const opt = HashMap.get(m, address);
      return opt._tag === "Some" ? opt.value : undefined;
    });
  }
}
