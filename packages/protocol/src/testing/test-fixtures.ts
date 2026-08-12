/**
 * @file Branded identifier and credential constructors for test fixtures.
 *
 * The constructors decode fixture literals through the production schemas so
 * test data retains the same branded types as runtime values.
 */
import { FastCheck, Schema } from "effect";
import {
  agentId as agentIdSchema,
  agentName as agentNameSchema,
  type AgentKey,
  agentKey,
  userId as userIdSchema,
} from "#identity";
import { connectionId as decodeConnectionId } from "#socket";
import {
  conversationId as conversationIdSchema,
  messageId as messageIdSchema,
} from "#conversation";

const AGENT_KEY_PREFIX = "moltzap_agent_";
const KEY_ID_HEX_CHARS = 16;
const SECRET_HEX_CHARS = 48;
const FALLBACK_AGENT_KEY_STRING = `${AGENT_KEY_PREFIX}${"0".repeat(
  KEY_ID_HEX_CHARS,
)}_${"0".repeat(SECRET_HEX_CHARS)}`;
const HEX_DIGITS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
] as const;

// --- Branded-ID constructors ---
//
// Production code never validates IDs at the caller —
// `defineRpc(...).validateParams` is the single validation site. Tests +
// eval harnesses use these to construct branded values from UUID string
// literals.

/**
 * Validates and decodes user id values.
 * @param value Value to process.
 * @returns The user id result.
 */
export const userId = (
  value: string,
): Schema.Schema.Type<typeof userIdSchema> =>
  Schema.decodeUnknownSync(userIdSchema)(value);
/**
 * Validates and decodes agent id values.
 * @param value Value to process.
 * @returns The agent id result.
 */
export const agentId = (
  value: string,
): Schema.Schema.Type<typeof agentIdSchema> =>
  Schema.decodeUnknownSync(agentIdSchema)(value);
/**
 * Validates and decodes agent name values.
 * @param value Value to process.
 * @returns The agent name result.
 */
export const agentName = (
  value: string,
): Schema.Schema.Type<typeof agentNameSchema> =>
  Schema.decodeUnknownSync(agentNameSchema)(value);
/**
 * Validates and decodes conversation id values.
 * @param value Value to process.
 * @returns The conversation id result.
 */
export const conversationId = (
  value: string,
): Schema.Schema.Type<typeof conversationIdSchema> =>
  Schema.decodeUnknownSync(conversationIdSchema)(value);
/**
 * Validates and decodes message id values.
 * @param value Value to process.
 * @returns The message id result.
 */
export const messageId = (
  value: string,
): Schema.Schema.Type<typeof messageIdSchema> =>
  Schema.decodeUnknownSync(messageIdSchema)(value);
const hexStringArbitrary = (length: number): FastCheck.Arbitrary<string> =>
  FastCheck.array(FastCheck.constantFrom(...HEX_DIGITS), {
    minLength: length,
    maxLength: length,
  }).map((chars) => chars.join(""));
/** Provides the agent key string arbitrary runtime value. */
export const agentKeyStringArbitrary: FastCheck.Arbitrary<string> =
  FastCheck.tuple(
    hexStringArbitrary(KEY_ID_HEX_CHARS),
    hexStringArbitrary(SECRET_HEX_CHARS),
  ).map(([keyId, secret]) => `${AGENT_KEY_PREFIX}${keyId}_${secret}`);
/**
 * Validates and decodes redacted agent key values.
 * @param value Value to process.
 * @returns The redacted agent key result.
 */
export const redactedAgentKey = (value: string): AgentKey =>
  Schema.decodeUnknownSync(agentKey)(value);
/** Provides the agent key arbitrary runtime value. */
export const agentKeyArbitrary: FastCheck.Arbitrary<AgentKey> =
  agentKeyStringArbitrary.map(redactedAgentKey);
/**
 * Provides the agent key string runtime value.
 * @param seed Value supplied to the operation.
 * @returns The agent key string result.
 */
export const agentKeyString = (seed: number): string => {
  const [value] = FastCheck.sample(agentKeyStringArbitrary, {
    seed,
    numRuns: 1,
  });
  return value ?? FALLBACK_AGENT_KEY_STRING;
};
/** Provides the connection id runtime value. */
export const connectionId = decodeConnectionId;
