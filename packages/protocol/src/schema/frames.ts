import { Type, type Static } from "@sinclair/typebox";
import { RpcErrorSchema } from "./errors.js";
import { stringEnum } from "../helpers.js";

export const RequestFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("request"),
    id: Type.String(),
    method: Type.String(),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ResponseFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("response"),
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

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1.0 STUBS — server-initiated awaitable RPC frame surface (B.0 architect)
//
// The new bidirectional RPC layer reuses the existing `request` / `response`
// frame shape and adds a single `direction` discriminator. Implementer (B.1)
// folds these new schemas INTO `RequestFrameSchema` / `ResponseFrameSchema` as
// a required `direction: "c2s" | "s2c"` field — webhook deletion in the same
// wave (B.4) means there is no back-compat constraint and no need to keep
// shape-distinct schemas. Standalone schemas appear here only as architecture
// stubs: the implementer's job is to collapse them into the canonical Request
// and Response schemas, not to keep two shapes in production.
//
// Key design decision: directions are NAMESPACED, so a c2s request id
// `tc-xxx-1` and an s2c request id `srv-yyy-1` route to disjoint pending maps
// and CAN collide on the wire without confusing routing. See conformance
// property "dual-direction request-ID collision" (B.8).
//
// Routing table after collapse (all four cells must be exercised by tests):
//   {client side}  recv request, direction=s2c → handler registry
//   {client side}  recv response, direction=c2s → client pending map
//   {server side}  recv request, direction=c2s → server RPC router (existing)
//   {server side}  recv response, direction=s2c → server per-conn pending map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Direction discriminator for `request` / `response` frames after the Phase 1
 * collapse. `c2s` = client→server (today's only direction). `s2c` =
 * server→client (admission RPC). Events remain s2c-only and do not carry a
 * direction field — they are not request/response.
 */
export const FrameDirectionSchema = stringEnum(["c2s", "s2c"]);
export type FrameDirection = Static<typeof FrameDirectionSchema>;

/**
 * Server-initiated request envelope. Identical to `RequestFrameSchema` plus
 * a `direction: "s2c"` literal. Implementer collapses this into the canonical
 * `RequestFrameSchema` by adding `direction: FrameDirectionSchema` (required).
 */
export const S2cRequestFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("request"),
    direction: Type.Literal("s2c"),
    id: Type.String(),
    method: Type.String(),
    params: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/**
 * Client-originated response to an `S2cRequestFrame`. Implementer collapses
 * this into `ResponseFrameSchema` by adding `direction: FrameDirectionSchema`
 * (required). The `id` MUST match the originating server request.
 */
export const S2cResponseFrameSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    type: Type.Literal("response"),
    direction: Type.Literal("s2c"),
    id: Type.String(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(RpcErrorSchema),
  },
  { additionalProperties: false },
);

export type S2cRequestFrame = Static<typeof S2cRequestFrameSchema>;
export type S2cResponseFrame = Static<typeof S2cResponseFrameSchema>;
