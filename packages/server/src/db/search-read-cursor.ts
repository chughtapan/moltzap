/**
 * Opaque cursor and checkpoint codecs for the stable read plane.
 *
 * Search cursors bind the page position to the operation, normalized query,
 * and authenticated agent. Conversation reads use a cursor for one frozen
 * page chain and a separate checkpoint for the durable high-water mark.
 */
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  conversationCheckpoint,
  type ConversationCheckpoint,
} from "@moltzap/protocol/message";
import {
  InvalidParamsError,
  listCursorSchema,
  type ListCursor,
} from "@moltzap/protocol/rpc";
import { Effect, Schema } from "effect";

/** The server-owned page size for directory and conversation reads. */
export const READ_PLANE_PAGE_SIZE = 50;

const CODEC_VERSION = 1;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL_RE = /^(?:0|[1-9]\d*)$/;

/** Identifies the search operation a cursor may continue. */
type SearchCursorKind = "agents" | "conversations";

/** Values that bind a search cursor to one caller and request. */
export interface SearchCursorBinding {
  readonly kind: SearchCursorKind;
  readonly query: string;
  readonly agentId: AgentId;
}

/** Search cursor position after the last emitted stable identifier. */
export interface SearchCursorPosition {
  readonly lastId: string;
}

/** Frozen position carried between pages of one conversation read. */
export interface ConversationReadCursorPosition {
  readonly throughSeq: string;
  readonly afterSeq: string;
}

/** Durable high-water mark recovered from a conversation checkpoint. */
export interface ConversationCheckpointPosition {
  readonly throughSeq: string;
}

interface SearchCursorPayload {
  readonly agentId: string;
  readonly kind: SearchCursorKind;
  readonly lastId: string;
  readonly query: string;
  readonly version: number;
}

interface ConversationReadCursorPayload {
  readonly afterSeq: string;
  readonly conversationId: string;
  readonly kind: "conversation-read-page";
  readonly throughSeq: string;
  readonly version: number;
}

interface ConversationCheckpointPayload {
  readonly conversationId: string;
  readonly kind: "conversation-checkpoint";
  readonly throughSeq: string;
  readonly version: number;
}

/**
 * Trim a search query; the empty string is the canonical browse query.
 * @param query Untrusted request query.
 * @returns The normalized cursor binding value.
 */
export function normalizeSearchQuery(query?: string): string {
  return query?.trim() ?? "";
}

