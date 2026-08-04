import { Schema } from "effect";
import { agentName, type AgentName } from "@moltzap/protocol/identity";

/** Prefix used for named agent targets. */
const TARGET_PREFIX_AGENT = "agent:";

/** Prefix used for existing conversation targets. */
export const TARGET_PREFIX_CONVERSATION = "conv:";

/** User-facing description of the accepted target forms. */
export const TARGET_HINT =
  'Use an agent name or "agent:<name>" for DMs or "conv:<conversationId>" for conversations';

interface ResolvedAgentTarget {
  readonly to: string;
  readonly kind: "user";
  readonly display: AgentName;
}

interface ResolvedConversationTarget {
  readonly to: string;
  readonly kind: "group";
  readonly display: string;
}

/** Normalized target consumed by OpenClaw directory and outbound adapters. */
export type ResolvedMoltZapTarget =
  | ResolvedAgentTarget
  | ResolvedConversationTarget;

const isAgentName = Schema.is(agentName);

function normalizeConversationTarget(
  target: string,
): ResolvedConversationTarget | null | undefined {
  if (!target.startsWith(TARGET_PREFIX_CONVERSATION)) {
    return undefined;
  }
  const id = target.slice(TARGET_PREFIX_CONVERSATION.length);
  return id.length === 0 || id.includes(":")
    ? null
    : { to: target, kind: "group", display: id };
}

function normalizeAgentTarget(target: string): ResolvedAgentTarget | null {
  let name: string | null;
  if (target.startsWith(TARGET_PREFIX_AGENT)) {
    name = target.slice(TARGET_PREFIX_AGENT.length);
  } else if (target.includes(":")) {
    name = null;
  } else {
    name = target;
  }
  return name === null || !isAgentName(name)
    ? null
    : { to: `${TARGET_PREFIX_AGENT}${name}`, kind: "user", display: name };
}

/**
 * Normalizes an OpenClaw target into a named agent or existing conversation.
 * @param raw User-supplied target.
 * @returns A normalized target, or null when the shape is unsupported.
 */
export function normalizeMoltZapTarget(
  raw: string,
): ResolvedMoltZapTarget | null {
  const target = raw.trim();
  const conversation = normalizeConversationTarget(target);
  if (conversation !== undefined) {
    return conversation;
  }
  return normalizeAgentTarget(target);
}

/**
 * Tests whether a target is already in canonical OpenClaw form.
 * @param raw User-supplied target.
 * @returns Whether the target is canonical and supported.
 */
export function isMoltZapTarget(raw: string): boolean {
  const target = raw.trim();
  return normalizeMoltZapTarget(target)?.to === target;
}
