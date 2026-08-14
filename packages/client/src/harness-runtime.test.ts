/** @file Pins the private semantic turn and opaque reply-grant MCP wire. */

import { AgentCard, Ed25519PublicKey } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ConversationId } from "./contract.js";
import {
  decodeHarnessExtension,
  decodeHarnessReplyRequest,
  decodeHarnessReplyRequestMeta,
  decodeHarnessStartRequest,
  decodeHarnessTurnEvent,
  HARNESS_EVENTS_EXTENSION,
  harnessReplyRequestMeta,
  makeReplyGrant,
  ReplyGrant,
  verifyHarnessTurnEvent,
} from "./harness-runtime.js";

/* eslint-disable agent-code-guard/async-keyword -- These focused interoperability tests await Promise-native Effect runners. */

const makeFixture = Effect.gen(function* () {
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    {
      crv: "Ed25519",
      kty: "OKP",
      x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
    },
  );
  const representation = {
    payload:
      "eyJhZ2VudElkIjoiYWd0Xy12cjYtdnI2LXZyNi12cjYtdnI2LWciLCJhZ2VudE5hbWUiOiJtaXhlZC1vcmRlci1zZW5kZXIiLCJpc3N1ZWRBdCI6IjIwMjYtMDctMzBUMTI6MDA6MDBaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi43MjkuMSIsInByaW5jaXBhbElkIjoicHJuXy1mbjUtZm41LWZuNS1mbjUtZm41LVEiLCJwdWJsaWNLZXkiOnsiY3J2IjoiRWQyNTUxOSIsImt0eSI6Ik9LUCIsIngiOiJsWm1abVptWm1abVptWm1abVptWm1abVptWm1abVptWm1abVptWm1abVprIn19",
    signatures: [
      {
        protected:
          "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6a1ByS19xbXhWV2FZVkE5d3dCRjZJdW8zdlZ6ejdUeEhDVHdYQnlnclM0ayIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
        signature:
          "UIoX5x508pcuCOXZW-xBirsyWVJ_Xxr3FJmnf5DTYq9QX6YlvAsaYRMH_0HuNckMq_sH62lAiPCIAAl52EUdAA",
      },
    ],
  };
  const parsed = yield* Schema.decodeUnknown(AgentCard)(representation);
  const agentCard = yield* AgentCard.verify({
    agentCard: parsed,
    registrySignerPublicKey,
  });
  return {
    agentCard,
    registrySignerPublicKey,
    representation,
  };
});

const conversationId = Schema.decodeUnknownSync(ConversationId)(
  "00000000-0000-4000-8000-000000000001",
);
const replyGrant = Schema.decodeUnknownSync(ReplyGrant)(
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
);

const semanticEvent = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const decoded = await Effect.runPromise(
    decodeHarnessTurnEvent({
      conversationId,
      peers: [fixture.representation],
      author: fixture.representation,
      content: [{ type: "text", text: "one action" }],
      replyGrant,
    }),
  );
  const verified = await Effect.runPromise(
    verifyHarnessTurnEvent(decoded, fixture.registrySignerPublicKey),
  );

  expect(verified.author).toEqual(fixture.agentCard);
  expect(verified.peers).toEqual([fixture.agentCard]);
  expect(verified.content).toEqual([{ type: "text", text: "one action" }]);
  expect(verified.replyGrant).toBe(replyGrant);
  expect(verified.replyGrant.length).toBeGreaterThan(0);

  await expect(
    Effect.runPromise(
      decodeHarnessTurnEvent({ ...decoded, messages: [], invented: true }),
    ),
  ).rejects.toBeDefined();
};

const verifiesPinnedExtension = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const decoded = await Effect.runPromise(
    decodeHarnessExtension({
      [HARNESS_EVENTS_EXTENSION]: {
        registrySignerPublicKey: fixture.registrySignerPublicKey,
      },
    }),
  );
  expect(decoded.registrySignerPublicKey).toEqual(
    fixture.registrySignerPublicKey,
  );
};

const keepsOpaqueReplyMetadataMinimal = (): void => {
  expect(harnessReplyRequestMeta(replyGrant)).toEqual({
    [HARNESS_EVENTS_EXTENSION]: { replyGrant },
  });
};

const validatesOperationRequests = async () => {
  const start = await Effect.runPromise(
    decodeHarnessStartRequest({
      conversationId,
      peers: ["remote-agent"],
      content: [{ type: "text", text: "begin" }],
    }),
  );
  const reply = await Effect.runPromise(
    decodeHarnessReplyRequest({
      content: [{ type: "data", value: { accepted: true } }],
    }),
  );
  const metadataGrant = await Effect.runPromise(
    decodeHarnessReplyRequestMeta(harnessReplyRequestMeta(replyGrant)),
  );

  expect(start.conversationId).toBe(conversationId);
  expect(start.peers).toEqual(["remote-agent"]);
  expect(reply.content).toEqual([{ type: "data", value: { accepted: true } }]);
  expect(metadataGrant).toBe(replyGrant);

  await expect(
    Effect.runPromise(
      decodeHarnessStartRequest({ ...start, operationId: "forbidden" }),
    ),
  ).rejects.toBeDefined();
  await expect(
    Effect.runPromise(
      decodeHarnessReplyRequestMeta({
        [HARNESS_EVENTS_EXTENSION]: { replyGrant: "short" },
      }),
    ),
  ).rejects.toBeDefined();
};

const mintsCanonicalReplyAuthority = async () => {
  const first = await Effect.runPromise(makeReplyGrant());
  const second = await Effect.runPromise(makeReplyGrant());

  expect(first).toHaveLength(43);
  expect(second).toHaveLength(43);
  expect(second).not.toBe(first);
};

// @agent-code-guard/regression-only: these examples pin the reduced private representation that backs the public Client.
describe("Harness MCP semantic wire", () => {
  it("decodes and verifies exactly one semantic action", semanticEvent);
  it("decodes the daemon-pinned Registry signer", verifiesPinnedExtension);
  it("routes reply only through opaque live authority", () => {
    keepsOpaqueReplyMetadataMinimal();
  });
  it("pins exact START and reply requests", validatesOperationRequests);
  it("mints canonical volatile reply authority", mintsCanonicalReplyAuthority);
});

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults. */
