import type { HarnessClientService } from "@moltzap/client/harness-client";
import type { MoltZapChannelCore } from "@moltzap/client/channel-base";
import { Deferred, Effect } from "effect";

interface ClosableGatewayService {
  readonly close: () => void;
}

interface LegacyGatewayBinding<Service> {
  readonly core: MoltZapChannelCore;
  readonly service: Service;
}

/** One caller-owned Harness client with the adapter's private drain signal. */
export interface ActiveHarnessClient {
  readonly client: HarnessClientService;
  readonly stopSignal: Deferred.Deferred<undefined>;
}

/**
 * Stops every adapter binding for an account without closing a Harness client.
 * @param activeClients Legacy services owned by the adapter.
 * @param activeHarnessClients Harness drains owned by the adapter.
 * @param accountId Account whose active binding is stopped.
 * @returns A lazy stop operation for the selected account.
 */
export function stopActiveGatewayAccount<
  Service extends ClosableGatewayService,
>(
  activeClients: Map<string, Service>,
  activeHarnessClients: Map<string, ActiveHarnessClient>,
  accountId: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const harness = activeHarnessClients.get(accountId);
    if (harness !== undefined) {
      activeHarnessClients.delete(accountId);
      yield* Deferred.succeed(harness.stopSignal, undefined);
    }
    const service = activeClients.get(accountId);
    if (service !== undefined) {
      activeClients.delete(accountId);
      yield* Effect.sync(() => {
        service.close();
      });
    }
  }).pipe(Effect.withSpan("stopActiveGatewayAccount"));
}

/**
 * Removes a completed drain only when it is still the active generation.
 * @param activeHarnessClients Harness drains owned by the adapter.
 * @param accountId Account whose drain completed.
 * @param active Completed generation.
 * @returns A lazy generation-checked removal.
 */
export function finishHarnessClient(
  activeHarnessClients: Map<string, ActiveHarnessClient>,
  accountId: string,
  active: ActiveHarnessClient,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (activeHarnessClients.get(accountId) === active) {
      activeHarnessClients.delete(accountId);
    }
  });
}

const removeLegacyClientIfActive = <Service>(
  activeClients: Map<string, Service>,
  accountId: string,
  service: Service,
): Effect.Effect<void> =>
  Effect.sync(() => {
    if (activeClients.get(accountId) === service) {
      activeClients.delete(accountId);
    }
  });

/**
 * Disconnects one legacy generation without removing a newer replacement.
 * @param binding Core and service belonging to one generation.
 * @param activeClients Active legacy service by account.
 * @param accountId Account owned by the generation.
 * @returns A lazy disconnect operation.
 */
export function disconnectLegacyGateway<Service>(
  binding: LegacyGatewayBinding<Service>,
  activeClients: Map<string, Service>,
  accountId: string,
): Effect.Effect<void> {
  return binding.core
    .disconnect()
    .pipe(
      Effect.ensuring(
        removeLegacyClientIfActive(activeClients, accountId, binding.service),
      ),
    );
}

/**
 * Binds one legacy gateway generation to its account abort signal.
 * @param signal Host-owned lifecycle signal.
 * @param binding Core and service belonging to one generation.
 * @param activeClients Active legacy service by account.
 * @param accountId Account owned by the generation.
 */
export function registerLegacyGatewayAbort<Service>(
  signal: AbortSignal,
  binding: LegacyGatewayBinding<Service>,
  activeClients: Map<string, Service>,
  accountId: string,
): void {
  signal.addEventListener(
    "abort",
    () => {
      Effect.runFork(
        disconnectLegacyGateway(binding, activeClients, accountId),
      );
    },
    { once: true },
  );
}
