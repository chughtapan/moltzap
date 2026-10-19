/** @file A retained card and signed envelope survive beyond live admission. */

import { Effect, Schema } from "effect";
import { expect, it, vi } from "vitest";

import { AgentCard, Ed25519PublicKey, SignedMessage } from "../index.js";
import golden from "./wire-golden.json" with { type: "json" };

vi.mock("../version.js", () => ({
  WIRE_VERSION: "2026.1006.1",
  LIVE_WIRE_VERSIONS: ["2026.1006.1"],
  HISTORY_WIRE_VERSIONS: ["2026.827.1", "2026.1006.1"],
}));

it("verifies golden card and signed bytes without changing their representation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const agentCard = yield* Schema.decodeUnknown(AgentCard)(golden.card);
      const verifiedCard = yield* AgentCard.verify({
        agentCard,
        registrySignerPublicKey: Schema.decodeUnknownSync(Ed25519PublicKey)(
          golden.registryKey,
        ),
      });
      const message = yield* Schema.decodeUnknown(SignedMessage)(
        golden.message,
      );
      yield* SignedMessage.verify({
        signedMessage: message,
        agentCard: verifiedCard,
      });
      expect(yield* Schema.encode(SignedMessage)(message)).toEqual(
        golden.message,
      );
      expect(yield* Schema.encode(AgentCard)(verifiedCard)).toEqual(
        golden.card,
      );
      expect(
        yield* Schema.decodeUnknown(SignedMessage.live)(golden.message).pipe(
          Effect.isFailure,
        ),
      ).toBe(true);
    }),
  ));
