/**
 * @file Shared outbound-webhook concurrency cap.
 *
 * The deleted bespoke `WebhookClient` owned a single `Effect.Semaphore(10)`
 * that bounded outbound webhook traffic. The remaining in-repo webhook
 * consumer is the YAML-wired contact-policy service in `standalone.ts`.
 *
 * This module rebuilds that contract on top of `@effect/platform/HttpClient`:
 *
 * - {@link OUTBOUND_WEBHOOK_PERMITS} is a module-level `Effect.Semaphore(10)`
 *   constructed once at import time (matching the old class-constructor
 *   shape). Every standalone outbound webhook pulls from one permit pool.
 *
 * - {@link applyOutboundWebhookCap} wraps an arbitrary `HttpClient.HttpClient`
 *   with the shared semaphore via `HttpClient.transform`. The transform is
 *   scoped to `httpClient.execute(request)`, which is bounded at headers-
 *   arrival rather than the full body-read path — slightly weaker than the
 *   old class but still bounds concurrent outbound requests. Permits return
 *   on fiber interrupt because the inner request runs inside the
 *   `withPermits` scope.
 */

import type { HttpClient as HttpClientNs } from "@effect/platform";
import { HttpClient } from "@effect/platform";
import { Effect } from "effect";

/**
 * Default outbound-webhook concurrency cap, matching the
 * `DEFAULT_WEBHOOK_CONCURRENCY` constant on the deleted `WebhookClient`.
 * Module-internal; consumers go through {@link applyOutboundWebhookCap}.
 */
const OUTBOUND_WEBHOOK_CONCURRENCY = 10;

/**
 * Process-wide shared semaphore for outbound webhook calls. Constructed at
 * module-import time so every consumer of this module sees the SAME
 * permit pool. Mirrors the prior `new WebhookClient()` shape, where the
 * class constructor called `Effect.runSync(Effect.makeSemaphore(...))`.
 * Module-internal; consumers go through {@link applyOutboundWebhookCap}.
 */
const OUTBOUND_WEBHOOK_PERMITS: Effect.Semaphore = Effect.runSync(
  Effect.makeSemaphore(OUTBOUND_WEBHOOK_CONCURRENCY),
);

/**
 * Wrap an `HttpClient.HttpClient` with {@link OUTBOUND_WEBHOOK_PERMITS}.
 * Used by the standalone contact-policy wiring so the same 10-permit pool
 * covers outbound webhook traffic in the process.
 */
export function applyOutboundWebhookCap(
  client: HttpClientNs.HttpClient,
): HttpClientNs.HttpClient {
  return HttpClient.transform(client, (effect) =>
    OUTBOUND_WEBHOOK_PERMITS.withPermits(1)(effect),
  );
}
