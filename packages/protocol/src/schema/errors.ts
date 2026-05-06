import { Type, type Static } from "@sinclair/typebox";

export const ErrorCodes = {
  // JSON-RPC reserved codes (-32700 to -32600)
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Application codes (-32000 to -32099)
  Unauthorized: -32000,
  Forbidden: -32001,
  NotFound: -32002,
  Conflict: -32003,
  RateLimited: -32004,
  NotInContacts: -32005,
  Blocked: -32006,
  ConversationFull: -32007,
  ProtocolMismatch: -32008,
  // App codes (-32010 to -32029)
  AppNotFound: -32010,
  AgentNotFound: -32011,
  IdentityRejected: -32016,
  MaxParticipants: -32017,
  AgentNoOwner: -32018,
  HookBlocked: -32019,
  // Phase 9b consumer-migration (sub-issue #460): `SessionClosed` retired
  // alongside `apps/createSession` in Phase 7. The slot is repurposed as
  // `TaskClosed` with the same code so existing client error-mapping code
  // does not need to renumber. Phase 11 (arena cutover) is the natural
  // seam if a wire-level deletion is ever justified.
  TaskClosed: -32020,
  SessionNotFound: -32021,
  ConversationArchived: -32022,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const RpcErrorSchema = Type.Object(
  {
    code: Type.Integer(),
    message: Type.String(),
    data: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type RpcError = Static<typeof RpcErrorSchema>;
