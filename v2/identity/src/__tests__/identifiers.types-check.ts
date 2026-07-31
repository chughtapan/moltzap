/**
 * Identity strings remain distinct nominal values. This prevents a valid
 * identifier from silently crossing into another semantic position merely
 * because both values share the same encoded string representation.
 */

import type {
  AgentCardDigest,
  AgentId,
  AgentName,
  MessageId,
  PrincipalId,
} from "../index.js";
import type { AgentCardIssuedAt } from "../agent-card.js";
import type { OperationId } from "../registry.js";

type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
type Expect<Value extends true> = Value;
type ExpectFalse<Value extends false> = Value;

type IdentityValue =
  | AgentId
  | PrincipalId
  | AgentName
  | OperationId
  | MessageId
  | AgentCardDigest
  | AgentCardIssuedAt;

type RawStringsCannotConstructValues = ExpectFalse<
  string extends IdentityValue ? true : false
>;

type AgentAndPrincipalDiffer = ExpectFalse<Equal<AgentId, PrincipalId>>;
type AgentAndOperationDiffer = ExpectFalse<Equal<AgentId, OperationId>>;
type AgentAndMessageDiffer = ExpectFalse<Equal<AgentId, MessageId>>;
type AgentAndCardDigestDiffer = ExpectFalse<Equal<AgentId, AgentCardDigest>>;
type AgentAndNameDiffer = ExpectFalse<Equal<AgentId, AgentName>>;
type PrincipalAndNameDiffer = ExpectFalse<Equal<PrincipalId, AgentName>>;
type PrincipalAndOperationDiffer = ExpectFalse<Equal<PrincipalId, OperationId>>;
type PrincipalAndMessageDiffer = ExpectFalse<Equal<PrincipalId, MessageId>>;
type PrincipalAndCardDigestDiffer = ExpectFalse<
  Equal<PrincipalId, AgentCardDigest>
>;
type NameAndOperationDiffer = ExpectFalse<Equal<AgentName, OperationId>>;
type NameAndMessageDiffer = ExpectFalse<Equal<AgentName, MessageId>>;
type NameAndCardDigestDiffer = ExpectFalse<Equal<AgentName, AgentCardDigest>>;
type OperationAndMessageDiffer = ExpectFalse<Equal<OperationId, MessageId>>;
type OperationAndCardDigestDiffer = ExpectFalse<
  Equal<OperationId, AgentCardDigest>
>;
type MessageAndCardDigestDiffer = ExpectFalse<
  Equal<MessageId, AgentCardDigest>
>;
type IssuedAtAndAgentDiffer = ExpectFalse<Equal<AgentCardIssuedAt, AgentId>>;
type IssuedAtAndPrincipalDiffer = ExpectFalse<
  Equal<AgentCardIssuedAt, PrincipalId>
>;
type IssuedAtAndNameDiffer = ExpectFalse<Equal<AgentCardIssuedAt, AgentName>>;
type IssuedAtAndOperationDiffer = ExpectFalse<
  Equal<AgentCardIssuedAt, OperationId>
>;
type IssuedAtAndMessageDiffer = ExpectFalse<
  Equal<AgentCardIssuedAt, MessageId>
>;
type IssuedAtAndCardDigestDiffer = ExpectFalse<
  Equal<AgentCardIssuedAt, AgentCardDigest>
>;
type RefinedValuesRemainStrings = Expect<
  IdentityValue extends string ? true : false
>;

/** Compile-time witnesses for the package's public identity-value invariants. */
export type IdentityValueCanaries = [
  RawStringsCannotConstructValues,
  AgentAndPrincipalDiffer,
  AgentAndOperationDiffer,
  AgentAndMessageDiffer,
  AgentAndCardDigestDiffer,
  AgentAndNameDiffer,
  PrincipalAndNameDiffer,
  PrincipalAndOperationDiffer,
  PrincipalAndMessageDiffer,
  PrincipalAndCardDigestDiffer,
  NameAndOperationDiffer,
  NameAndMessageDiffer,
  NameAndCardDigestDiffer,
  OperationAndMessageDiffer,
  OperationAndCardDigestDiffer,
  MessageAndCardDigestDiffer,
  IssuedAtAndAgentDiffer,
  IssuedAtAndPrincipalDiffer,
  IssuedAtAndNameDiffer,
  IssuedAtAndOperationDiffer,
  IssuedAtAndMessageDiffer,
  IssuedAtAndCardDigestDiffer,
  RefinedValuesRemainStrings,
];
