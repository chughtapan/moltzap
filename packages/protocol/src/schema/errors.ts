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
  SkillTimeout: -32012,
  SkillMismatch: -32013,
  PermissionTimeout: -32014,
  PermissionDenied: -32015,
  IdentityRejected: -32016,
  MaxParticipants: -32017,
  AgentNoOwner: -32018,
  HookBlocked: -32019,
  SessionClosed: -32020,
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
