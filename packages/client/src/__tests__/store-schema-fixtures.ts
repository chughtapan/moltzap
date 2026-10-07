/**
 * @file Endpoint store fixtures: per-test state directories, scoped store
 * access, and a rewind of a closed store to a pre-cutover schema version so a
 * test can reopen it through the cutover.
 */

import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Store tests create and remove real SQLite state directories around independent Effect scopes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { onTestFinished } from "vitest";
import {
  type CertifiedRecord,
  type ConversationFoundation,
  type EndpointStore,
  type EndpointStoreError,
  openEndpointStore,
} from "../store/index.js";
import { digest } from "./agent-card-fixtures.js";

/**
 * A new empty state directory, removed when the running test finishes; only a
 * test body may call it.
 */
export function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "moltzap-store-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Run `use` against the store in `directory`, opened for that call alone and closed before the result returns. */
export function withStore<Value, Failure>(
  directory: string,
  use: (store: EndpointStore) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure | EndpointStoreError> {
  return Effect.scoped(openEndpointStore(directory).pipe(Effect.flatMap(use)));
}

/**
 * Rewind the closed store in `directory` to a schema version from before the
 * sealed-body cutover. Every protocol row and the bound identity stay, so the
 * next open cuts over a store that already holds them. Version 3 kept the
 * legacy-delivery table beside the runtime tables; version 2 had neither.
 * @param directory The state directory of a store no scope holds open.
 * @param version The pre-cutover schema version to read as.
 * @returns Completion once the database reads as `version`.
 */
export const rewindToPreCutoverSchema = (
  directory: string,
  version: 2 | 3,
): Effect.Effect<void> =>
  Effect.sync(() => {
    const database = new DatabaseSync(databasePath(directory));
    database.exec(
      version === 3
        ? `CREATE TABLE runtime_legacy_deliveries (
             delivery_token TEXT PRIMARY KEY REFERENCES pending_deliveries(delivery_token)
           ) STRICT;
           INSERT INTO runtime_legacy_deliveries (delivery_token)
             SELECT delivery_token FROM pending_deliveries WHERE acknowledged = 0;
           PRAGMA user_version = 3`
        : "DROP TABLE runtime_inbox; DROP TABLE runtime_sends; DROP TABLE runtime_events; PRAGMA user_version = 2",
    );
    database.close();
  });

/** The SQLite file the endpoint store keeps inside a state directory. */
export function databasePath(directory: string): string {
  return join(directory, "moltzapd.sqlite3");
}

/** A conversation foundation and one certified record in it. */
export interface StoredConversation {
  readonly foundation: ConversationFoundation;
  readonly record: CertifiedRecord;
}

/**
 * One conversation and a certified record Bob authored in it, carrying
 * placeholder bytes the store keeps without interpreting them.
 * @param label Distinguishes the conversation and its hashes.
 * @returns The foundation and the record.
 */
export function storedConversation(label: string): StoredConversation {
  const foundation = {
    conversationId: `conversation:${label}`,
    membershipHash: `mbr_${label}`,
    canonicalMembership: bytes("members"),
    anchorHash: `anc_${label}`,
    canonicalAnchor: bytes("anchor"),
  };
  const recordHash = digest("rch_", 3);
  return {
    foundation,
    record: {
      ...foundation,
      recordHash,
      actionHash: `ach_${label}`,
      authorAgentId: "agent:bob",
      postId: digest("pst_", 1),
      canonicalRecordCore: bytes("record"),
      actionEvidence: [
        {
          conversationId: foundation.conversationId,
          kind: "action",
          subjectId: `ach_${label}`,
          evidenceKey: "agent:bob",
          canonicalEvidence: bytes("action"),
        },
      ],
      durabilityEvidence: [
        {
          conversationId: foundation.conversationId,
          kind: "durability",
          subjectId: recordHash,
          evidenceKey: "agent:bob",
          canonicalEvidence: bytes("durability"),
        },
      ],
    },
  };
}

/** UTF-8 bytes of `value`, the form the store's canonical columns hold. */
export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
