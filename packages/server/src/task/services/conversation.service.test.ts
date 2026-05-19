/**
 * Regression: ConversationService.create + addParticipant must subscribe
 * every participant's open sockets to the conversation id.
 *
 * Why: the conversation broadcast path gates on `conn.conversationIds`.
 * A participant whose connection isn't in the set silently misses every
 * event on the conversation. Before the service auto-subscribed, every
 * downstream caller had to reimplement the same loop. Some did; some
 * didn't. These tests exercise the service directly against PGlite so the
 * contract is locked at the service boundary.
 */

import { it as effectIt } from "@effect/vitest";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import {
  ForbiddenError,
  JSON_RPC_RESERVED_CODES,
  NotInContactsError,
} from "@moltzap/protocol";
import {
  conversationId as makeConversationId,
  wireErrorFromInstance,
} from "@moltzap/protocol/testing";
import { AuthService } from "../../identity/services/auth.service.js";
import {
  ConversationService,
  type ContactPolicyCheck,
} from "./conversation.service.js";
import { ParticipantService } from "../../identity/services/participant.service.js";
import {
  AddParticipantPermission,
  ConversationCreateAuthorization,
  obtainAddParticipantPermission,
  obtainConversationCreateAuthorization,
} from "../../app/capabilities/index.js";
import {
  ConversationServiceTag,
  ParticipantServiceTag,
} from "../../app/layers.js";
import {
  ConnectionManager,
  type MoltZapConnection,
} from "../../transport/connection.js";
import { unusedOriginator } from "../../transport/connection.test-utils.js";
import type { AuthenticatedContext } from "../../transport/context.js";
import type { AgentId } from "../../app/types.js";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import { takeFirstOrFail } from "../../db/effect-kysely-toolkit.js";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";

const BROADCAST_SETTLE_MS = 50;
const PROPERTY_RUNS = 8;
const CONV_TYPE_DM = "dm";
const CONV_TYPE_GROUP = "group";
const PLANNING_NAME = "planning";
const TEAM_NAME = "team";
const RENAMED_NAME = "renamed";
const BOB_RENAME = "by-bob";
const MISSING_UPDATE_NAME = "x";
const OWNER_ALICE = "00000000-0000-0000-0000-0000000000a1";
const OWNER_BOB = "00000000-0000-0000-0000-0000000000b2";
const OWNER_CAROL = "00000000-0000-0000-0000-0000000000c3";
const MISSING_CONVERSATION_ID = makeConversationId(
  "00000000-0000-4000-8000-00000000dead",
);
const PARTICIPANTS_ADDED_FRAGMENT = '"method":"participants/added"';
const PARTICIPANTS_REMOVED_FRAGMENT = '"method":"participants/removed"';
const CONTACT_POLICY_MESSAGE = /contact policy/i;
const DM_MESSAGE = /dm/i;

let harness: PgliteHarness;

const it = effectIt.effect;

const noopWrite: MoltZapConnection["write"] = () => Effect.void;
const noopShutdown: MoltZapConnection["shutdown"] = Effect.void;

interface Fixture {
  readonly connections: ConnectionManager;
  readonly service: ConversationService;
  readonly auth: AuthService;
}

interface WireFailure {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

interface CreateConversationInput {
  readonly service: ConversationService;
  readonly type: typeof CONV_TYPE_DM | typeof CONV_TYPE_GROUP;
  readonly name: string | undefined;
  readonly participants: AgentId[];
  readonly initiator: AgentId;
}

function setupHarness() {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
      }),
    ),
  );
}

function useHarnessLifecycle() {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);
}

function makeFixture(): Fixture {
  const connections = new ConnectionManager();
  const participants = new ParticipantService(harness.db);
  return {
    connections,
    service: new ConversationService(harness.db, participants, connections),
    auth: new AuthService(harness.db),
  };
}

function makeFixtureWithPolicy(policy: ContactPolicyCheck): Fixture {
  const connections = new ConnectionManager();
  const participants = new ParticipantService(harness.db);
  return {
    connections,
    service: new ConversationService(
      harness.db,
      participants,
      connections,
      () => policy,
    ),
    auth: new AuthService(harness.db),
  };
}

