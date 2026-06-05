import { Schema } from "effect";
import { brandedString, type BrandedString } from "../transport/wire-string.js";

/**
 * Server-internal WebSocket connection identifier. Minted at WS accept
 * (`crypto.randomUUID()`); not on the wire. Branded so it cannot be
 * confused with `AgentId`, `AppId`, or other ids in service signatures.
 *
 * Boundary: a single `as ConnectionId` cast at the WS-accept site is the
 * only acceptable construction in production code; downstream is brand-
 * typed end-to-end. Test fixtures use the `connectionId(raw)` constructor
 * exported from `@moltzap/protocol/testing`.
 *
 * Schema-level format: `brandedString` (no UUID predicate). The mint
 * site happens to use UUIDs, but conformance-test fixtures sometimes
 * pass synthetic strings; the brand boundary is the type system, not
 * a format check.
 */
export const ConnectionId = brandedString("ConnectionId");
export type ConnectionId = BrandedString<"ConnectionId">;

export const connectionId = Schema.decodeSync(ConnectionId);

export const newConnectionId = (): ConnectionId =>
  connectionId(crypto.randomUUID());
