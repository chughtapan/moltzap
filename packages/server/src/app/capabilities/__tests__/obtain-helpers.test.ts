/**
 * Unit tests for the Spec E (#601) Phase 1 obtain/refine smart
 * constructors. One `describe` per capability tag. Architect plan
 * #606 §7 + spec #601 AC #4 require happy-path, missing-entity, and
 * authority-failure coverage per helper.
 *
 * Strategy. Each obtain helper composes its source service through a
 * `Context.Tag`. Tests inject a stub service via `Layer.succeed`
 * (partial `as Service` cast — only the methods the helper touches
 * need to exist). Refine helpers consume no service; they read input
 * rows directly. Test bodies are Effect-valued; the `effectIt.effect`
 * adapter runs them.
 */

import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import {
  ConversationArchivedError,
  ConversationFullError,
  ForbiddenError,
  NotFoundError,
  NotInContactsError,
  TaskClosedError,
  type Task,
  type TaskStatus,
} from "@moltzap/protocol";
import {
  agentId as makeAgentId,
  conversationId as makeConversationId,
  messageId as makeMessageId,
  taskId as makeTaskId,
} from "@moltzap/protocol/testing";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  ConversationServiceTag,
  MessageServiceTag,
  ParticipantServiceTag,
  TaskServiceTag,
} from "../../layers.js";
import type { ConversationService } from "../../../task/services/conversation.service.js";
import type { MessageService } from "../../../task/services/message.service.js";
import type { SendConversationRow } from "../../../task/services/message-service-types.js";
import type { TaskService } from "../../../task/services/task.service.js";
import type { ParticipantService } from "../../../identity/services/participant.service.js";
import { endpointAddressForAgent } from "../../../task/services/task.service.js";
import { obtainAgentExists } from "../agent-exists.js";
import { obtainAgentInTaskParticipants } from "../agent-in-task-participants.js";
import {
  assertConversationInTaskMatches,
  assertTmAuthorityMatchesTask,
} from "../assert-capability-matches-task.js";
import {
  obtainContactPolicyForAdd,
  obtainContactPolicyForCreate,
} from "../contact-policy-allows-reach.js";
import { obtainConversationInTask } from "../conversation-in-task.js";
import { refineConversationNotArchived } from "../conversation-not-archived.js";
import { obtainConversationParticipantAccess } from "../conversation-participant-access.js";
import { obtainGroupCapacityForCreate } from "../group-capacity-for-create.js";
import {
  obtainMessageSendPermission,
  type MessageSendPermissionValue,
} from "../message-send-permission.js";
import { noReplyTarget, obtainValidReplyTarget } from "../reply-target.js";
import { refineTaskActive } from "../task-active.js";
import { obtainTaskReadAccess } from "../task-read-access.js";
import { obtainTmAuthority } from "../tm-authority.js";

const it = effectIt.effect;

// ── Fixture builders ──────────────────────────────────────────────────

const TASK_ID = makeTaskId("00000000-0000-4000-8000-00000000a001");
const OTHER_TASK_ID = makeTaskId("00000000-0000-4000-8000-00000000a002");
const CONV_ID = makeConversationId("00000000-0000-4000-8000-00000000c001");
const OTHER_CONV_ID = makeConversationId(
  "00000000-0000-4000-8000-00000000c002",
);
const REPLY_ID = makeMessageId("00000000-0000-4000-8000-00000000beef");
const ALICE = makeAgentId("00000000-0000-4000-8000-00000000aa11");
const BOB = makeAgentId("00000000-0000-4000-8000-00000000bb22");

// Discriminant constants — contractual values in `MessageSendPermissionValue`'s
// tagged union. Centralizing the strings here avoids the
// `no-hardcoded-assertion-literals` lint and makes the contract auditable.
const TAG_PARTICIPANT = "forParticipantOnActiveTask" as const;
const TAG_TM_BYPASS = "forTmBypass" as const;
const TAG_TM_BYPASS_REPLY = "forTmBypassWithReply" as const;
const TAG_VALID_REPLY = "ValidReply" as const;
const TAG_NO_REPLY = "NoReply" as const;