function makeConn(connId: string, agentId: AgentId): MoltZapConnection {
  const auth: AuthenticatedContext = {
    agentId,
    agentStatus: "active",
    ownerUserId: null,
  };
  return {
    id: connId,
    write: noopWrite,
    shutdown: noopShutdown,
    auth,
    lastPong: Date.now(),
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
    originator: unusedOriginator(),
  };
}

function recordingConn(
  connId: string,
  agentId: AgentId,
  sink: string[],
): MoltZapConnection {
  const auth: AuthenticatedContext = {
    agentId,
    agentStatus: "active",
    ownerUserId: null,
  };
  return {
    id: connId,
    write: (raw) =>
      Effect.sync(() => {
        sink.push(raw);
      }),
    shutdown: noopShutdown,
    auth,
    lastPong: Date.now(),
    conversationIds: new Set<string>(),
    mutedConversations: new Set<string>(),
    originator: unusedOriginator(),
  };
}

function seedAgent(auth: AuthService, name: string) {
  return auth
    .registerAgent({ name })
    .pipe(Effect.map((registered) => registered.agentId));
}

function seedOwnedAgent(auth: AuthService, name: string, ownerUserId: string) {
  return auth
    .registerAgent({ name }, ownerUserId)
    .pipe(Effect.map((registered) => registered.agentId));
}

function seedAliceBob(fx: Fixture) {
  return Effect.all({
    alice: seedAgent(fx.auth, "alice"),
    bob: seedAgent(fx.auth, "bob"),
  });
}

function seedAliceBobCarol(fx: Fixture) {
  return Effect.all({
    alice: seedAgent(fx.auth, "alice"),
    bob: seedAgent(fx.auth, "bob"),
    carol: seedAgent(fx.auth, "carol"),
  });
}

function seedOwnedAliceBob(fx: Fixture) {
  return Effect.all({
    alice: seedOwnedAgent(fx.auth, "alice", OWNER_ALICE),
    bob: seedOwnedAgent(fx.auth, "bob", OWNER_BOB),
  });
}

function seedOwnedAliceBobCarol(fx: Fixture) {
  return Effect.all({
    alice: seedOwnedAgent(fx.auth, "alice", OWNER_ALICE),
    bob: seedOwnedAgent(fx.auth, "bob", OWNER_BOB),
    carol: seedOwnedAgent(fx.auth, "carol", OWNER_CAROL),
  });
}

function seedTask(initiator: AgentId): Effect.Effect<TaskId, unknown> {
  return takeFirstOrFail(
    harness.db
      .insertInto("tasks")
      .values({
        initiator_agent_id: initiator,
        status: "waiting",
        tm_endpoint_address: `tm:agent:${initiator}`,
      })
      .returning("id"),
  ).pipe(Effect.map((row) => row.id));
}

interface AddParticipantPermDeps {
  readonly service: ConversationService;
  readonly participants: ParticipantService;
  readonly conversationId: ConversationId;
  readonly targetAgentId: AgentId;
  readonly requesterAgentId: AgentId;
}

function provideAddParticipantPerm(deps: AddParticipantPermDeps) {
  return <A, E, R>(eff: Effect.Effect<A, E, R | AddParticipantPermission>) =>
    eff.pipe(
      Effect.provideServiceEffect(
        AddParticipantPermission,
        obtainAddParticipantPermission({
          conversationId: deps.conversationId,
          requesterAgentId: deps.requesterAgentId,
          targetAgentId: deps.targetAgentId,
        }),
      ),
      Effect.provideService(ConversationServiceTag, deps.service),
      Effect.provideService(ParticipantServiceTag, deps.participants),
    ) as Effect.Effect<A, E, Exclude<R, AddParticipantPermission>>;
}

function callAddParticipant(
  fx: Fixture,
  conversationId: ConversationId,
  target: AgentId,
  requester: AgentId,
) {
  return fx.service.addParticipant(conversationId, target, requester).pipe(
    provideAddParticipantPerm({
      service: fx.service,
      participants: new ParticipantService(harness.db),
      conversationId,
      targetAgentId: target,
      requesterAgentId: requester,
    }),
  );
}

