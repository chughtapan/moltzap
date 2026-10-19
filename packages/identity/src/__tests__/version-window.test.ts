/** @file A retained card and signed envelope survive beyond live admission. */

import { Effect, Schema } from "effect";
import { expect, it } from "vitest";

import {
  AgentCard,
  Ed25519PublicKey,
  SignedMessage,
  WIRE_VERSION,
  WireVersions,
} from "../index.js";
import golden from "./wire-golden.json" with { type: "json" };

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
    }).pipe(
      Effect.provideService(WireVersions, {
        live: [WIRE_VERSION],
        history: ["2099.101.0", WIRE_VERSION],
      }),
    ),
  ));

it("cannot widen live admission even when the supplied live set includes a retained version", () =>
  Effect.runPromise(
    Schema.decodeUnknown(SignedMessage.live)(golden.message).pipe(
      Effect.isFailure,
      Effect.provideService(WireVersions, {
        live: ["2099.101.0", WIRE_VERSION],
        history: ["2099.101.0", WIRE_VERSION],
      }),
      Effect.tap((rejected) =>
        Effect.sync(() => {
          expect(rejected).toBe(true);
        }),
      ),
    ),
  ));

it("keeps the binary's retained history when configured history is empty", () =>
  Effect.runPromise(
    Schema.decodeUnknown(WireVersions.history)(WIRE_VERSION).pipe(
      Effect.provideService(WireVersions, { live: [], history: [] }),
      Effect.tap((version) =>
        Effect.sync(() => {
          expect(version).toBe(WIRE_VERSION);
        }),
      ),
    ),
  ));
