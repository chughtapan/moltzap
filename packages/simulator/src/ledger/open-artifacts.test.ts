import { createHash } from "node:crypto";
import { assert, effect as test } from "@effect/vitest";
import { DateTime, Effect, Schema, Stream } from "effect";
import { EventCatalog } from "../events/catalog.js";
import {
  LedgerCompletion,
  ledgerDigest,
  LedgerManifest,
  ledgerRef,
} from "./model.js";
import { openLedgerArtifacts } from "./open.js";

const DEFINITION_ID = "acme.artifact-reader/v1";
const REF = Schema.decodeSync(ledgerRef)("artifact-reader-test");

class ArtifactReaderEvent extends Schema.TaggedClass<ArtifactReaderEvent>()(
  "acme.artifact-reader-event/v1",
  { value: Schema.String },
) {}

const catalog = EventCatalog.make(ArtifactReaderEvent);

function digest(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

test("validates retrieved artifact text without a storage service", () =>
  Effect.gen(function* () {
    const manifest = LedgerManifest.make({
      ledgerFormatVersion: 1,
      definitionId: DEFINITION_ID,
      runId: "artifact-reader-run",
      catalogTags: [ArtifactReaderEvent._tag],
      createdAt: DateTime.unsafeMake(0),
      provenance: {},
      metadata: {},
    });
    const manifestText = JSON.stringify(
      Schema.encodeSync(LedgerManifest)(manifest),
    );
    const records = "";
    const completion = LedgerCompletion.make({
      ledgerFormatVersion: 1,
      runId: manifest.runId,
      recordCount: 0,
      artifacts: {
        manifest: Schema.decodeSync(ledgerDigest)(digest(manifestText)),
        records: Schema.decodeSync(ledgerDigest)(digest(records)),
      },
    });
    const opened = yield* openLedgerArtifacts(
      catalog,
      REF,
      {
        manifest: manifestText,
        records,
        completion: JSON.stringify(
          Schema.encodeSync(LedgerCompletion)(completion),
        ),
      },
      DEFINITION_ID,
    );

    assert.strictEqual(opened.ref, REF);
    assert.strictEqual(yield* Stream.runCount(opened.records), 0);
  }));