function provideCreateAuth(
  service: ConversationService,
  type: "dm" | "group",
  agentIds: ReadonlyArray<AgentId>,
  creatorAgentId: AgentId,
) {
  return <A, E, R>(
    eff: Effect.Effect<A, E, R | ConversationCreateAuthorization>,
  ) =>
    eff.pipe(
      Effect.provideServiceEffect(
        ConversationCreateAuthorization,
        obtainConversationCreateAuthorization({
          type,
          agentIds,
          creatorAgentId,
        }),
      ),
      Effect.provideService(ConversationServiceTag, service),
    ) as Effect.Effect<A, E, Exclude<R, ConversationCreateAuthorization>>;
}

function createConversation(input: CreateConversationInput) {
  return Effect.gen(function* () {
    const taskId = yield* seedTask(input.initiator);
    return yield* input.service
      .create({
        type: input.type,
        name: input.name,
        agentIds: input.participants,
        creatorAgentId: input.initiator,
        mintTask: Effect.succeed({ id: taskId }),
      })
      .pipe(
        provideCreateAuth(
          input.service,
          input.type,
          input.participants,
          input.initiator,
        ),
      );
  });
}

function createConversationExit(input: CreateConversationInput) {
  return Effect.gen(function* () {
    const taskId = yield* seedTask(input.initiator);
    return yield* Effect.exit(
      input.service
        .create({
          type: input.type,
          name: input.name,
          agentIds: input.participants,
          creatorAgentId: input.initiator,
          mintTask: Effect.succeed({ id: taskId }),
        })
        .pipe(
          provideCreateAuth(
            input.service,
            input.type,
            input.participants,
            input.initiator,
          ),
        ),
    );
  });
}

function createDm(service: ConversationService, bob: AgentId, alice: AgentId) {
  return createConversation({
    service,
    type: CONV_TYPE_DM,
    name: undefined,
    participants: [bob],
    initiator: alice,
  });
}

function createDmExit(
  service: ConversationService,
  bob: AgentId,
  alice: AgentId,
) {
  return createConversationExit({
    service,
    type: CONV_TYPE_DM,
    name: undefined,
    participants: [bob],
    initiator: alice,
  });
}

function createNamedGroup(
  service: ConversationService,
  name: string,
  participants: AgentId[],
  initiator: AgentId,
) {
  return createConversation({
    service,
    type: CONV_TYPE_GROUP,
    name,
    participants,
    initiator,
  });
}

function createNamedGroupExit(
  service: ConversationService,
  name: string,
  participants: AgentId[],
  initiator: AgentId,
) {
  return createConversationExit({
    service,
    type: CONV_TYPE_GROUP,
    name,
    participants,
    initiator,
  });
}

function expectRpcFailure<A>(exit: Exit.Exit<A, unknown>): WireFailure {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return { code: 0, message: "" };

  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) return { code: 0, message: "" };

  const wire = wireErrorFromInstance(failure.value);
  expect(wire).not.toBeNull();
  return wire ?? { code: 0, message: "" };
}

function participantAgentIds(conversationId: ConversationId) {
  return harness.db
    .selectFrom("conversation_participants")
    .select("agent_id")
    .where("conversation_id", "=", conversationId)
    .pipe(Effect.map((rows) => rows.map((row) => row.agent_id).sort()));
}

function settleBroadcasts() {
  return Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, BROADCAST_SETTLE_MS);
      }),
    catch: (cause) => cause,
  }).pipe(Effect.orDie);
}

function recordPolicyCall(
  calls: Array<[string, string]>,
  ownerA: string,
  ownerB: string,
  verdict: boolean,
): boolean {
  calls.push([ownerA, ownerB]);
  return verdict;
}

function recordingPolicy(
  calls: Array<[string, string]>,
  verdict: boolean,
): ContactPolicyCheck {
  return (left, right) =>
    Effect.sync(() => recordPolicyCall(calls, left, right, verdict));
}

function policyInvocationProperty() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(fc.uuid(), fc.uuid(), (ownerA, ownerB) => {
        const calls: Array<[string, string]> = [];
        const policy = recordingPolicy(calls, true);
        expect(Effect.runSync(policy(ownerA, ownerB))).toBe(true);
        expect(calls).toEqual([[ownerA, ownerB]]);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
}

function subscribeCreatorAndParticipants() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob, carol } = yield* seedAliceBobCarol(fx);
    const aliceConn = makeConn("c-alice", alice);
    const bobConn = makeConn("c-bob", bob);
    const carolConn = makeConn("c-carol", carol);
    fx.connections.add(aliceConn);
    fx.connections.add(bobConn);
    fx.connections.add(carolConn);

    const conv = yield* createNamedGroup(
      fx.service,
      PLANNING_NAME,
      [bob, carol],
      alice,
    );
    expect(aliceConn.conversationIds.has(conv.id)).toBe(true);
    expect(bobConn.conversationIds.has(conv.id)).toBe(true);
    expect(carolConn.conversationIds.has(conv.id)).toBe(true);
  });
}

