/**
 * @file Shared outbound-webhook concurrency cap.
 *
 * Outbound webhook traffic is bounded by one process-wide
 * `Effect.Semaphore(10)`. The in-repo webhook consumer is the YAML-wired
 * contact-policy service in `standalone.ts`.
 *
 * - {@link OUTBOUND_WEBHOOK_PERMITS} is a module-level `Effect.Semaphore(10)`
 *   constructed once at import time. Every standalone outbound webhook pulls
 *   from one permit pool.
 *
 * - {@link applyOutboundWebhookCap} wraps an arbitrary `HttpClient.HttpClient`
 *   with the shared semaphore via `HttpClient.transform`. The transform is
 *   scoped to `httpClient.execute(request)`, which is bounded at headers-
 *   arrival rather than the full body-read path. Permits return on fiber
 *   interrupt because the inner request runs inside the `withPermits` scope.
 */

import * as HttpClient from "@effect/platform/HttpClient";
import { Effect } from "effect";

/**
 * Default outbound-webhook concurrency cap. Module-internal; consumers go
 * through {@link applyOutboundWebhookCap}.
 */
const OUTBOUND_WEBHOOK_CONCURRENCY = 10;

/**
 * Process-wide shared semaphore for outbound webhook calls. Constructed at
 * module-import time so every consumer of this module sees the SAME
 * permit pool. Module-internal; consumers go through
 * {@link applyOutboundWebhookCap}.
 */
const OUTBOUND_WEBHOOK_PERMITS: Effect.Semaphore = Effect.runSync(
  Effect.makeSemaphore(OUTBOUND_WEBHOOK_CONCURRENCY),
);

/**
 * Wrap an `HttpClient.HttpClient` with {@link OUTBOUND_WEBHOOK_PERMITS}.
 * Used by the standalone contact-policy wiring so the same 10-permit pool
 * covers outbound webhook traffic in the process.
 * @param client Client used for the operation.
 * @returns The apply outbound webhook cap result.
 */
export function applyOutboundWebhookCap(
  client: HttpClient.HttpClient,
): HttpClient.HttpClient {
  return HttpClient.transform(client, (effect) =>
    OUTBOUND_WEBHOOK_PERMITS.withPermits(1)(effect),
  );
}
