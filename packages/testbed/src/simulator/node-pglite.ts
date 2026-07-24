/**
 * @file Isolates the `@electric-sql/pglite` reads behind the transcript
 * drain (the §6-scoped dependency), the way `node-http.ts` isolates the
 * http factory. PGlite is single-process, so the reader opens the data
 * directory only after the server container stopped; the caller wraps
 * these promise functions in `Effect.tryPromise`.
 */
/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-raw-throw-new-error -- PGlite's API is promise-native; this module isolates it the way node-http.ts isolates raw http, and the drain wraps these functions in Effect.tryPromise where the throw becomes the typed failure */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

/** One society message as persisted by the server's storage, normalized to primitives. */
export type StoredMessageRow = {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly seq: number;
  readonly replyToId: string | null;
  /** UTF-8 text of `parts_encrypted`; JSON only when `dekVersion` is 0 (plaintext posture). */
  readonly partsText: string;
  readonly dekVersion: number;
  readonly isDeleted: boolean;
  readonly createdAtMs: number;
};

const PGLITE_SENTINEL = "PG_VERSION";

/**
 * The server image owns where under the volume its PGlite directory
 * lives, so the reader detects it by the `PG_VERSION` sentinel at the
 * volume root or exactly one direct child (deeper nesting is not
 * searched). Zero candidates and an ambiguous volume throw distinct
 * messages; both surface typed through the caller's `Effect.tryPromise`.
 */
function locatePgliteDataDir(volumePath: string): string {
  if (existsSync(join(volumePath, PGLITE_SENTINEL))) return volumePath;
  if (!existsSync(volumePath)) {
    throw new Error(`storage volume "${volumePath}" does not exist`);
  }
  const candidates = readdirSync(volumePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(volumePath, entry.name))
    .filter((path) => existsSync(join(path, PGLITE_SENTINEL)));
  const [only] = candidates;
  if (only === undefined) {
    throw new Error(
      `no PGlite data directory (${PGLITE_SENTINEL}) at "${volumePath}" or one level below`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `ambiguous storage volume: ${String(candidates.length)} candidate PGlite data directories under "${volumePath}"`,
    );
  }
  return only;
}

const MESSAGES_QUERY = `
  SELECT id, conversation_id, sender_id, seq, reply_to_id,
         parts_encrypted, dek_version, is_deleted, created_at
  FROM messages
  ORDER BY conversation_id, seq
`;

type RawMessageRow = {
  readonly id: string;
  readonly conversation_id: string;
  readonly sender_id: string;
  readonly seq: number | bigint | string;
  readonly reply_to_id: string | null;
  readonly parts_encrypted: Uint8Array | string;
  readonly dek_version: number;
  readonly is_deleted: boolean;
  readonly created_at: Date | string;
};

/** Read every persisted society message from a stopped server's data volume. */
// #ignore-sloppy-code-next-line[async-keyword, promise-type]: PGlite's API is promise-native; this isolated module is the drain's Effect.tryPromise boundary
export async function readSocietyMessages(
  volumePath: string,
  // #ignore-sloppy-code-next-line[promise-type]: promise-native PGlite reader; the drain wraps it in Effect.tryPromise
): Promise<ReadonlyArray<StoredMessageRow>> {
  const dataDir = locatePgliteDataDir(volumePath);
  const db = new PGlite(dataDir);
  try {
    const result = await db.query<RawMessageRow>(MESSAGES_QUERY);
    return result.rows.map(normalizeRow);
  } finally {
    await db.close();
  }
}

/**
 * Validation happens here — inside `readSocietyMessages`'s promise — so
 * an out-of-range sequence or unparseable timestamp rejects through the
 * caller's `Effect.tryPromise` as a typed drain failure instead of
 * becoming a schema-decode defect at enqueue time.
 */
function normalizeRow(row: RawMessageRow): StoredMessageRow {
  const seq = Number(row.seq);
  if (!Number.isSafeInteger(seq)) {
    throw new Error(
      `message ${row.id} seq ${String(row.seq)} is outside the safe integer range`,
    );
  }
  const createdAtMs =
    row.created_at instanceof Date
      ? row.created_at.getTime()
      : Date.parse(row.created_at);
  if (!Number.isFinite(createdAtMs)) {
    throw new Error(
      `message ${row.id} created_at ${String(row.created_at)} is not a parseable timestamp`,
    );
  }
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    seq,
    replyToId: row.reply_to_id,
    partsText: bytesToUtf8(row.parts_encrypted),
    dekVersion: row.dek_version,
    isDeleted: row.is_deleted,
    createdAtMs,
  };
}

function bytesToUtf8(value: Uint8Array | string): string {
  if (typeof value !== "string") return Buffer.from(value).toString("utf8");
  // Some drivers surface bytea as hex text (`\x...`); decode that form too.
  return value.startsWith("\\x")
    ? Buffer.from(value.slice(2), "hex").toString("utf8")
    : value;
}