function subscribesEverySocketForAgent() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob } = yield* seedAliceBob(fx);
    const bob1 = makeConn("c-bob-1", bob);
    const bob2 = makeConn("c-bob-2", bob);
    fx.connections.add(makeConn("c-alice", alice));
    fx.connections.add(bob1);
    fx.connections.add(bob2);

    const conv = yield* createDm(fx.service, bob, alice);
    expect(bob1.conversationIds.has(conv.id)).toBe(true);
    expect(bob2.conversationIds.has(conv.id)).toBe(true);
  });
}

function createNoOpsForUnconnectedAgents() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob } = yield* seedAliceBob(fx);
    const aliceConn = makeConn("c-alice", alice);
    fx.connections.add(aliceConn);

    const conv = yield* createDm(fx.service, bob, alice);
    expect(aliceConn.conversationIds.has(conv.id)).toBe(true);
  });
}

function addParticipantSubscribesNewMember() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob, carol } = yield* seedAliceBobCarol(fx);
    fx.connections.add(makeConn("c-alice", alice));
    fx.connections.add(makeConn("c-bob", bob));

    const conv = yield* createNamedGroup(
      fx.service,
      PLANNING_NAME,
      [bob],
      alice,
    );
    const carolConn = makeConn("c-carol", carol);
    fx.connections.add(carolConn);
    expect(carolConn.conversationIds.has(conv.id)).toBe(false);

    yield* callAddParticipant(fx, conv.id, carol, alice);
    expect(carolConn.conversationIds.has(conv.id)).toBe(true);
  });
}

function addParticipantIsIdempotent() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob } = yield* seedAliceBob(fx);
    const bobConn = makeConn("c-bob", bob);
    fx.connections.add(makeConn("c-alice", alice));
    fx.connections.add(bobConn);

    const conv = yield* createNamedGroup(fx.service, TEAM_NAME, [bob], alice);
    const bobConvCountBefore = bobConn.conversationIds.size;
    yield* callAddParticipant(fx, conv.id, bob, alice);
    expect(bobConn.conversationIds.size).toBe(bobConvCountBefore);
    expect(bobConn.conversationIds.has(conv.id)).toBe(true);
  });
}

function archivedDmCreatesFreshConversation() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob } = yield* seedAliceBob(fx);
    const first = yield* createDm(fx.service, bob, alice);

    yield* fx.service.archive(first.id, alice);
    const second = yield* createDm(fx.service, bob, alice);
    expect(second.id).not.toBe(first.id);
  });
}

function liveDmDedupes() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob } = yield* seedAliceBob(fx);
    const first = yield* createDm(fx.service, bob, alice);
    const second = yield* createDm(fx.service, bob, alice);
    expect(second.id).toBe(first.id);
  });
}

function deniesDmWhenOwnersNotInContact() {
  return Effect.gen(function* () {
    const calls: Array<[string, string]> = [];
    const policy = recordingPolicy(calls, false);
    const fx = makeFixtureWithPolicy(policy);
    const { alice, bob } = yield* seedOwnedAliceBob(fx);

    const exit = yield* createDmExit(fx.service, bob, alice);
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(NotInContactsError.code);
    expect(failure.message).toMatch(CONTACT_POLICY_MESSAGE);
    expect(calls).toEqual([[OWNER_ALICE, OWNER_BOB]]);
  });
}

function createsDmWhenOwnersAreInContact() {
  return Effect.gen(function* () {
    const fx = makeFixtureWithPolicy(() => Effect.succeed(true));
    const { alice, bob } = yield* seedOwnedAliceBob(fx);
    const aliceConn = makeConn("c-alice", alice);
    const bobConn = makeConn("c-bob", bob);
    fx.connections.add(aliceConn);
    fx.connections.add(bobConn);

    const conv = yield* createDm(fx.service, bob, alice);
    expect(conv.type).toBe(CONV_TYPE_DM);
    expect(aliceConn.conversationIds.has(conv.id)).toBe(true);
    expect(bobConn.conversationIds.has(conv.id)).toBe(true);
  });
}