function invalidParams(message: string): InvalidParamsError {
  return new InvalidParamsError({ message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const compare = (left: string, right: string) => left.localeCompare(right);
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isCanonicalDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_RE.test(value);
}

function encodePayload(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(
  token: string,
): Effect.Effect<Record<string, unknown>, InvalidParamsError> {
  return Effect.try({
    try: () => Buffer.from(token, "base64url"),
    catch: () => invalidParams("Cursor is not base64url"),
  }).pipe(
    Effect.flatMap((bytes) => {
      if (bytes.toString("base64url") !== token) {
        return Effect.fail(invalidParams("Cursor is not canonical base64url"));
      }
      const json = bytes.toString("utf8");
      return Effect.try({
        try: () => {
          const value: unknown = JSON.parse(json);
          return { json, value };
        },
        catch: () => invalidParams("Cursor payload is not valid JSON"),
      });
    }),
    Effect.flatMap(({ json, value }) => {
      if (!isRecord(value) || JSON.stringify(value) !== json) {
        return Effect.fail(
          invalidParams("Cursor payload is not canonical JSON"),
        );
      }
      return Effect.succeed(value);
    }),
  );
}

function searchPayload(
  binding: SearchCursorBinding,
  lastId: string,
): SearchCursorPayload {
  return {
    agentId: binding.agentId,
    kind: binding.kind,
    lastId,
    query: binding.query,
    version: CODEC_VERSION,
  };
}

function isSearchPayloadFor(
  value: Record<string, unknown>,
  binding: SearchCursorBinding,
): value is Record<string, unknown> & SearchCursorPayload {
  if (!hasExactKeys(value, ["agentId", "kind", "lastId", "query", "version"])) {
    return false;
  }
  if (value.version !== CODEC_VERSION || value.kind !== binding.kind) {
    return false;
  }
  if (value.query !== binding.query || value.agentId !== binding.agentId) {
    return false;
  }
  return isCanonicalUuid(value.lastId);
}

/**
 * Encode the position after one search page.
 * @param input Bound request and last emitted identifier.
 * @returns An opaque search cursor.
 */
export function encodeSearchCursor(
  input: SearchCursorBinding & SearchCursorPosition,
): ListCursor {
  return Schema.decodeSync(listCursorSchema())(
    encodePayload(searchPayload(input, input.lastId)),
  );
}

/**
 * Decode and validate a search cursor against its active request binding.
 * @param cursor Opaque continuation supplied by the caller.
 * @param binding Active operation, query, and agent identity.
 * @returns The last emitted stable identifier.
 */
export function decodeSearchCursor(
  cursor: ListCursor | string,
  binding: SearchCursorBinding,
): Effect.Effect<SearchCursorPosition, InvalidParamsError> {
  return decodePayload(cursor).pipe(
    Effect.flatMap((value) => {
      if (!isSearchPayloadFor(value, binding)) {
        return Effect.fail(
          invalidParams("Cursor does not match this search request"),
        );
      }
      const expected = searchPayload(binding, value.lastId);
      if (encodePayload(expected) !== cursor) {
        return Effect.fail(invalidParams("Cursor payload is not canonical"));
      }
      return Effect.succeed({ lastId: value.lastId });
    }),
  );
}

/**
 * Split a fixed-size `page + 1` search batch and encode its continuation.
 * @param rows Ordered result batch containing at most one overflow row.
 * @param binding Active search cursor binding.
 * @param idOf Selects a row's stable identifier.
 * @returns The visible page and optional continuation cursor.
 */
export function paginateSearchRows<Row>(
  rows: readonly Row[],
  binding: SearchCursorBinding,
  idOf: (row: Row) => string,
): { readonly page: readonly Row[]; readonly nextCursor?: ListCursor } {
  if (rows.length <= READ_PLANE_PAGE_SIZE) {
    return { page: rows };
  }
  const page = rows.slice(0, READ_PLANE_PAGE_SIZE);
  const last = page[page.length - 1];
  if (last === undefined) {
    return { page };
  }
  return {
    page,
    nextCursor: encodeSearchCursor({ ...binding, lastId: idOf(last) }),
  };
}

function checkpointPayload(
  conversationId: ConversationId,
  throughSeq: string,
): ConversationCheckpointPayload {
  return {
    conversationId,
    kind: "conversation-checkpoint",
    throughSeq,
    version: CODEC_VERSION,
  };
}

function isCheckpointPayloadFor(
  value: Record<string, unknown>,
  conversationId: ConversationId,
): value is Record<string, unknown> & ConversationCheckpointPayload {
  if (
    !hasExactKeys(value, ["conversationId", "kind", "throughSeq", "version"])
  ) {
    return false;
  }
  if (
    value.version !== CODEC_VERSION ||
    value.kind !== "conversation-checkpoint"
  ) {
    return false;
  }
  if (value.conversationId !== conversationId) {
    return false;
  }
  return isCanonicalDecimal(value.throughSeq);
}

/**
 * Encode a durable, conversation-bound read checkpoint.
 * @param input Stable conversation high-water mark.
 * @param input.conversationId Conversation owning the checkpoint.
 * @param input.throughSeq Canonical decimal high-water sequence.
 * @returns An opaque durable checkpoint.
 */
export function encodeConversationCheckpoint(input: {
  readonly conversationId: ConversationId;
  readonly throughSeq: string;
}): ConversationCheckpoint {
  return Schema.decodeSync(conversationCheckpoint)(
    encodePayload(checkpointPayload(input.conversationId, input.throughSeq)),
  );
}

/**
 * Decode a checkpoint and prove it belongs to the requested conversation.
 * @param checkpoint Opaque durable checkpoint supplied by the caller.
 * @param conversationId Requested conversation.
 * @returns The stable high-water sequence.
 */
export function decodeConversationCheckpoint(
  checkpoint: ConversationCheckpoint | string,
  conversationId: ConversationId,
): Effect.Effect<ConversationCheckpointPosition, InvalidParamsError> {
  return decodePayload(checkpoint).pipe(
    Effect.flatMap((value) => {
      if (!isCheckpointPayloadFor(value, conversationId)) {
        return Effect.fail(
          invalidParams("Checkpoint does not match this conversation"),
        );
      }
      const expected = checkpointPayload(conversationId, value.throughSeq);
      if (encodePayload(expected) !== checkpoint) {
        return Effect.fail(
          invalidParams("Checkpoint payload is not canonical"),
        );
      }
      return Effect.succeed({ throughSeq: value.throughSeq });
    }),
  );
}

function readCursorPayload(input: {
  readonly conversationId: ConversationId;
  readonly throughSeq: string;
  readonly afterSeq: string;
}): ConversationReadCursorPayload {
  return {
    afterSeq: input.afterSeq,
    conversationId: input.conversationId,
    kind: "conversation-read-page",
    throughSeq: input.throughSeq,
    version: CODEC_VERSION,
  };
}

function isReadCursorPayloadFor(
  value: Record<string, unknown>,
  conversationId: ConversationId,
): value is Record<string, unknown> & ConversationReadCursorPayload {
  if (
    !hasExactKeys(value, [
      "afterSeq",
      "conversationId",
      "kind",
      "throughSeq",
      "version",
    ])
  ) {
    return false;
  }
  if (
    value.version !== CODEC_VERSION ||
    value.kind !== "conversation-read-page"
  ) {
    return false;
  }
  if (value.conversationId !== conversationId) {
    return false;
  }
  if (
    !isCanonicalDecimal(value.throughSeq) ||
    !isCanonicalDecimal(value.afterSeq)
  ) {
    return false;
  }
  return BigInt(value.afterSeq) <= BigInt(value.throughSeq);
}

/**
 * Encode one continuation within a frozen conversation page chain.
 * @param input Frozen conversation read interval.
 * @param input.conversationId Conversation owning the page chain.
 * @param input.throughSeq Frozen canonical decimal high-water sequence.
 * @param input.afterSeq Last emitted canonical decimal sequence.
 * @returns An opaque page cursor.
 */
export function encodeConversationReadCursor(input: {
  readonly conversationId: ConversationId;
  readonly throughSeq: string;
  readonly afterSeq: string;
}): ListCursor {
  return Schema.decodeSync(listCursorSchema())(
    encodePayload(readCursorPayload(input)),
  );
}

/**
 * Decode a frozen conversation cursor and validate its sequence interval.
 * @param cursor Opaque page continuation supplied by the caller.
 * @param conversationId Requested conversation.
 * @returns The frozen high-water and last-emitted sequences.
 */
export function decodeConversationReadCursor(
  cursor: ListCursor | string,
  conversationId: ConversationId,
): Effect.Effect<ConversationReadCursorPosition, InvalidParamsError> {
  return decodePayload(cursor).pipe(
    Effect.flatMap((value) => {
      if (!isReadCursorPayloadFor(value, conversationId)) {
        return Effect.fail(
          invalidParams("Cursor does not match this conversation read"),
        );
      }
      const expected = readCursorPayload({
        conversationId,
        throughSeq: value.throughSeq,
        afterSeq: value.afterSeq,
      });
      if (encodePayload(expected) !== cursor) {
        return Effect.fail(invalidParams("Cursor payload is not canonical"));
      }
      return Effect.succeed({
        throughSeq: value.throughSeq,
        afterSeq: value.afterSeq,
      });
    }),
  );
}
