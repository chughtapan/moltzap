import { Data, Effect } from "effect";
import type { RuntimeKind } from "./testbed.js";

export class InvalidPayload extends Data.TaggedError("InvalidPayload")<{
  readonly path: string;
  readonly issues: readonly string[];
}> {}

interface DirectConversationPayload {
  readonly kind: "direct";
  readonly setupMessage: string;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly senderName?: string;
}

interface GroupConversationPayload {
  readonly kind: "group";
  readonly setupMessage: string;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly senderName?: string;
  readonly groupName?: string;
  readonly bystanders: ReadonlyArray<{
    readonly name: string;
    readonly messages: ReadonlyArray<string>;
  }>;
}

interface CrossConversationPayload {
  readonly kind: "cross";
  readonly setupMessage: string;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly senderName?: string;
  readonly probeSenderName?: string;
  readonly probeMessage: string;
}

type ConversationPayload =
  | DirectConversationPayload
  | GroupConversationPayload
  | CrossConversationPayload;

export interface HarnessPayload {
  readonly runtime: {
    readonly kind: RuntimeKind;
    readonly targetAgentName?: string;
    readonly readyTimeoutMs?: number;
    readonly responseTimeoutMs?: number;
  };
  readonly conversation: ConversationPayload;
}

type RuntimeCandidate = {
  readonly kind?: unknown;
  readonly targetAgentName?: unknown;
  readonly readyTimeoutMs?: unknown;
  readonly responseTimeoutMs?: unknown;
};

type ConversationCandidate = {
  readonly kind?: unknown;
  readonly setupMessage?: unknown;
  readonly followUpMessages?: unknown;
  readonly senderName?: unknown;
  readonly groupName?: unknown;
  readonly bystanders?: unknown;
  readonly probeMessage?: unknown;
  readonly probeSenderName?: unknown;
};

type BystanderPayload = GroupConversationPayload["bystanders"][number];
type PayloadCandidate = {
  readonly runtime?: unknown;
  readonly conversation?: unknown;
};
type BystanderCandidate = {
  readonly name?: unknown;
  readonly messages?: unknown;
};

/** The failure shape cc-judge receives when a scenario's payload does not decode. */
export interface InvalidPayloadFailure {
  readonly cause: InvalidPayload;
}

export function decodePayload(
  sourcePath: string,
  payload: unknown,
): Effect.Effect<HarnessPayload, InvalidPayloadFailure, never> {
  const issues: Array<string> = [];
  const candidatePayload = payloadCandidate(payload, issues);
  const runtime = runtimeCandidate(candidatePayload?.runtime, issues);
  const conversation = conversationCandidate(
    candidatePayload?.conversation,
    issues,
  );
  validateRuntime(runtime, issues);
  validateConversationBase(conversation, issues);

  const followUpMessages =
    asStringList(
      conversation?.followUpMessages,
      "conversation.followUpMessages",
      issues,
    ) ?? [];
  const bystanders = decodeGroupBystanders(conversation, issues);
  const crossProbe = decodeCrossProbe(conversation, issues);

  if (issues.length > 0) {
    return Effect.fail(failLoad(sourcePath, issues));
  }

  return Effect.succeed({
    runtime: buildRuntimePayload(runtime),
    conversation: buildConversationPayload({
      conversation,
      followUpMessages,
      bystanders,
      ...crossProbe,
    }),
  });
}

function failLoad(pathValue: string, issues: readonly string[]) {
  return { cause: new InvalidPayload({ path: pathValue, issues }) };
}

function payloadCandidate(
  value: unknown,
  issues: Array<string>,
): PayloadCandidate | undefined {
  if (isObjectCandidate(value)) {
    return value;
  }
  issues.push("payload must be an object");
  return undefined;
}

function runtimeCandidate(
  value: unknown,
  issues: Array<string>,
): RuntimeCandidate | undefined {
  if (isObjectCandidate(value)) {
    return value;
  }
  issues.push("runtime must be an object");
  return undefined;
}

function conversationCandidate(
  value: unknown,
  issues: Array<string>,
): ConversationCandidate | undefined {
  if (isObjectCandidate(value)) {
    return value;
  }
  issues.push("conversation must be an object");
  return undefined;
}

function validateRuntime(
  runtime: RuntimeCandidate | undefined,
  issues: Array<string>,
): void {
  if (!isRuntimeKind(runtime?.kind)) {
    issues.push("runtime.kind must be 'openclaw' or 'nanoclaw'");
  }
  optionalNonEmptyString(
    runtime?.targetAgentName,
    "runtime.targetAgentName",
    issues,
  );
  optionalPositiveInteger(
    runtime?.readyTimeoutMs,
    "runtime.readyTimeoutMs",
    issues,
  );
  optionalPositiveInteger(
    runtime?.responseTimeoutMs,
    "runtime.responseTimeoutMs",
    issues,
  );
}

function validateConversationBase(
  conversation: ConversationCandidate | undefined,
  issues: Array<string>,
): void {
  if (!isConversationKind(conversation?.kind)) {
    issues.push("conversation.kind must be 'direct', 'group', or 'cross'");
  }
  requiredNonEmptyString(
    conversation?.setupMessage,
    "conversation.setupMessage",
    issues,
  );
  optionalNonEmptyString(
    conversation?.senderName,
    "conversation.senderName",
    issues,
  );
}

function decodeGroupBystanders(
  conversation: ConversationCandidate | undefined,
  issues: Array<string>,
): ReadonlyArray<BystanderPayload> {
  if (conversation?.kind !== "group") {
    return [];
  }
  optionalNonEmptyString(
    conversation.groupName,
    "conversation.groupName",
    issues,
  );
  return bystanderCandidates(conversation.bystanders, issues)
    .map((entry, index) => decodeBystander(entry, index, issues))
    .filter((entry): entry is BystanderPayload => entry !== undefined);
}