function deniesDmWhenParticipantOwnerMissing() {
  return Effect.gen(function* () {
    const fx = makeFixtureWithPolicy(() => Effect.succeed(true));
    const alice = yield* seedOwnedAgent(fx.auth, "alice", OWNER_ALICE);
    const bob = yield* seedAgent(fx.auth, "bob");
    const exit = yield* createDmExit(fx.service, bob, alice);
    expect(expectRpcFailure(exit).code).toBe(NotInContactsError.code);
  });
}

function permitsDmWhenNoPolicyConfigured() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob } = yield* seedAliceBob(fx);
    const conv = yield* createDm(fx.service, bob, alice);
    expect(conv.type).toBe(CONV_TYPE_DM);
  });
}

function existingDmSkipsPolicyRecheck() {
  return Effect.gen(function* () {
    const calls: Array<[string, string]> = [];
    const policy = recordingPolicy(calls, true);
    const fx = makeFixtureWithPolicy(policy);
    const { alice, bob } = yield* seedOwnedAliceBob(fx);

    const first = yield* createDm(fx.service, bob, alice);
    const second = yield* createDm(fx.service, bob, alice);
    expect(second.id).toBe(first.id);
    expect(calls.length).toBe(1);
  });
}

function deniesAutoDmWhenPolicyDenies() {
  return Effect.gen(function* () {
    const fx = makeFixtureWithPolicy(() => Effect.succeed(false));
    const alice = yield* seedOwnedAgent(fx.auth, "alice", OWNER_ALICE);
    yield* seedOwnedAgent(fx.auth, "bob", OWNER_BOB);

    const dmTaskId = yield* seedTask(alice);
    const exit = yield* Effect.exit(
      fx.service.createDmByAgentName(
        "bob",
        alice,
        Effect.succeed({ id: dmTaskId }),
      ),
    );
    expect(expectRpcFailure(exit).code).toBe(NotInContactsError.code);
  });
}

function deniesGroupWhenAnyEdgeFails() {
  return Effect.gen(function* () {
    const calls: Array<[string, string]> = [];
    const policy: ContactPolicyCheck = (left, right) =>
      Effect.sync(() => {
        calls.push([left, right]);
        return right !== OWNER_CAROL;
      });
    const fx = makeFixtureWithPolicy(policy);
    const { alice, bob, carol } = yield* seedOwnedAliceBobCarol(fx);

    const exit = yield* createNamedGroupExit(
      fx.service,
      PLANNING_NAME,
      [bob, carol],
      alice,
    );
    expect(expectRpcFailure(exit).code).toBe(NotInContactsError.code);
    expect(calls).toEqual([
      [OWNER_ALICE, OWNER_BOB],
      [OWNER_ALICE, OWNER_CAROL],
    ]);
  });
}

function createsGroupWhenEveryEdgeIsAllowed() {
  return Effect.gen(function* () {
    const fx = makeFixtureWithPolicy(() => Effect.succeed(true));
    const { alice, bob, carol } = yield* seedOwnedAliceBobCarol(fx);
    const conv = yield* createNamedGroup(
      fx.service,
      PLANNING_NAME,
      [bob, carol],
      alice,
    );
    expect(conv.type).toBe(CONV_TYPE_GROUP);
    expect(conv.name).toBe(PLANNING_NAME);
  });
}

function deniesGroupWhenMemberOwnerMissing() {
  return Effect.gen(function* () {
    const fx = makeFixtureWithPolicy(() => Effect.succeed(true));
    const alice = yield* seedOwnedAgent(fx.auth, "alice", OWNER_ALICE);
    const bob = yield* seedOwnedAgent(fx.auth, "bob", OWNER_BOB);
    const carol = yield* seedAgent(fx.auth, "carol");
    const exit = yield* createNamedGroupExit(
      fx.service,
      PLANNING_NAME,
      [bob, carol],
      alice,
    );
    expect(expectRpcFailure(exit).code).toBe(NotInContactsError.code);
  });
}

