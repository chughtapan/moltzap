import { Effect, Fiber, Ref } from "effect";

export type BadServerBehavior =
  | "ack-non-uuidv4-leaseid"
  | "no-abandon-on-disconnect"
  | "release-decision-mismatch"
  | "synthesize-grant-on-timeout"
  | "release-fires-twice"
  | "consumed-leaseid-mismatch"
  | "consumed-fires-on-second-send"
  | "expired-leaseid-mismatch"
  | "expired-fires-after-consume"
  | "getlease-leaseid-mismatch"
  | "getlease-allow-non-moderator"
  | "lease-id-collision"
  | "serialize-second-ack"
  | "release-out-of-order";

export const FORBIDDEN_ERROR_CODE = -32001;
export const DEFAULT_LEASE_TIMEOUT_MS = 5_000;
export const SERIALIZE_DELAY_MS = 2_000;

const BAD_SERVER_AGENT_UUID_PREFIX = "00000000-0000-4000-8000-";
const BAD_SERVER_AGENT_UUID_NODE_LEN = 12;

type RawWireRequestLiteral = {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
};

type RawWireNotificationLiteral = {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
};

export type ModeratorVerdict =
  | { readonly _tag: "grant"; readonly leaseTimeoutMs?: number }
  | { readonly _tag: "deny"; readonly reason?: string }
  | { readonly _tag: "hold"; readonly reason?: string };

export type ModeratorWaiterResponse =
  | { readonly _tag: "ok"; readonly value: ModeratorVerdict }
  | { readonly _tag: "error"; readonly reason: string }
  | { readonly _tag: "closed" };

export type AuthorizeWaiterMap = Map<
  string,
  (response: ModeratorWaiterResponse) => void
>;

export interface LeaseRecord {
  readonly dispatchId: string;
  readonly leaseId: string;
  readonly recipientConnId: number;
  readonly recipientAgentId: string;
  readonly conversationId: string;
  readonly mintIndex: number;
  state:
    | "PENDING"
    | "CLAIMED"
    | "GRANTED"
    | "CONSUMED"
    | "DENIED"
    | "EXPIRED"
    | "ABANDONED"
    | "HOLD";
  verdict: ModeratorVerdict | null;
  consumedMessageId: string | null;
  leaseTimeoutMs: number | null;
  expiryFiber: Fiber.RuntimeFiber<unknown, unknown> | null;
}

export interface ServerState {
  readonly agentByConn: Map<number, string>;
  readonly writers: Map<number, (raw: string) => Effect.Effect<void, unknown>>;
  moderatorAgentId: string | null;
  moderatorConnId: number | null;
  moderatorResponseTimeoutMs: number;
  readonly leases: Map<string, LeaseRecord>;
  readonly fixedTaskId: string;
  readonly fixedConversationId: string;
}

export interface BadDispatchRefs {
  readonly stateRef: Ref.Ref<ServerState>;
  readonly connCounter: Ref.Ref<number>;
  readonly authorizeWaiters: Ref.Ref<AuthorizeWaiterMap>;
  readonly collisionLeaseIdRef: Ref.Ref<string | null>;
  readonly firstAckHeldRef: Ref.Ref<boolean>;
  readonly mintCounterByRecipient: Ref.Ref<Map<number, number>>;
  readonly nextEmitIndexByRecipient: Ref.Ref<Map<number, number>>;
}

export interface HandleInboundFrameOpts {
  readonly raw: string;
  readonly connId: number;
  readonly stateRef: Ref.Ref<ServerState>;
  readonly authorizeWaiters: Ref.Ref<AuthorizeWaiterMap>;
  readonly collisionLeaseIdRef: Ref.Ref<string | null>;
  readonly firstAckHeldRef: Ref.Ref<boolean>;
  readonly mintCounterByRecipient: Ref.Ref<Map<number, number>>;
  readonly nextEmitIndexByRecipient: Ref.Ref<Map<number, number>>;
  readonly behavior: BadServerBehavior;
}

export function badServerAgentId(counter: number): string {
  return `${BAD_SERVER_AGENT_UUID_PREFIX}${counter
    .toString(16)
    .padStart(BAD_SERVER_AGENT_UUID_NODE_LEN, "0")}`;
}

export function encodeRawWireFrame(
  frame: RawWireRequestLiteral | RawWireNotificationLiteral,
): string {
  return JSON.stringify(frame);
}

export function freshUuidV4(): string {
  return globalThis.crypto.randomUUID();
}

export function initialServerState(): ServerState {
  return {
    agentByConn: new Map(),
    writers: new Map(),
    moderatorAgentId: null,
    moderatorConnId: null,
    moderatorResponseTimeoutMs: DEFAULT_LEASE_TIMEOUT_MS,
    leases: new Map(),
    fixedTaskId: "00000000-0000-4000-8000-000000000a01",
    fixedConversationId: "00000000-0000-4000-8000-000000000c01",
  };
}

export function makeBadDispatchRefs(): Effect.Effect<BadDispatchRefs> {
  return Effect.gen(function* () {
    return {
      stateRef: yield* Ref.make<ServerState>(initialServerState()),
      connCounter: yield* Ref.make(0),
      authorizeWaiters: yield* Ref.make<AuthorizeWaiterMap>(new Map()),
      collisionLeaseIdRef: yield* Ref.make<string | null>(null),
      firstAckHeldRef: yield* Ref.make<boolean>(false),
      mintCounterByRecipient: yield* Ref.make<Map<number, number>>(new Map()),
      nextEmitIndexByRecipient: yield* Ref.make<Map<number, number>>(new Map()),
    };
  }).pipe(Effect.withSpan("makeBadDispatchRefs"));
}