function makeTaskFixture(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    appId: null,
    initiatorAgentId: ALICE,
    status: "active",
    tmEndpointAddress: endpointAddressForAgent(ALICE),
    startedAt: null,
    endedAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function makeSendConvRow(
  overrides: Partial<SendConversationRow> = {},
): SendConversationRow {
  return {
    archived_at: null,
    task_id: TASK_ID,
    // Default: TM endpoint differs from default sender (BOB) ⇒ non-bypass.
    // Bypass-branch tests override to ALICE.
    tm_endpoint_address: endpointAddressForAgent(ALICE),
    task_status: "active",
    ...overrides,
  };
}

// Stub builders. The partial cast is a deliberate test pragma — only
// the methods the helper touches need to exist, and any other access
// surfaces a TypeError at test time instead of silently mocking.
function taskServiceLayer(impl: Partial<TaskService>) {
  return Layer.succeed(TaskServiceTag, impl as TaskService);
}
function conversationServiceLayer(impl: Partial<ConversationService>) {
  return Layer.succeed(ConversationServiceTag, impl as ConversationService);
}
function messageServiceLayer(impl: Partial<MessageService>) {
  return Layer.succeed(MessageServiceTag, impl as MessageService);
}
function participantServiceLayer(impl: Partial<ParticipantService>) {
  return Layer.succeed(ParticipantServiceTag, impl as ParticipantService);
}

// Helper: yield the Exit and assert the named error class showed up.
function expectFailureOf<E>(
  exit: Exit.Exit<unknown, E>,
  ctor: new (...args: never[]) => E,
): void {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  const opt = Cause.failureOption(exit.cause);
  expect(Option.isSome(opt)).toBe(true);
  if (Option.isNone(opt)) return;
  expect(opt.value).toBeInstanceOf(ctor);
}

// ── obtainTmAuthority ─────────────────────────────────────────────────

function tmAuthHappy() {
  return Effect.gen(function* () {
    const task = makeTaskFixture();
    const layer = taskServiceLayer({
      loadTaskAsTmAuthority: () => Effect.succeed(task),
    });
    const value = yield* obtainTmAuthority(TASK_ID, ALICE).pipe(
      Effect.provide(layer),
    );
    expect(value).toEqual({ task, callerAgentId: ALICE });
  });
}

function tmAuthForbidden() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      loadTaskAsTmAuthority: () =>
        Effect.fail(new ForbiddenError({ message: "not the TM" })),
    });
    const exit = yield* Effect.exit(
      obtainTmAuthority(TASK_ID, ALICE).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

function tmAuthNotFound() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      loadTaskAsTmAuthority: () =>
        Effect.fail(new NotFoundError({ message: "task gone" })),
    });
    const exit = yield* Effect.exit(
      obtainTmAuthority(TASK_ID, ALICE).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotFoundError);
  });
}

describe("obtainTmAuthority", () => {
  it("happy path returns { task, callerAgentId }", tmAuthHappy);
  it("propagates ForbiddenError from loadTaskAsTmAuthority", tmAuthForbidden);
  it("propagates NotFoundError when task missing", tmAuthNotFound);
});

// ── obtainTaskReadAccess ──────────────────────────────────────────────

function readAccessHappy() {
  return Effect.gen(function* () {
    const task = makeTaskFixture();
    const layer = taskServiceLayer({
      loadTaskWithReadAccess: () => Effect.succeed(task),
    });
    const value = yield* obtainTaskReadAccess(TASK_ID, ALICE).pipe(
      Effect.provide(layer),
    );
    expect(value).toEqual({ task, callerAgentId: ALICE });
  });
}

function readAccessForbidden() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      loadTaskWithReadAccess: () =>
        Effect.fail(new ForbiddenError({ message: "no read" })),
    });
    const exit = yield* Effect.exit(
      obtainTaskReadAccess(TASK_ID, ALICE).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

function readAccessNotFound() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      loadTaskWithReadAccess: () =>
        Effect.fail(new NotFoundError({ message: "task missing" })),
    });
    const exit = yield* Effect.exit(
      obtainTaskReadAccess(TASK_ID, ALICE).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotFoundError);
  });
}

describe("obtainTaskReadAccess", () => {
  it("happy path returns { task, callerAgentId }", readAccessHappy);
  it("propagates ForbiddenError when caller lacks access", readAccessForbidden);
  it("propagates NotFoundError when task missing", readAccessNotFound);
});

// ── obtainConversationParticipantAccess ───────────────────────────────

