/** HMAC-SHA256 signing helper for outbound webhook payloads. */

import { createHmac } from "node:crypto";

/**
 * HMAC-SHA256-sign a webhook payload and return the `X-MoltZap-Signature`
 * header value (`sha256=&lt;hex>`). Receivers recompute over the exact JSON
 * bytes we send, so callers must pass the same `payload` string they will
 * write to the HTTP body. When using `@effect/platform/HttpClient`, this
 * means pairing `signWebhookPayload(secret, jsonString)` with
 * `HttpClientRequest.bodyText(jsonString)` — `HttpClientRequest.bodyJson`
 * re-stringifies and would drift the signature off the wire bytes.
 */
export function signWebhookPayload(secret: string, payload: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}