function deniesAddParticipantWhenPolicyDenies() {
  return Effect.gen(function* () {
    let denying = false;
    const policy: ContactPolicyCheck = (_left, right) =>
      Effect.sync(() => !denying || right !== OWNER_CAROL);
    const fx = makeFixtureWithPolicy(policy);
    const { alice, bob, carol } = yield* seedOwnedAliceBobCarol(fx);
    const conv = yield* createNamedGroup(
      fx.service,
      PLANNING_NAME,
      [bob],
      alice,
    );

    denying = true;
    const exit = yield* Effect.exit(
      callAddParticipant(fx, conv.id, carol, alice),
    );
    expect(expectRpcFailure(exit).code).toBe(NotInContactsError.code);
  });
}

function permitsAddParticipantWhenPolicyAllows() {
  return Effect.gen(function* () {
    const fx = makeFixtureWithPolicy(() => Effect.succeed(true));
    const { alice, bob, carol } = yield* seedOwnedAliceBobCarol(fx);
    const conv = yield* createNamedGroup(
      fx.service,
      PLANNING_NAME,
      [bob],
      alice,
    );
    const carolConn = makeConn("c-carol", carol);
    fx.connections.add(carolConn);

    const participant = yield* callAddParticipant(fx, conv.id, carol, alice);
    expect(participant.participant.id).toBe(carol);
    expect(carolConn.conversationIds.has(conv.id)).toBe(true);
  });
}

function deniesAddParticipantWhenOwnerMissing() {
  return Effect.gen(function* () {
    const fx = makeFixtureWithPolicy(() => Effect.succeed(true));
    const alice = yield* seedOwnedAgent(fx.auth, "alice", OWNER_ALICE);
    const bob = yield* seedOwnedAgent(fx.auth, "bob", OWNER_BOB);
    const carol = yield* seedAgent(fx.auth, "carol");
    const conv = yield* createNamedGroup(
      fx.service,
      PLANNING_NAME,
      [bob],
      alice,
    );

    const exit = yield* Effect.exit(
      callAddParticipant(fx, conv.id, carol, alice),
    );
    expect(expectRpcFailure(exit).code).toBe(NotInContactsError.code);
  });
}

function permitsAddParticipantWhenNoPolicyConfigured() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob, carol } = yield* seedAliceBobCarol(fx);
    const conv = yield* createNamedGroup(
      fx.service,
      PLANNING_NAME,
      [bob],
      alice,
    );
    const participant = yield* callAddParticipant(fx, conv.id, carol, alice);
    expect(participant.participant.id).toBe(carol);
  });
}

function rejectsAddParticipantOnDm() {
  return Effect.gen(function* () {
    const fx = makeFixtureWithPolicy(() => Effect.succeed(true));
    const { alice, bob, carol } = yield* seedOwnedAliceBobCarol(fx);
    const dm = yield* createDm(fx.service, bob, alice);
    expect(dm.type).toBe(CONV_TYPE_DM);

    const exit = yield* Effect.exit(
      callAddParticipant(fx, dm.id, carol, alice),
    );
    const failure = expectRpcFailure(exit);
    expect(failure.code).toBe(JSON_RPC_RESERVED_CODES.InvalidParams);
    expect(failure.message).toMatch(DM_MESSAGE);

    const agentIds = yield* participantAgentIds(dm.id);
    expect(agentIds).toEqual([alice, bob].sort());
  });
}

function creatorCanUpdateNonCreatorDenied() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob } = yield* seedAliceBob(fx);
    const conv = yield* createNamedGroup(fx.service, TEAM_NAME, [bob], alice);

    yield* fx.service.update(conv.id, RENAMED_NAME, alice);
    const exit = yield* Effect.exit(
      fx.service.update(conv.id, BOB_RENAME, bob),
    );
    expect(expectRpcFailure(exit).code).toBe(ForbiddenError.code);
  });
}