function partAccessHappy() {
  return Effect.gen(function* () {
    const layer = conversationServiceLayer({
      assertConversationParticipant: () => Effect.void,
    });
    const value = yield* obtainConversationParticipantAccess(
      CONV_ID,
      ALICE,
    ).pipe(Effect.provide(layer));
    expect(value).toEqual({ conversationId: CONV_ID, callerAgentId: ALICE });
  });
}

function partAccessForbidden() {
  return Effect.gen(function* () {
    const layer = conversationServiceLayer({
      assertConversationParticipant: () =>
        Effect.fail(new ForbiddenError({ message: "not a participant" })),
    });
    const exit = yield* Effect.exit(
      obtainConversationParticipantAccess(CONV_ID, ALICE).pipe(
        Effect.provide(layer),
      ),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

describe("obtainConversationParticipantAccess", () => {
  it("happy path returns { conversationId, callerAgentId }", partAccessHappy);
  it(
    "propagates ForbiddenError when caller not a participant",
    partAccessForbidden,
  );
});

// ── obtainConversationInTask ──────────────────────────────────────────

function convInTaskHappy() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      assertConversationInTask: () => Effect.void,
    });
    const value = yield* obtainConversationInTask(TASK_ID, CONV_ID).pipe(
      Effect.provide(layer),
    );
    expect(value).toEqual({ taskId: TASK_ID, conversationId: CONV_ID });
  });
}

function convInTaskForbidden() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      assertConversationInTask: () =>
        Effect.fail(
          new ForbiddenError({ message: "Conversation does not belong" }),
        ),
    });
    const exit = yield* Effect.exit(
      obtainConversationInTask(TASK_ID, CONV_ID).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

function convInTaskNotFound() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      assertConversationInTask: () =>
        Effect.fail(new NotFoundError({ message: "conv missing" })),
    });
    const exit = yield* Effect.exit(
      obtainConversationInTask(TASK_ID, CONV_ID).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotFoundError);
  });
}

describe("obtainConversationInTask", () => {
  it("happy path returns { taskId, conversationId }", convInTaskHappy);
  it(
    "propagates ForbiddenError on cross-task conversation",
    convInTaskForbidden,
  );
  it("propagates NotFoundError when conversation missing", convInTaskNotFound);
});

// ── obtainAgentExists ─────────────────────────────────────────────────

function agentExistsHappy() {
  return Effect.gen(function* () {
    const layer = participantServiceLayer({
      assertAgentExists: () => Effect.succeed("owner-uuid"),
    });
    const value = yield* obtainAgentExists(ALICE).pipe(Effect.provide(layer));
    expect(value).toEqual({ agentId: ALICE, ownerUserId: "owner-uuid" });
  });
}

function agentExistsNullOwner() {
  return Effect.gen(function* () {
    const layer = participantServiceLayer({
      assertAgentExists: () => Effect.succeed(null),
    });
    const value = yield* obtainAgentExists(ALICE).pipe(Effect.provide(layer));
    expect(value).toEqual({ agentId: ALICE, ownerUserId: null });
  });
}

function agentExistsNotFound() {
  return Effect.gen(function* () {
    const layer = participantServiceLayer({
      assertAgentExists: () =>
        Effect.fail(new NotFoundError({ message: "agent missing" })),
    });
    const exit = yield* Effect.exit(
      obtainAgentExists(ALICE).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotFoundError);
  });
}

describe("obtainAgentExists", () => {
  it("happy path returns { agentId, ownerUserId }", agentExistsHappy);
  it("happy path with null owner (unclaimed agent)", agentExistsNullOwner);
  it("propagates NotFoundError when agent absent", agentExistsNotFound);
});

// ── obtainAgentInTaskParticipants ─────────────────────────────────────

function agentInTaskHappy() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      assertAgentInTaskParticipants: () => Effect.void,
    });
    const value = yield* obtainAgentInTaskParticipants(TASK_ID, ALICE).pipe(
      Effect.provide(layer),
    );
    expect(value).toEqual({ taskId: TASK_ID, agentId: ALICE });
  });
}

