/**
 * Public entry barrel for `@moltzap/claude-code-channel`.
 *
 * Only names listed here are part of the public surface.
 */

export { bootClaudeCodeChannel, type BootResult } from "./entry.js";
export type {
  BootOptions,
  Handle,
  ClaudeChannelNotification,
  GateInbound,
  ChatId,
  MessageId,
  UserId,
  IsoTimestamp,
} from "./types.js";
export type {
  BootError,
  PushError,
  AllowlistError,
  ReplyError,
  EventShapeError,
} from "./errors.js";
