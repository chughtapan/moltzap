/** @file Snapshot retained checks after daemon writers stop and before SQLite closes. */

import { DateTime, Effect, Schema } from "effect";
import { createHash, type Hash, randomBytes } from "node:crypto";
import type { EndpointStore } from "../store/index.js";
import {
  appendAuditText,
  type AuditFile,
  FirewallAuditError,
  privateAuditPath,
  writeAuditFile,
} from "./firewall-audit-file.js";
import {
  decodeFirewallAuditEntry,
  FirewallAuditRecord,
} from "./firewall-values.js";

type AuditStore = Pick<
  EndpointStore,
  "readFirewallAuditPage" | "readFirewallActivations"
>;
const encodeLine = Schema.encode(Schema.parseJson(FirewallAuditRecord));

/** A fixed shutdown action has no messaging or policy-mutation authority. */
interface FirewallAuditExport {
  readonly finish: Effect.Effect<void, FirewallAuditError>;
}

/**
 * Invalidates earlier completed evidence before daemon resources are started.
 * The returned action must run after all daemon writers finish and before the
 * store closes. A failure leaves only an incomplete current-lifetime marker.
 */
export const beginFirewallAudit = (path: string, store: AuditStore) =>
  Effect.gen(function* () {
    const destination = yield* privateAuditPath(path);
    const start: FirewallAuditRecord = {
      kind: "start",
      format: "moltzap.firewall-audit/v2",
      snapshotId: randomBytes(32).toString("hex"),
      startedAt: yield* DateTime.now,
    };
    const header = yield* recordLine(start);
    yield* writeAuditFile(destination, (file) => appendAuditText(file, header));
    return {
      finish: writeAuditFile(destination, (file) =>
        exportSnapshot(file, store, start),
      ),
    } satisfies FirewallAuditExport;
  }).pipe(Effect.withSpan("beginFirewallAudit"));

function exportSnapshot(
  file: AuditFile,
  store: AuditStore,
  start: Extract<FirewallAuditRecord, { readonly kind: "start" }>,
) {
  return Effect.gen(function* () {
    yield* appendRecord(file, start);
    const digest = createHash("sha256");
    let after = 0;
    let checkCount = 0;
    while (true) {
      const page = yield* store
        .readFirewallAuditPage(after)
        .pipe(
          Effect.catchTag("EndpointStoreError", () =>
            Effect.fail(new FirewallAuditError({ reason: "records" })),
          ),
        );
      if (page.length === 0) {
        break;
      }
      for (const entry of page) {
        const line = yield* recordLine(
          yield* decodeFirewallAuditEntry(entry).pipe(
            Effect.catchTag("EndpointStoreError", () =>
              Effect.fail(new FirewallAuditError({ reason: "records" })),
            ),
          ),
        );
        yield* appendAuditText(file, line);
        digest.update(line);
        checkCount += 1;
        after = entry.sequence;
      }
    }
    const activationCount = yield* exportActivations(file, store, digest);
    yield* appendRecord(file, {
      kind: "complete",
      format: start.format,
      snapshotId: start.snapshotId,
      checkCount,
      activationCount,
      sha256: digest.digest("hex"),
    });
  });
}

function exportActivations(file: AuditFile, store: AuditStore, digest: Hash) {
  return Effect.gen(function* () {
    let after = 0;
    let activationCount = 0;
    while (true) {
      const page = yield* store
        .readFirewallActivations({ after })
        .pipe(
          Effect.catchTag("EndpointStoreError", () =>
            Effect.fail(new FirewallAuditError({ reason: "records" })),
          ),
        );
      if (page.length === 0) {
        break;
      }
      for (const entry of page) {
        const line = yield* recordLine({
          kind: "activation",
          ...entry.activation,
        });
        yield* appendAuditText(file, line);
        digest.update(line);
        activationCount += 1;
        after = entry.sequence;
      }
    }
    return activationCount;
  });
}

function appendRecord(file: AuditFile, record: FirewallAuditRecord) {
  return recordLine(record).pipe(
    Effect.flatMap((line) => appendAuditText(file, line)),
  );
}

function recordLine(record: FirewallAuditRecord) {
  return encodeLine(record).pipe(
    Effect.map((line) => `${line}\n`),
    Effect.catchTag("ParseError", () =>
      Effect.fail(new FirewallAuditError({ reason: "records" })),
    ),
  );
}