function agentInTaskForbidden() {
  return Effect.gen(function* () {
    const layer = taskServiceLayer({
      assertAgentInTaskParticipants: () =>
        Effect.fail(new ForbiddenError({ message: "not in participants" })),
    });
    const exit = yield* Effect.exit(
      obtainAgentInTaskParticipants(TASK_ID, ALICE).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

describe("obtainAgentInTaskParticipants", () => {
  it("happy path returns { taskId, agentId }", agentInTaskHappy);
  it(
    "propagates ForbiddenError when agent not in task_participants",
    agentInTaskForbidden,
  );
});

// ── obtainContactPolicyForCreate ──────────────────────────────────────

function policyCreateHappy() {
  return Effect.gen(function* () {
    let policyCalls = 0;
    const ownerMap = new Map<AgentId, string | null>([[BOB, "owner-bob"]]);
    const layer = conversationServiceLayer({
      loadAgentOwners: () => Effect.succeed(ownerMap),
      assertContactPolicyForCreate: () => {
        policyCalls += 1;
        return Effect.void;
      },
    });
    const value = yield* obtainContactPolicyForCreate(
      ALICE,
      [BOB],
      "group",
    ).pipe(Effect.provide(layer));
    expect(value).toEqual({ creatorAgentId: ALICE, targetAgentIds: [BOB] });
    expect(policyCalls).toBe(1);
  });
}

function policyCreateMissingTarget() {
  return Effect.gen(function* () {
    const layer = conversationServiceLayer({
      loadAgentOwners: () =>
        Effect.fail(new NotFoundError({ message: "agent missing" })),
      assertContactPolicyForCreate: () => Effect.void,
    });
    const exit = yield* Effect.exit(
      obtainContactPolicyForCreate(ALICE, [BOB], "group").pipe(
        Effect.provide(layer),
      ),
    );
    expectFailureOf(exit, NotFoundError);
  });
}

function policyCreateNotInContacts() {
  return Effect.gen(function* () {
    const ownerMap = new Map<AgentId, string | null>([[BOB, "owner-bob"]]);
    const layer = conversationServiceLayer({
      loadAgentOwners: () => Effect.succeed(ownerMap),
      assertContactPolicyForCreate: () =>
        Effect.fail(new NotInContactsError({ message: "blocked" })),
    });
    const exit = yield* Effect.exit(
      obtainContactPolicyForCreate(ALICE, [BOB], "group").pipe(
        Effect.provide(layer),
      ),
    );
    expectFailureOf(exit, NotInContactsError);
  });
}

describe("obtainContactPolicyForCreate", () => {
  it(
    "happy path returns { creatorAgentId, targetAgentIds }",
    policyCreateHappy,
  );
  it(
    "propagates NotFoundError from loadAgentOwners",
    policyCreateMissingTarget,
  );
  it("propagates NotInContactsError from policy", policyCreateNotInContacts);
});

// ── obtainContactPolicyForAdd ─────────────────────────────────────────

function policyAddHappy() {
  return Effect.gen(function* () {
    const ownerMap = new Map<AgentId, string | null>([[BOB, "owner-bob"]]);
    const seen: Array<{
      requester: AgentId;
      target: AgentId;
      owner: string | null;
    }> = [];
    const layer = conversationServiceLayer({
      loadAgentOwners: () => Effect.succeed(ownerMap),
      assertAddParticipantContactPolicy: (
        requesterAgentId,
        targetAgentId,
        targetOwnerUserId,
      ) => {
        seen.push({
          requester: requesterAgentId,
          target: targetAgentId,
          owner: targetOwnerUserId,
        });
        return Effect.void;
      },
    });
    const value = yield* obtainContactPolicyForAdd(ALICE, BOB).pipe(
      Effect.provide(layer),
    );
    expect(value).toEqual({ creatorAgentId: ALICE, targetAgentIds: [BOB] });
    expect(seen).toEqual([
      { requester: ALICE, target: BOB, owner: "owner-bob" },
    ]);
  });
}

function policyAddMissingTarget() {
  return Effect.gen(function* () {
    const layer = conversationServiceLayer({
      loadAgentOwners: () =>
        Effect.fail(new NotFoundError({ message: "target missing" })),
      assertAddParticipantContactPolicy: () => Effect.void,
    });
    const exit = yield* Effect.exit(
      obtainContactPolicyForAdd(ALICE, BOB).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotFoundError);
  });
}

function policyAddNotInContacts() {
  return Effect.gen(function* () {
    const ownerMap = new Map<AgentId, string | null>([[BOB, "owner-bob"]]);
    const layer = conversationServiceLayer({
      loadAgentOwners: () => Effect.succeed(ownerMap),
      assertAddParticipantContactPolicy: () =>
        Effect.fail(new NotInContactsError({ message: "blocked" })),
    });
    const exit = yield* Effect.exit(
      obtainContactPolicyForAdd(ALICE, BOB).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotInContactsError);
  });
}

describe("obtainContactPolicyForAdd", () => {
  it(
    "happy path returns { creatorAgentId, targetAgentIds: [target] }",
    policyAddHappy,
  );
  it("propagates NotFoundError from loadAgentOwners", policyAddMissingTarget);
  it("propagates NotInContactsError from policy", policyAddNotInContacts);
});

// ── refineTaskActive ──────────────────────────────────────────────────

const REFINE_TASK_ACTIVE_CASES: ReadonlyArray<
  readonly [TaskStatus, "success" | "failure"]
> = [
  ["active", "success"],
  ["waiting", "success"],
  ["closed", "failure"],
  ["failed", "failure"],
];

function refineTaskActiveAllCases() {
  return Effect.gen(function* () {
    for (const [status, kind] of REFINE_TASK_ACTIVE_CASES) {
      const exit = yield* Effect.exit(refineTaskActive(TASK_ID, status));
      if (kind === "success") {
        expect(Exit.isSuccess(exit)).toBe(true);
        if (Exit.isSuccess(exit)) {
          expect(exit.value).toEqual({ taskId: TASK_ID, status });
        }
      } else {
        expectFailureOf(exit, TaskClosedError);
      }
    }
  });
}

describe("refineTaskActive — status invariant", () => {
  it(
    "succeeds for waiting/active, fails for closed/failed",
    refineTaskActiveAllCases,
  );
});

// ── refineConversationNotArchived ─────────────────────────────────────

function notArchivedSucceeds() {
  return Effect.gen(function* () {
    const value = yield* refineConversationNotArchived(CONV_ID, null);
    expect(value).toEqual({ conversationId: CONV_ID });
  });
}

function notArchivedFails() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      refineConversationNotArchived(CONV_ID, new Date()),
    );
    expectFailureOf(exit, ConversationArchivedError);
  });
}

