import { Type, type Static } from "@sinclair/typebox";
import { RpcErrorSchema } from "./errors.js";

/**
 * Direction discriminator for `request` / `response` frames.
 *
 * - `c2s` = client→server (the historical-only direction; client-initiated
 *   RPC, server replies).
 * - `s2c` = server→client (server-initiated RPC, client replies).
 *
 * Required on every request/response envelope so a request id minted on the
 * client and a request id minted on the server can collide on the wire
 * without confusing routing — c2s and s2c pending maps are disjoint per
 * `(side, type)`, and `direction` makes the side the frame originated on
 * explicit at the schema layer too.
 *
 * Events remain s2c-only and do NOT carry a `direction` field — they are
 * not request/response and have no correlation surface.
 *
 * Implemented as `Type.Union([Type.Literal, ...])` rather than `stringEnum`
 * because `Value.Check` (used by `packages/protocol/src/testing/codec.ts`
 * for the conformance frame round-trip) requires every node to carry a
 * native TypeBox `[Kind]`. `stringEnum` produces a `Type.Unsafe` node and
 * `Value.Check` rejects it with `"Unknown type"`. AJV strict mode accepts
 * the resulting `anyOf` shape.
 */
export const FrameDirectionSchema = Type.Union([
  Type.Literal("c2s"),
  Type.Literal("s2c"),
]);
export type FrameDirection = Static<typeof FrameDirectionSchema>;

/**
 * Bidirectional request envelope.
 *
 * - `direction: "c2s"` — client-initiated RPC. Routed on the server to the
 *   existing `RpcRouter` dispatcher.
 * - `direction: "s2c"` — server-initiated RPC. Routed on the client to the
 *   per-method handler registry registered via
 *   `MoltZapWsClient.handleServerRpc` / `TestClient.handleServerRpc`.
 */
export const RequestFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("request"),
    direction: FrameDirectionSchema,
    id: Type.String(),
    method: Type.String(),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/**
 * Bidirectional response envelope.
 *
 * - `direction: "c2s"` — server's reply to a client-initiated request. Routed
 *   on the client to the c2s pending map keyed by `id`.
 * - `direction: "s2c"` — client's reply to a server-initiated request. Routed
 *   on the server to the per-connection s2c pending map keyed by `id`.
 */
export const ResponseFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("response"),
    direction: FrameDirectionSchema,
    id: Type.String(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(RpcErrorSchema),
  },
  { additionalProperties: false },
);

export const EventFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("event"),
    event: Type.String(),
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type RequestFrame = Static<typeof RequestFrameSchema>;
export type ResponseFrame = Static<typeof ResponseFrameSchema>;
export type EventFrame = Static<typeof EventFrameSchema>;
