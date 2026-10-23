/** @file Canonical GENESIS and POST record bytes and hashes. */

import { live as it } from "@effect/vitest";
import { Ed25519PublicKey } from "@moltzap/identity";
import { Effect, Schema } from "effect";
import { describe, expect } from "vitest";
import {
  decodeCanonical,
  DirectPacket,
  encodeCanonical,
  hashAction,
  hashRecord,
  MembershipDescriptor,
  verifyActionCertifiedRecord,
  verifyCertifiedRecord,
  verifyMembershipDescriptor,
} from "./index.js";
import golden from "./record-golden.json" with { type: "json" };

const utf8 = new TextEncoder();

describe("canonical record golden bytes", () => {
  for (const [index, form] of golden.forms.entries()) {
    it(`preserves record form ${index + 1}`, () =>
      Effect.gen(function* () {
        const key = yield* Schema.decodeUnknown(Ed25519PublicKey)(
          golden.registrySignerPublicKey,
        );
        const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)(
          golden.membership,
        );
        const membership = yield* verifyMembershipDescriptor(descriptor, key);
        const bytes = utf8.encode(form.bytes);
        const packet = yield* decodeCanonical(DirectPacket, bytes);
        if (
          packet.kind !== "action_certified_record" &&
          packet.kind !== "certified_record"
        ) {
          return yield* Effect.dieMessage("expected a golden record");
        }
        const record =
          packet.kind === "certified_record"
            ? packet.actionCertifiedRecord
            : packet;
        if (packet.kind === "certified_record") {
          yield* verifyCertifiedRecord({ record: packet, membership });
        } else {
          yield* verifyActionCertifiedRecord({ record: packet, membership });
        }
        expect(yield* encodeCanonical(DirectPacket, packet)).toEqual(bytes);
        expect(yield* hashRecord(record.recordCore)).toBe(form.recordHash);
        expect(yield* hashAction(record.recordCore.action)).toBe(
          form.actionHash,
        );
      }));
  }
});