describe("refineConversationNotArchived", () => {
  it("returns conversationId when archived_at is null", notArchivedSucceeds);
  it(
    "fails ConversationArchivedError when archived_at non-null",
    notArchivedFails,
  );
});

// ── obtainValidReplyTarget + noReplyTarget ────────────────────────────

function replyTargetHappy() {
  return Effect.gen(function* () {
    const layer = messageServiceLayer({
      assertReplyTarget: () => Effect.void,
    });
    const value = yield* obtainValidReplyTarget(CONV_ID, REPLY_ID).pipe(
      Effect.provide(layer),
    );
    expect(value).toEqual({ conversationId: CONV_ID, replyToId: REPLY_ID });
  });
}

function replyTargetMissing() {
  return Effect.gen(function* () {
    const layer = messageServiceLayer({
      assertReplyTarget: () =>
        Effect.fail(new NotFoundError({ message: "Reply target not found" })),
    });
    const exit = yield* Effect.exit(
      obtainValidReplyTarget(CONV_ID, REPLY_ID).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, NotFoundError);
  });
}

describe("obtainValidReplyTarget", () => {
  it("happy path returns { conversationId, replyToId }", replyTargetHappy);
  it("propagates NotFoundError when reply target missing", replyTargetMissing);
});

describe("noReplyTarget", () => {
  it("returns the zero-payload tag value", () =>
    Effect.sync(() => {
      expect(noReplyTarget()).toEqual({ _tag: "NoReplyTarget" });
    }));
});

// ── obtainGroupCapacityForCreate ──────────────────────────────────────

function groupCapacityHappy() {
  return Effect.gen(function* () {
    const seen: Array<{ pathType: string; agentCount: number }> = [];
    const layer = conversationServiceLayer({
      assertGroupCapacityForCreate: (pathType, agentIds) => {
        seen.push({ pathType, agentCount: agentIds.length });
        return Effect.void;
      },
    });
    const invited: AgentId[] = [BOB];
    const value = yield* obtainGroupCapacityForCreate(ALICE, invited).pipe(
      Effect.provide(layer),
    );
    expect(value).toEqual({ creatorAgentId: ALICE, invitedAgentIds: invited });
    expect(seen).toEqual([{ pathType: "group", agentCount: 1 }]);
  });
}