function creatorCanArchiveNonCreatorDenied() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob } = yield* seedAliceBob(fx);
    const conv = yield* createNamedGroup(fx.service, TEAM_NAME, [bob], alice);

    yield* fx.service.archive(conv.id, alice);
    yield* fx.service.unarchive(conv.id, alice);
    const denyArchive = yield* Effect.exit(fx.service.archive(conv.id, bob));
    expect(expectRpcFailure(denyArchive).code).toBe(ForbiddenError.code);
    const denyUnarchive = yield* Effect.exit(
      fx.service.unarchive(conv.id, bob),
    );
    expect(expectRpcFailure(denyUnarchive).code).toBe(ForbiddenError.code);
  });
}

function creatorCanRemoveParticipantNonCreatorDenied() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob, carol } = yield* seedAliceBobCarol(fx);
    const conv = yield* createNamedGroup(
      fx.service,
      TEAM_NAME,
      [bob, carol],
      alice,
    );

    const denyByBob = yield* Effect.exit(
      fx.service.removeParticipant(conv.id, carol, bob),
    );
    expect(expectRpcFailure(denyByBob).code).toBe(ForbiddenError.code);
    yield* fx.service.removeParticipant(conv.id, carol, alice);

    const rows = yield* participantAgentIds(conv.id);
    expect(rows).toEqual([alice, bob].sort());
  });
}

function missingConversationCollapsesToForbidden() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const alice = yield* seedAgent(fx.auth, "alice");
    const exit = yield* Effect.exit(
      fx.service.update(MISSING_CONVERSATION_ID, MISSING_UPDATE_NAME, alice),
    );
    expect(expectRpcFailure(exit).code).toBe(ForbiddenError.code);
  });
}

function addParticipantFansOutAddedNotification() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob, carol } = yield* seedAliceBobCarol(fx);
    const aliceSink: string[] = [];
    const bobSink: string[] = [];
    const carolSink: string[] = [];
    fx.connections.add(recordingConn("c-alice", alice, aliceSink));
    fx.connections.add(recordingConn("c-bob", bob, bobSink));

    const conv = yield* createNamedGroup(fx.service, TEAM_NAME, [bob], alice);
    aliceSink.length = 0;
    bobSink.length = 0;
    fx.connections.add(recordingConn("c-carol", carol, carolSink));

    yield* callAddParticipant(fx, conv.id, carol, alice);
    yield* settleBroadcasts();

    expect(
      aliceSink.some((frame) => frame.includes(PARTICIPANTS_ADDED_FRAGMENT)),
    ).toBe(true);
    expect(
      bobSink.some((frame) => frame.includes(PARTICIPANTS_ADDED_FRAGMENT)),
    ).toBe(true);
    expect(
      carolSink.some((frame) => frame.includes(PARTICIPANTS_ADDED_FRAGMENT)),
    ).toBe(true);
  });
}

function removeParticipantFansOutAndClearsSubscription() {
  return Effect.gen(function* () {
    const fx = makeFixture();
    const { alice, bob, carol } = yield* seedAliceBobCarol(fx);
    const aliceSink: string[] = [];
    const bobSink: string[] = [];
    const carolSink: string[] = [];
    const carolConn = recordingConn("c-carol", carol, carolSink);
    fx.connections.add(recordingConn("c-alice", alice, aliceSink));
    fx.connections.add(recordingConn("c-bob", bob, bobSink));
    fx.connections.add(carolConn);

    const conv = yield* createNamedGroup(
      fx.service,
      TEAM_NAME,
      [bob, carol],
      alice,
    );
    expect(carolConn.conversationIds.has(conv.id)).toBe(true);
    aliceSink.length = 0;
    bobSink.length = 0;
    carolSink.length = 0;

    yield* fx.service.removeParticipant(conv.id, carol, alice);
    yield* settleBroadcasts();

    expect(
      aliceSink.some((frame) => frame.includes(PARTICIPANTS_REMOVED_FRAGMENT)),
    ).toBe(true);
    expect(
      bobSink.some((frame) => frame.includes(PARTICIPANTS_REMOVED_FRAGMENT)),
    ).toBe(true);
    expect(
      carolSink.some((frame) => frame.includes(PARTICIPANTS_REMOVED_FRAGMENT)),
    ).toBe(true);
    expect(carolConn.conversationIds.has(conv.id)).toBe(false);
  });
}

describe("ConversationService.create auto-subscribes participants", () => {
  useHarnessLifecycle();

  it(
    "subscribes creator + every participant agent's open connections",
    subscribeCreatorAndParticipants,
  );
  it(
    "subscribes every socket of an agent that has multiple connections",
    subscribesEverySocketForAgent,
  );
  it(
    "is a no-op for agents without any open connection",
    createNoOpsForUnconnectedAgents,
  );
});