function bystanderCandidates(
  value: unknown,
  issues: Array<string>,
): ReadonlyArray<unknown> {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  issues.push("conversation.bystanders must be an array");
  return [];
}

function decodeBystander(
  entry: unknown,
  index: number,
  issues: Array<string>,
): BystanderPayload | undefined {
  if (!isBystanderCandidate(entry)) {
    issues.push(`conversation.bystanders[${String(index)}] must be an object`);
    return undefined;
  }
  const name = requiredNonEmptyString(
    entry.name,
    `conversation.bystanders[${String(index)}].name`,
    issues,
  );
  if (name === undefined) {
    return undefined;
  }
  return {
    name,
    messages:
      asStringList(
        entry.messages,
        `conversation.bystanders[${String(index)}].messages`,
        issues,
      ) ?? [],
  };
}

function decodeCrossProbe(
  conversation: ConversationCandidate | undefined,
  issues: Array<string>,
): {
  readonly probeMessage: string | undefined;
  readonly probeSenderName: string | undefined;
} {
  if (conversation?.kind !== "cross") {
    return {
      probeMessage: undefined,
      probeSenderName: undefined,
    };
  }
  return {
    probeMessage: requiredNonEmptyString(
      conversation.probeMessage,
      "conversation.probeMessage",
      issues,
    ),
    probeSenderName: optionalNonEmptyString(
      conversation.probeSenderName,
      "conversation.probeSenderName",
      issues,
    ),
  };
}

function buildRuntimePayload(
  runtime: RuntimeCandidate | undefined,
): HarnessPayload["runtime"] {
  const targetAgentName = stringValue(runtime?.targetAgentName);
  const readyTimeoutMs = numberValue(runtime?.readyTimeoutMs);
  const responseTimeoutMs = numberValue(runtime?.responseTimeoutMs);
  return {
    kind: narrowRuntimeKind(runtime?.kind),
    ...(targetAgentName !== undefined ? { targetAgentName } : {}),
    ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
    ...(responseTimeoutMs !== undefined ? { responseTimeoutMs } : {}),
  };
}

function buildConversationPayload(input: {
  readonly conversation: ConversationCandidate | undefined;
  readonly followUpMessages: ReadonlyArray<string>;
  readonly bystanders: ReadonlyArray<BystanderPayload>;
  readonly probeMessage: string | undefined;
  readonly probeSenderName: string | undefined;
}): ConversationPayload {
  const base = conversationBase(input.conversation, input.followUpMessages);
  switch (narrowConversationKind(input.conversation?.kind)) {
    case "group":
      return groupConversationPayload(base, input);
    case "cross":
      return crossConversationPayload(base, input);
    case "direct":
      return base;
  }
}

function conversationBase(
  conversation: ConversationCandidate | undefined,
  followUpMessages: ReadonlyArray<string>,
): DirectConversationPayload {
  const setupMessage = stringValue(conversation?.setupMessage) ?? "";
  const senderName = stringValue(conversation?.senderName);
  return {
    kind: "direct",
    setupMessage,
    followUpMessages,
    ...(senderName !== undefined ? { senderName } : {}),
  };
}

function groupConversationPayload(
  base: DirectConversationPayload,
  input: {
    readonly conversation: ConversationCandidate | undefined;
    readonly bystanders: ReadonlyArray<BystanderPayload>;
  },
): GroupConversationPayload {
  const groupName = stringValue(input.conversation?.groupName);
  return {
    ...base,
    kind: "group",
    ...(groupName !== undefined ? { groupName } : {}),
    bystanders: input.bystanders,
  };
}

function crossConversationPayload(
  base: DirectConversationPayload,
  input: {
    readonly probeMessage: string | undefined;
    readonly probeSenderName: string | undefined;
  },
): CrossConversationPayload {
  return {
    ...base,
    kind: "cross",
    ...(input.probeSenderName !== undefined
      ? { probeSenderName: input.probeSenderName }
      : {}),
    probeMessage: input.probeMessage ?? "",
  };
}

function asStringList(
  value: unknown,
  field: string,
  issues: Array<string>,
): ReadonlyArray<string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.every(isNonEmptyString)) {
    return value;
  }
  issues.push(`${field} must be an array of non-empty strings`);
  return undefined;
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
  issues: Array<string>,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  issues.push(`${field} must be a positive integer`);
  return undefined;
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
  issues: Array<string>,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredNonEmptyString(value, field, issues);
}

function requiredNonEmptyString(
  value: unknown,
  field: string,
  issues: Array<string>,
): string | undefined {
  if (isNonEmptyString(value)) {
    return value;
  }
  issues.push(`${field} must be a non-empty string`);
  return undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isObjectCandidate(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBystanderCandidate(value: unknown): value is BystanderCandidate {
  return isObjectCandidate(value);
}

function isRuntimeKind(kind: unknown): kind is RuntimeKind {
  return kind === "openclaw" || kind === "nanoclaw";
}

function isConversationKind(
  kind: unknown,
): kind is ConversationPayload["kind"] {
  return kind === "direct" || kind === "group" || kind === "cross";
}

function narrowRuntimeKind(kind: unknown): RuntimeKind {
  return isRuntimeKind(kind) ? kind : "openclaw";
}

function narrowConversationKind(kind: unknown): ConversationPayload["kind"] {
  return isConversationKind(kind) ? kind : "direct";
}
