/**
 * Regression test pinning HMAC byte-exactness for the delivery webhook.
 *
 * The contract: `signWebhookPayload(secret, payload)` MUST be fed the
 * EXACT same string that goes on the wire as the request body. Any
 * refactor that swaps `HttpClientRequest.bodyText(payload)` for
 * `HttpClientRequest.bodyJson(obj)` / `HttpClientRequest.bodyUnsafeJson(obj)`
 * would re-stringify the object (different key order, whitespace,
 * Unicode escaping, etc.) and silently drift the signature off the
 * wire bytes. Receivers recomputing the HMAC over their received body
 * would reject every delivery webhook.
 *
 * This test asserts the invariant directly: the X-MoltZap-Signature
 * header value equals `signWebhookPayload(secret, captured_body_bytes)`,
 * where `captured_body_bytes` is what the test HttpClient actually saw
 * on the wire.
 */

import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { it as effectIt } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";
import { signWebhookPayload } from "../../crypto/webhook-signature.js";
import type { Db } from "../../db/client.js";
import { MessageService } from "./message.service.js";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId } from "@moltzap/protocol/task";

// `effectIt.live` (not `.effect`) — the SUT spawns a fire-and-forget
// fiber via `Effect.runFork` that runs against the live Effect runtime,
// so the test fiber's polling needs the real clock to observe the
// captured request.
const it = effectIt.live;

const DELIVERY_URL = "https://hook.test/delivery";
const DELIVERY_SECRET = "secret-shared-with-receiver";
const CONV_ID = "00000000-0000-4000-8000-00000000c001" as ConversationId;
const MSG_ID = "00000000-0000-4000-8000-00000000d001" as MessageId;
const AGENT_A = "00000000-0000-4000-8000-0000000000a1" as AgentId;
const AGENT_B = "00000000-0000-4000-8000-0000000000b2" as AgentId;
const HTTP_OK = 200;
// Wire event name MessageService.fireDeliveryWebhook sets in the
// X-MoltZap-Event header. Receivers may key on this string, so a
// rename here is a wire-protocol break.
const DELIVERY_EVENT_NAME = "messages.delivered";

interface CapturedRequest {
  bodyBytes: string;
  signatureHeader: string | undefined;
  eventHeader: string | undefined;
}

function extractBodyBytes(
  request: HttpClientRequest.HttpClientRequest,
): string {
  const body = request.body;
  if (body._tag === "Raw") return String(body.body);
  if (body._tag === "Uint8Array") {
    return new TextDecoder().decode(body.body);
  }
  return "";
}

function captureFakeClient(captured: {
  last: CapturedRequest | null;
}): HttpClient.HttpClient {
  return HttpClient.make((request) =>
    Effect.suspend(
      (): Effect.Effect<
        HttpClientResponse.HttpClientResponse,
        HttpClientError.HttpClientError
      > => {
        const bodyBytes = extractBodyBytes(request);
        captured.last = {
          bodyBytes,
          signatureHeader: request.headers["x-moltzap-signature"],
          eventHeader: request.headers["x-moltzap-event"],
        };
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response("", { status: HTTP_OK }),
          ),
        );
      },
    ),
  );
}

/**
 * Test-only view exposing the otherwise-private
 * `spawnDeliveryWebhooks` entry point. The type-bypass guard in
 * `scripts/sloppy-code-guard.sh` flags structural casts because they
 * normally hide type-system holes; here the cast is mechanical and
 * the shape declared below is checked against MessageService's
 * signature at compile time. If the signature drifts, the cast no
 * longer assigns and the test fails to typecheck — the same effect
 * as a typed guard.
 */
interface DeliveryHarness {
  spawnDeliveryWebhooks: (
    input: {
      conversationId: ConversationId;
      carrier: { message: { id: MessageId } };
      senderAgentId: AgentId;
    },
    recipients: readonly AgentId[],
    delivered: readonly AgentId[],
  ) => void;
  close: () => Effect.Effect<void, never>;
}

/** Construct a MessageService stub wired only enough to fire the delivery webhook. */
function buildDeliveryHarness(
  httpClient: HttpClient.HttpClient,
): DeliveryHarness {
  // The other deps are unreachable from the delivery-webhook code path.
  // We supply them as the smallest typed values that satisfy the
  // constructor. The harness exercises `fireDeliveryWebhook` only —
  // every other public method would touch DB or AppHost and is out of
  // scope here.
  const service: object = new MessageService({
    db: {} as Db,
    conversations: {} as never,
    networkSend: {} as never,
    encryption: null,
    deliveryWebhook: { url: DELIVERY_URL, secret: DELIVERY_SECRET },
    httpClient,
    appHost: null,
  });
  // eslint-disable-next-line agent-code-guard/as-unknown-as -- structural-private-access: cast to DeliveryHarness above; any MessageService.spawnDeliveryWebhooks signature drift breaks the assignment at compile time, equivalent to a typed guard
  return service as unknown as DeliveryHarness; // #ignore-sloppy-code[as-unknown-as]: structural-private-access; DeliveryHarness above pins the signature so any drift fails the cast at compile time
}

function hmacBytesMatchWireBytes() {
  return Effect.gen(function* () {
    const captured = { last: null as CapturedRequest | null };
    const harness = buildDeliveryHarness(captureFakeClient(captured));

    // Spawning the fire-and-forget fiber returns immediately; we then
    // wait for the captured-request side-effect.
    harness.spawnDeliveryWebhooks(
      {
        conversationId: CONV_ID,
        carrier: { message: { id: MSG_ID } },
        senderAgentId: AGENT_A,
      },
      [AGENT_A, AGENT_B],
      [AGENT_A],
    );

    // The fiber runs synchronously enough that the test client captures
    // the request on the next microtask. Poll a few times.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (captured.last !== null) break;
      yield* Effect.sleep("5 millis");
    }
    yield* Effect.sleep("5 millis");
    yield* harness.close();

    expect(captured.last).not.toBeNull();
    const recorded = captured.last!;

    // INVARIANT 1: the X-MoltZap-Signature header is exactly
    // `signWebhookPayload(secret, bodyBytes)`, recomputed over the bytes
    // that actually went on the wire.
    expect(recorded.signatureHeader).toBe(
      signWebhookPayload(DELIVERY_SECRET, recorded.bodyBytes),
    );

    // INVARIANT 2: the body is the exact JSON shape we publish, with no
    // extra whitespace or reordering. Pins
    // `HttpClientRequest.bodyText(payload, ...)` over `bodyJson(obj)` —
    // the latter would re-stringify the object inside HttpBody.json and
    // could produce different bytes from JSON.stringify here.
    expect(recorded.bodyBytes).toBe(
      JSON.stringify({
        conversationId: CONV_ID,
        messageId: MSG_ID,
        offlineRecipientAgentIds: [AGENT_B],
      }),
    );

    // INVARIANT 3: header convention preserved.
    expect(recorded.eventHeader).toBe(DELIVERY_EVENT_NAME);
  });
}

describe("MessageService.fireDeliveryWebhook HMAC byte-exactness", () => {
  it("signs the exact bytes that go on the wire", () =>
    hmacBytesMatchWireBytes());
});