describe("ConversationService.addParticipant auto-subscribes the new member", () => {
  useHarnessLifecycle();

  it(
    "subscribes the new participant's open sockets to the existing conversation",
    addParticipantSubscribesNewMember,
  );
  it(
    "is idempotent: re-adding an already-member agent does not duplicate",
    addParticipantIsIdempotent,
  );
});

describe("ConversationService.create archived DM lookup", () => {
  useHarnessLifecycle();

  it(
    "does not reuse an archived DM; creates a fresh conversation instead",
    archivedDmCreatesFreshConversation,
  );
  it("still dedupes live DMs", liveDmDedupes);
});

describe("ConversationService.create contact policy on DMs", () => {
  useHarnessLifecycle();

  it(
    "denies DM creation when owners are not in contact",
    deniesDmWhenOwnersNotInContact,
  );
  it(
    "creates the DM when owners are in contact",
    createsDmWhenOwnersAreInContact,
  );
  it(
    "denies the DM when either agent has no owner_user_id",
    deniesDmWhenParticipantOwnerMissing,
  );
  it(
    "permits DMs when no policy is configured",
    permitsDmWhenNoPolicyConfigured,
  );
  it(
    "returns the existing DM without re-checking policy",
    existingDmSkipsPolicyRecheck,
  );
  it(
    "denies messages/send auto-DM when policy denies the edge",
    deniesAutoDmWhenPolicyDenies,
  );
  it(
    "invokes contact policy with the ordered owner pair",
    policyInvocationProperty,
  );
});

describe("ConversationService.create contact policy on groups", () => {
  useHarnessLifecycle();

  it(
    "denies group creation when any creator/member edge fails",
    deniesGroupWhenAnyEdgeFails,
  );
  it(
    "creates the group when every creator/member edge is allowed",
    createsGroupWhenEveryEdgeIsAllowed,
  );
  it(
    "denies the group when any member is owner-less",
    deniesGroupWhenMemberOwnerMissing,
  );
});

describe("ConversationService.addParticipant contact policy", () => {
  useHarnessLifecycle();

  it(
    "denies adding a participant when requester/target edge is denied",
    deniesAddParticipantWhenPolicyDenies,
  );
  it(
    "permits addParticipant when policy allows the edge",
    permitsAddParticipantWhenPolicyAllows,
  );
  it(
    "denies addParticipant when either side has no owner_user_id",
    deniesAddParticipantWhenOwnerMissing,
  );
  it(
    "permits addParticipant when no policy is configured",
    permitsAddParticipantWhenNoPolicyConfigured,
  );
  it(
    "invokes contact policy with the ordered owner pair",
    policyInvocationProperty,
  );
});

describe("ConversationService.addParticipant rejects DM conversations", () => {
  useHarnessLifecycle();

  it(
    "rejects addParticipant on a DM with InvalidParams and leaves participants unchanged",
    rejectsAddParticipantOnDm,
  );
});

describe("ConversationService admin authority", () => {
  useHarnessLifecycle();

  it(
    "creator can update; non-creator member is denied",
    creatorCanUpdateNonCreatorDenied,
  );
  it(
    "creator can archive + unarchive; non-creator member is denied",
    creatorCanArchiveNonCreatorDenied,
  );
  it(
    "creator can remove a participant; non-creator is denied",
    creatorCanRemoveParticipantNonCreatorDenied,
  );
  it(
    "missing conversation collapses to ForbiddenError",
    missingConversationCollapsesToForbidden,
  );
  it(
    "invokes contact policy with the ordered owner pair",
    policyInvocationProperty,
  );
});

describe("ConversationService participant fan-out", () => {
  useHarnessLifecycle();

  it(
    "addParticipant fires participants/added to every post-insert participant",
    addParticipantFansOutAddedNotification,
    PGLITE_HOOK_TIMEOUT_MS,
  );
  it(
    "removeParticipant fires participants/removed and clears removed agent subscriptions",
    removeParticipantFansOutAndClearsSubscription,
    PGLITE_HOOK_TIMEOUT_MS,
  );
});
