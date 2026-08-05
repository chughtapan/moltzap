import type { HarnessClientService } from "@moltzap/client/harness-client";
import { Deferred, Effect } from "effect";

/** One caller-owned Harness client with the adapter's private drain signal. */
export interface ActiveHarnessClient {
  readonly client: HarnessClientService;
  readonly stopSignal: Deferred.Deferred<undefined>;
}

/**
 * Stops the adapter's binding for an account without closing its Harness
 * client, whose scope belongs to the caller that acquired it.
 * @param activeHarnessClients Harness drains owned by the adapter.
 * @param accountId Account whose active binding is stopped.
 * @returns A lazy stop operation for the selected account.
 */
export function stopActiveGatewayAccount(
  activeHarnessClients: Map<string, ActiveHarnessClient>,
  accountId: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const harness = activeHarnessClients.get(accountId);
    if (harness === undefined) {
      return;
    }
    activeHarnessClients.delete(accountId);
    yield* Deferred.succeed(harness.stopSignal, undefined);
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