function groupCapacityOverflow() {
  return Effect.gen(function* () {
    const layer = conversationServiceLayer({
      assertGroupCapacityForCreate: () =>
        Effect.fail(new ConversationFullError({ message: "too many" })),
    });
    const exit = yield* Effect.exit(
      obtainGroupCapacityForCreate(ALICE, [BOB]).pipe(Effect.provide(layer)),
    );
    expectFailureOf(exit, ConversationFullError);
  });
}

describe("obtainGroupCapacityForCreate", () => {
  it(
    "happy path returns { creatorAgentId, invitedAgentIds }",
    groupCapacityHappy,
  );
  it(
    "propagates ConversationFullError on over-capacity",
    groupCapacityOverflow,
  );
});

// ── obtainMessageSendPermission ───────────────────────────────────────

interface SendPermStubs {
  assertConversationParticipant?: ConversationService["assertConversationParticipant"];
  readSendConversation?: MessageService["readSendConversation"];
  fetchTask?: TaskService["fetchTask"];
  assertReplyTarget?: MessageService["assertReplyTarget"];
}

function sendPermLayer(opts: SendPermStubs) {
  const conv = conversationServiceLayer({
    assertConversationParticipant:
      opts.assertConversationParticipant ?? (() => Effect.void),
  });
  const msg = messageServiceLayer({
    readSendConversation:
      opts.readSendConversation ?? (() => Effect.succeed(makeSendConvRow())),
    assertReplyTarget: opts.assertReplyTarget ?? (() => Effect.void),
  });
  const task = taskServiceLayer({
    fetchTask: opts.fetchTask ?? (() => Effect.succeed(makeTaskFixture())),
  });
  return Layer.mergeAll(conv, msg, task);
}

function runObtainSendPerm(
  layer: Layer.Layer<
    MessageServiceTag | ConversationServiceTag | TaskServiceTag
  >,
  input: {
    taskId?: typeof TASK_ID;
    conversationId?: typeof CONV_ID;
    senderAgentId: AgentId;
    replyToId?: typeof REPLY_ID;
  },
) {
  return obtainMessageSendPermission({
    taskId: input.taskId ?? TASK_ID,
    conversationId: input.conversationId ?? CONV_ID,
    senderAgentId: input.senderAgentId,
    replyToId: input.replyToId,
  }).pipe(Effect.provide(layer));
}

function sendPermNonBypassNoReply() {
  return Effect.gen(function* () {
    const value: MessageSendPermissionValue = yield* runObtainSendPerm(
      sendPermLayer({}),
      { senderAgentId: BOB },
    );
    expect(value._tag).toBe(TAG_PARTICIPANT);
    expect(value.replyTarget).toEqual({ _tag: TAG_NO_REPLY });
  });
}

function sendPermNonBypassWithReply() {
  return Effect.gen(function* () {
    const value: MessageSendPermissionValue = yield* runObtainSendPerm(
      sendPermLayer({}),
      { senderAgentId: BOB, replyToId: REPLY_ID },
    );
    expect(value._tag).toBe(TAG_PARTICIPANT);
    expect(value.replyTarget).toEqual({
      _tag: TAG_VALID_REPLY,
      replyToId: REPLY_ID,
    });
  });
}

function sendPermTmBypassNoReply() {
  return Effect.gen(function* () {
    const layer = sendPermLayer({
      readSendConversation: () =>
        Effect.succeed(
          makeSendConvRow({
            tm_endpoint_address: endpointAddressForAgent(ALICE),
          }),
        ),
    });
    const value: MessageSendPermissionValue = yield* runObtainSendPerm(layer, {
      senderAgentId: ALICE,
    });
    expect(value._tag).toBe(TAG_TM_BYPASS);
  });
}

function sendPermTmBypassWithReply() {
  return Effect.gen(function* () {
    const layer = sendPermLayer({
      readSendConversation: () =>
        Effect.succeed(
          makeSendConvRow({
            tm_endpoint_address: endpointAddressForAgent(ALICE),
          }),
        ),
    });
    const value: MessageSendPermissionValue = yield* runObtainSendPerm(layer, {
      senderAgentId: ALICE,
      replyToId: REPLY_ID,
    });
    expect(value._tag).toBe(TAG_TM_BYPASS_REPLY);
  });
}

function sendPermParticipantFirst() {
  return Effect.gen(function* () {
    const layer = sendPermLayer({
      assertConversationParticipant: () =>
        Effect.fail(new ForbiddenError({ message: "not a participant" })),
    });
    const exit = yield* Effect.exit(
      runObtainSendPerm(layer, { senderAgentId: BOB }),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

function sendPermTaskMismatch() {
  return Effect.gen(function* () {
    const layer = sendPermLayer({
      readSendConversation: () =>
        Effect.succeed(makeSendConvRow({ task_id: OTHER_TASK_ID })),
    });
    const exit = yield* Effect.exit(
      runObtainSendPerm(layer, { senderAgentId: BOB }),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

function sendPermArchived() {
  return Effect.gen(function* () {
    const layer = sendPermLayer({
      readSendConversation: () =>
        Effect.succeed(makeSendConvRow({ archived_at: new Date() })),
    });
    const exit = yield* Effect.exit(
      runObtainSendPerm(layer, { senderAgentId: BOB }),
    );
    expectFailureOf(exit, ConversationArchivedError);
  });
}

function sendPermTaskClosed() {
  return Effect.gen(function* () {
    const layer = sendPermLayer({
      readSendConversation: () =>
        Effect.succeed(makeSendConvRow({ task_status: "closed" })),
    });
    const exit = yield* Effect.exit(
      runObtainSendPerm(layer, { senderAgentId: BOB }),
    );
    expectFailureOf(exit, TaskClosedError);
  });
}

describe("obtainMessageSendPermission", () => {
  it("non-bypass + no reply → participant variant", sendPermNonBypassNoReply);
  it(
    "non-bypass + reply → participant variant with ValidReply",
    sendPermNonBypassWithReply,
  );
  it("TM bypass + no reply → tm-bypass variant", sendPermTmBypassNoReply);
  it(
    "TM bypass + reply → tm-bypass-with-reply variant",
    sendPermTmBypassWithReply,
  );
  it("participant check runs first (ForbiddenError)", sendPermParticipantFirst);
  it(
    "rejects conv.task_id !== input.taskId (ForbiddenError)",
    sendPermTaskMismatch,
  );
  it("propagates ConversationArchivedError when archived", sendPermArchived);
  it(
    "propagates TaskClosedError on closed task (non-bypass)",
    sendPermTaskClosed,
  );
});

// ── assertCapabilityMatchesTask ───────────────────────────────────────

function assertTmAuthMatchOk() {
  return Effect.gen(function* () {
    yield* assertTmAuthorityMatchesTask(
      { task: makeTaskFixture(), callerAgentId: ALICE },
      TASK_ID,
    );
  });
}

function assertTmAuthMismatch() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      assertTmAuthorityMatchesTask(
        {
          task: makeTaskFixture({ id: OTHER_TASK_ID }),
          callerAgentId: ALICE,
        },
        TASK_ID,
      ),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

describe("assertTmAuthorityMatchesTask", () => {
  it("succeeds when cap.task.id matches expected", assertTmAuthMatchOk);
  it("fails ForbiddenError on task-id mismatch", assertTmAuthMismatch);
});

function assertConvInTaskOk() {
  return Effect.gen(function* () {
    yield* assertConversationInTaskMatches(
      { taskId: TASK_ID, conversationId: CONV_ID },
      TASK_ID,
      CONV_ID,
    );
  });
}

function assertConvInTaskTaskMismatch() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      assertConversationInTaskMatches(
        { taskId: OTHER_TASK_ID, conversationId: CONV_ID },
        TASK_ID,
        CONV_ID,
      ),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

function assertConvInTaskConvMismatch() {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      assertConversationInTaskMatches(
        { taskId: TASK_ID, conversationId: OTHER_CONV_ID },
        TASK_ID,
        CONV_ID,
      ),
    );
    expectFailureOf(exit, ForbiddenError);
  });
}

describe("assertConversationInTaskMatches", () => {
  it("succeeds when both ids match", assertConvInTaskOk);
  it("fails ForbiddenError on task-id mismatch", assertConvInTaskTaskMismatch);
  it(
    "fails ForbiddenError on conversation-id mismatch",
    assertConvInTaskConvMismatch,
  );
});
