/** @file Message admission through real Client storage and send preparation. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { scopedLive as it } from "@effect/vitest";
import {
  AgentCard,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
} from "@moltzap/identity";
import { RouterInstanceId } from "@moltzap/router";
import { Deferred, Effect, Fiber, Queue, Schema, Scope } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { expect } from "vitest";
import {
  digest,
  identifier,
  issueTestCard,
  makeTestAuthority,
} from "../__tests__/agent-card-fixtures.js";
import {
  buildCertifiedGenesis,
  storeCertifiedGenesis,
} from "../__tests__/certified-history-fixtures.js";
import { decodeAudit } from "../__tests__/firewall-audit-fixtures.js";
import { pollCursor } from "../__tests__/router-worker-fixtures.js";
import { stateDirectory } from "../__tests__/store-schema-fixtures.js";
import { FirewallSendError } from "../firewall/runtime.js";
import {
  type MessageMiddleware,
  MiddlewareError,
  type MiddlewareInput,
  type MiddlewareResult,
} from "../firewall/values.js";
import {
  decodeRuntimeValue,
  DeliveryToken,
  encodeRuntimeValue,
  type EndpointStore,
  openEndpointStore,
} from "../store/index.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import { makeCollectiveOperations } from "../transport/collectives/index.js";
import { makeEndpointEngine } from "../transport/messaging/index.js";
import { InboundMessage } from "../transport/messaging/message.js";
import {
  AgentAddress,
  deriveConversationId,
  encodeCanonical,
  MembershipDescriptor,
  RecordHash,
  verifyMembershipDescriptor,
} from "../transport/wire/index.js";
import { beginFirewallAudit } from "./firewall-audit.js";
import {
  type FirewallOptions,
  installFirewall,
  sendWithFirewall,
} from "./firewall.js";
import { noHistoryExport } from "./history-export.js";
import { makeHostDelivery } from "./host-delivery.js";
import { eventIdOf, type HarnessMessageReadyEvent } from "./operations.js";

// @agent-code-guard/regression-only: Exercises durable admission, replay, interruption and races through SQLite and the protocol engine.

const rule = {
  id: "communication",
  kind: "norm",
  guidance: "Answer the open scheduling question.",
  feedback: {
    nextAction: "revise",
    text: "Include all required participants.",
  },
} as const;
const pass: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "pass" }],
  expectations: [],
};
const block: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "block" }],
  expectations: [],
};
const revise: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "revise" }],
  expectations: [],
};
const waitAction = "wait";
const renderedWaitAction = `Next action: ${waitAction}.`;
const settings = {
  timeoutMilliseconds: 10_000,
  middlewareTimeoutMilliseconds: 8_000,
  maximumInputBytes: 1_000_000,
  maximumResultBytes: 100_000,
};
const destination = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
const anchor = {
  routerInstanceId: Schema.decodeUnknownSync(RouterInstanceId)(
    identifier("rti_", 10),
  ),
  pollCursor: pollCursor(11),
};

const identities = Effect.gen(function* () {
  const registryKeys = generateKeyPairSync("ed25519");
  const localAuthority = yield* makeTestAuthority();
  const remoteAuthority = yield* makeTestAuthority();
  const local = {
    authority: localAuthority,
    card: yield* issueTestCard({
      byte: 1,
      name: "alice",
      authority: localAuthority,
      registryKeys,
    }),
  };
  const remote = {
    authority: remoteAuthority,
    card: yield* issueTestCard({
      byte: 2,
      name: "bob",
      authority: remoteAuthority,
      registryKeys,
    }),
  };
  const signer = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeys.publicKey.export({ format: "jwk" }),
  );
  const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
    moltzapVersion: MOLTZAP_VERSION,
    kind: "membership_descriptor",
    conversationId: yield* deriveConversationId([
      local.card.agentId,
      remote.card.agentId,
    ]),
    members: [
      yield* Schema.encode(AgentCard)(local.card),
      yield* Schema.encode(AgentCard)(remote.card),
    ],
  });
  const membership = yield* verifyMembershipDescriptor(descriptor, signer);
  const directory = stateDirectory();
  const store = yield* openEndpointStore(directory);
  yield* store.bindIdentity({
    agentId: local.card.agentId,
    canonicalAgentCard: yield* encodeCanonical(AgentCard, local.card),
  });
  return { local, remote, membership, directory, store, registryKeys, signer };
});

const fixture = Effect.gen(function* () {
  const { local, remote, membership, directory, store, registryKeys, signer } =
    yield* identities;
  const outbound = yield* Deferred.make<undefined>();
  const engine = yield* makeEndpointEngine({
    localAgentCard: local.card,
    signingAuthority: local.authority,
    registrySignerPublicKey: signer,
    registry: {
      lookup: () => Effect.succeed({ kind: "found", agentCard: remote.card }),
    },
    store,
    actionPolicy: () => Effect.succeed("sign"),
    reportStorageFault: Effect.dieMessage("unexpected store fault"),
    routerWorker: {
      currentAnchor: Effect.succeed(anchor),
      awaitAnchor: Effect.succeed(anchor),
      send: () =>
        Deferred.succeed(outbound, undefined).pipe(
          Effect.zipRight(Effect.never),
        ),
    },
  });
  return {
    local,
    remote,
    membership,
    directory,
    store,
    engine,
    outbound,
    registryKeys,
    signer,
  };
});
type Fixture = Effect.Effect.Success<typeof fixture>;

const auditChecks = (subject: Fixture) =>
  Effect.gen(function* () {
    const path = join(subject.directory, "audit.ndjson");
    yield* (yield* beginFirewallAudit(path, subject.store)).finish;
    const fileSystem = yield* FileSystem.FileSystem;
    return decodeAudit(yield* fileSystem.readFileString(path)).records.filter(
      (record) => record.kind === "check",
    );
  }).pipe(Effect.provide(NodeFileSystem.layer));

const installation = (
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
) =>
  installFirewall({
    incoming: [middleware],
    outgoing: [middleware],
    settings,
    facts: [],
    codeDigest: "a".repeat(64),
    mode: "enforcement",
    ...overrides,
  });

const incomingDelivery = (
  subject: Fixture,
  installed: Effect.Effect.Success<ReturnType<typeof installation>>,
) =>
  Effect.gen(function* () {
    const { local, store } = subject;
    const environment = { installed, store, localAgentCard: local.card };
    const scope = yield* Scope.Scope;
    const collectives = makeCollectiveOperations({
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      scope,
      lookupMember: () => Effect.void,
      sendPost: () => Effect.dieMessage("no protocol send is expected"),
      emit: () => Effect.void,
    });
    const delivery = yield* makeHostDelivery({
      store,
      historyExport: noHistoryExport,
      collectives: () => collectives,
      scope,
      firewall: installed,
      firewallEnvironment: () => environment,
    });
    return { environment, delivery, collectives };
  });

const incomingFixture = (
  subject: Fixture,
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
) =>
  Effect.gen(function* () {
    const { store } = subject;
    yield* seedIncoming(subject);
    const installed = yield* installation(middleware, overrides);
    const { environment, delivery, collectives } = yield* incomingDelivery(
      subject,
      installed,
    );
    const published: HarnessMessageReadyEvent[] = [];
    const readPending = pendingMessages(store);
    const runPass = delivery.runPass(() => ({
      readPending,
      classify: collectives.classify,
      engine: { acknowledgeMessage: subject.engine.acknowledgeMessage },
      handler: {
        publish: (event) => {
          published.push(event);
          return true;
        },
      },
    }));
    const completed = yield* Queue.unbounded<undefined>();
    yield* delivery
      .runAdmission(
        runPass.pipe(
          Effect.orDie,
          Effect.zipRight(Queue.offer(completed, undefined)),
          Effect.asVoid,
        ),
      )
      .pipe(Effect.forkScoped);
    const pending = yield* readPending;
    const candidate = pending[0];
    if (candidate === undefined) {
      return yield* Effect.dieMessage("missing certified fixture");
    }
    return {
      ...environment,
      delivery,
      published,
      runPass,
      completed,
      candidate,
    };
  });

it(
  "withholds a certified incoming message from every runtime read and notification",
  withheldIncoming,
);

function withheldIncoming() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const runtime = yield* incomingFixture(
      subject,
      policy(() => Effect.succeed(block)),
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(runtime.published).toEqual([]);
    expect((yield* runtime.delivery.operations.readInbox({})).items).toEqual(
      [],
    );
    expect((yield* runtime.delivery.eventStore.readInbox()).items).toEqual([]);
    expect(
      (yield* runtime.delivery.operations.readInboxSummary()).pendingCount,
    ).toBe(0);
    expect(
      yield* Effect.flip(
        runtime.delivery.operations.readEvent({
          eventId: eventIdOf(runtime.candidate.deliveryToken),
        }),
      ),
    ).toEqual({ reason: "unknown-event" });
    expect(yield* subject.store.readPendingDeliveries()).toEqual([]);
    const seen: MiddlewareInput[] = [];
    const outgoing = yield* outgoingFixture(
      subject,
      policy((input) =>
        Effect.sync(() => {
          seen.push(input);
          return revise;
        }),
      ),
    );
    yield* Effect.flip(
      outgoing.operations.send({ input: { to: destination, text: "A reply" } }),
    );
    expect(seen[0]?.context.history).toMatchObject([
      {
        sender: subject.remote.card.agentId,
        visibility: "assessor",
        admission: "withheld",
      },
    ]);
  });
}

it(
  "admits original content with local guidance and verified attribution",
  guidanceIncoming,
);

function guidanceIncoming() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const seen: MiddlewareInput[] = [];
    const runtime = yield* incomingFixture(
      subject,
      policy((input) =>
        Effect.sync(() => {
          seen.push(input);
          return {
            findings: pass.findings,
            expectations: [
              {
                ruleId: rule.id,
                expectation: "required",
                subjects: [input.event.message.id],
              },
            ],
          };
        }),
      ),
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    const page = yield* runtime.delivery.operations.readInbox({});
    expect(page.items).toEqual(runtime.published);
    expect(page.items).toMatchObject([
      { guidance: { instructions: [{ instruction: rule.guidance }] } },
    ]);
    expect(page.items[0]?.item).toEqual({
      kind: "multicast",
      message: runtime.candidate.message,
    });
    expect(seen[0]?.context.history).toEqual([]);
    expect(seen[0]?.event.message.sender).toBe(subject.remote.card.agentId);
    expect(seen[0]?.context.participants).toContainEqual({
      agentId: subject.remote.card.agentId,
      principal: subject.remote.card.principalId,
    });
    expect(
      (yield* runtime.delivery.operations.readEvent({
        eventId: eventIdOf(runtime.candidate.deliveryToken),
      })).guidance,
    ).toEqual(page.items[0]?.guidance);
  });
}

it(
  "records a shadow block while guidance mode admits the original message",
  shadowIncoming,
);

function shadowIncoming() {
  return Effect.gen(function* () {
    const runtime = yield* incomingFixture(
      yield* fixture,
      policy(() => Effect.succeed(block)),
      { mode: "guidance" },
    );
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(runtime.published.map((event) => event.item)).toEqual([
      { kind: "multicast", message: runtime.candidate.message },
    ]);
    expect(runtime.published[0]?.guidance).toBeUndefined();
  });
}

function outgoingFixture(
  subject: Fixture,
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
) {
  return Effect.gen(function* () {
    const installed = yield* installation(middleware, overrides);
    const scope = yield* Scope.Scope;
    const collectives = makeCollectiveOperations({
      self: Schema.decodeUnknownSync(AgentAddress)("agent:alice"),
      scope,
      lookupMember: subject.engine.resolveAddress,
      sendPost: subject.engine.send,
      emit: () => Effect.void,
    });
    const environment = {
      installed,
      store: subject.store,
      localAgentCard: subject.local.card,
    };
    return yield* makeHostDelivery({
      store: subject.store,
      historyExport: noHistoryExport,
      scope,
      collectives: () => ({
        send: (input, failureDelivery) =>
          sendWithFirewall(environment, subject.engine, collectives, {
            input,
            failureDelivery,
          }),
      }),
    });
  });
}

it(
  "retains revision feedback under the invocation key without creating an intent",
  retainedRefusal,
);

function retainedRefusal() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    let calls = 0;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() =>
        Effect.sync(() => {
          calls += 1;
          return revise;
        }),
      ),
    );
    const request = {
      input: { to: destination, text: "Tuesday works." },
      idempotencyKey: "draft-1",
    };
    const first = yield* Effect.flip(delivery.operations.send(request));
    expect(first).toBeInstanceOf(FirewallSendError);
    expect(first.message).toContain(rule.feedback.text);
    expect(yield* Effect.flip(delivery.operations.send(request))).toEqual(
      first,
    );
    expect(calls).toBe(1);
    expect((yield* subject.store.recover()).postIntents).toEqual([]);
    expect(
      yield* delivery.operations.readSend({
        idempotencyKey: request.idempotencyKey,
      }),
    ).toMatchObject({
      state: "returned",
      outcome: {
        kind: "failure",
        error: { reason: "firewall-refused", refusal: "norm-violation" },
      },
    });
    expect(
      yield* Effect.flip(
        delivery.operations.send({
          ...request,
          input: { ...request.input, text: "Revised draft" },
        }),
      ),
    ).toMatchObject({ reason: "idempotency-conflict" });
  });
}

it(
  "rechecks an allow after evidence changes and then refuses the same unsent candidate",
  recheckedSend,
);

function recheckedSend() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const entered = yield* Deferred.make<undefined>();
    const release = yield* Deferred.make<undefined>();
    const seen: MiddlewareInput[] = [];
    const delivery = yield* outgoingFixture(
      subject,
      policy((input) =>
        Effect.gen(function* () {
          seen.push(input);
          if (seen.length === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return pass;
          }
          return block;
        }),
      ),
    );
    const sending = yield* delivery.operations
      .send({ input: { to: destination, text: "Draft before new evidence" } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* subject.store.putInboxItem({
      deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
        digest("dlv_", 90),
      ),
      canonicalItem: yield* encodeRuntimeValue({ kind: "local evidence" }),
    });
    yield* Deferred.succeed(release, undefined);
    expect(yield* Effect.flip(Fiber.join(sending))).toMatchObject({
      refusal: "prohibited",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.event).toEqual(seen[0]?.event);
    expect((yield* subject.store.recover()).postIntents).toEqual([]);
  });
}

it(
  "does not admit an interrupted checker and releases its shared permit",
  interruptedSend,
);

function interruptedSend() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const entered = yield* Deferred.make<undefined>();
    let calls = 0;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() =>
        Effect.suspend(() => {
          calls += 1;
          return calls === 1
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.zipRight(Effect.never),
              )
            : Effect.succeed(block);
        }),
      ),
      { maximumConcurrentChecks: 1 },
    );
    const sending = yield* delivery.operations
      .send({ input: { to: destination, text: "Cancelled draft" } })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(sending);
    expect((yield* subject.store.recover()).postIntents).toEqual([]);
    expect(
      yield* Effect.flip(
        delivery.operations.send({
          input: { to: destination, text: "Another draft" },
        }),
      ),
    ).toMatchObject({ refusal: "prohibited" });
  });
}

it(
  "refuses unsupported application forms before the collective layer sends",
  unsupportedSend,
);

function unsupportedSend() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const delivery = yield* outgoingFixture(
      subject,
      policy(() => Effect.succeed(pass)),
    );
    const refusal = yield* Effect.flip(
      delivery.operations.send({
        input: { to: destination, collectiveResponse: { action: "decline" } },
        failureDelivery: "inbound",
      }),
    );
    expect(refusal.message).toContain(renderedWaitAction);
    expect(refusal).toMatchObject({
      refusal: "check-unavailable",
      feedback: [{ nextAction: waitAction }],
    });
    expect((yield* subject.store.recover()).postIntents).toEqual([]);
    expect((yield* delivery.operations.readInbox({})).items).toEqual([]);
    expect((yield* auditChecks(subject))[0]?.post).toBeNull();
  });
}

it(
  "exports the real incoming and outgoing author-scoped post references",
  auditCorrelatesPosts,
);

function auditCorrelatesPosts() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const allow = policy(() => Effect.succeed(pass));
    const incoming = yield* incomingFixture(subject, allow);
    yield* incoming.runPass;
    yield* Queue.take(incoming.completed);
    const outgoing = yield* outgoingFixture(subject, allow);
    const sending = yield* outgoing.operations
      .send({
        input: { to: destination, text: "Reply to the certified post" },
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(subject.outbound);
    const intent = (yield* subject.store.recover()).postIntents[0];
    const checks = yield* auditChecks(subject);
    expect(
      checks.find((check) => check.direction === "incoming")?.post,
    ).toEqual({
      authorAgentId: subject.remote.card.agentId,
      postId: incoming.candidate.message.postId,
    });
    expect(
      checks.find((check) => check.direction === "outgoing")?.post,
    ).toEqual({
      authorAgentId: subject.local.card.agentId,
      postId: intent?.postId,
    });
    yield* Fiber.interrupt(sending);
  });
}

it(
  "holds a concurrent send when its evidence is incomplete and its recheck is unavailable",
  concurrentSends,
);
it("holds outgoing admission after two stale checks", () =>
  staleOutgoing("enforcement"));
it("admits an outgoing shadow after two stale checks without running a third inference", () =>
  staleOutgoing("guidance"));
it("holds incoming admission after two stale checks", () =>
  staleIncoming("enforcement"));
it("admits an incoming shadow after two stale checks without stale guidance", () =>
  staleIncoming("guidance"));
it(
  "captures immutable installation provenance and distinguishes provider model changes",
  installationProvenance,
);

function concurrentSends() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const entered = yield* Queue.unbounded<MiddlewareInput>();
    const release = yield* Deferred.make<undefined>();
    const delivery = yield* outgoingFixture(
      subject,
      policy((input) =>
        Queue.offer(entered, input).pipe(
          Effect.zipRight(
            input.context.gaps.length === 0
              ? Deferred.await(release).pipe(Effect.as(pass))
              : Effect.fail(new MiddlewareError({ reason: "unavailable" })),
          ),
        ),
      ),
    );
    const first = yield* delivery.operations
      .send({ input: { to: destination, text: "First proposal" } })
      .pipe(Effect.forkScoped);
    const second = yield* delivery.operations
      .send({ input: { to: destination, text: "Second proposal" } })
      .pipe(Effect.forkScoped);
    yield* Queue.take(entered);
    yield* Queue.take(entered);
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(subject.outbound);
    const refusal = yield* Effect.race(
      Effect.flip(Fiber.join(first)),
      Effect.flip(Fiber.join(second)),
    );
    expect(refusal).toMatchObject({ refusal: "check-unavailable" });
    expect((yield* Queue.take(entered)).context.gaps).not.toEqual([]);
    expect((yield* subject.store.recover()).postIntents).toHaveLength(1);
    yield* Fiber.interrupt(first);
    yield* Fiber.interrupt(second);
  });
}

function churnPolicy(subject: Fixture) {
  let calls = 0;
  return {
    count: () => calls,
    middleware: policy(() =>
      Effect.gen(function* () {
        calls += 1;
        yield* subject.store.putInboxItem({
          deliveryToken: Schema.decodeUnknownSync(DeliveryToken)(
            digest("dlv_", 120 + calls),
          ),
          canonicalItem: yield* encodeRuntimeValue({
            kind: "evidence changed",
          }),
        });
        return pass;
      }).pipe(Effect.orDie),
    ),
  };
}

function staleOutgoing(mode: FirewallOptions["mode"]) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const churn = churnPolicy(subject);
    const delivery = yield* outgoingFixture(subject, churn.middleware, {
      mode,
    });
    const sending = yield* delivery.operations
      .send({
        input: { to: destination, text: "Draft while evidence changes" },
      })
      .pipe(Effect.forkScoped);
    if (mode === "enforcement") {
      const refusal = yield* Effect.flip(Fiber.join(sending));
      expect(refusal.message).toContain(renderedWaitAction);
      expect(refusal).toMatchObject({
        refusal: "unresolved-evidence",
        feedback: [{ nextAction: waitAction }],
      });
      expect((yield* subject.store.recover()).postIntents).toEqual([]);
    } else {
      yield* Deferred.await(subject.outbound);
      expect((yield* subject.store.recover()).postIntents).toHaveLength(1);
      yield* Fiber.interrupt(sending);
    }
    expect(churn.count()).toBe(2);
  });
}

function staleIncoming(mode: FirewallOptions["mode"]) {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    const churn = churnPolicy(subject);
    const runtime = yield* incomingFixture(subject, churn.middleware, { mode });
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    const event = yield* runtime.delivery.operations
      .readEvent({ eventId: eventIdOf(runtime.candidate.deliveryToken) })
      .pipe(Effect.either);
    expect(event._tag).toBe(mode === "guidance" ? "Right" : "Left");
    expect(churn.count()).toBe(2);
    expect(
      runtime.published.every((entry) => entry.guidance === undefined),
    ).toBe(true);
  });
}

function installationProvenance() {
  return Effect.gen(function* () {
    const model = "model-one";
    const registration = {
      ...policy(() => Effect.succeed(pass)),
      provenance: { format: "provider", data: model },
    };
    const installed = yield* installation(registration);
    registration.provenance.data = "model-two";
    const changed = yield* installation(registration);
    expect(installed.metadata.incoming[0]?.provenance.data).toBe(model);
    expect(changed.configurationDigest).not.toBe(installed.configurationDigest);
  });
}

it(
  "keeps later work in another conversation moving while one assessment waits",
  independentConversations,
);

function addConversation(subject: Fixture, authoredLocally = false) {
  return Effect.gen(function* () {
    const authority = yield* makeTestAuthority();
    const card = yield* issueTestCard({
      byte: 3,
      name: "carol",
      authority,
      registryKeys: subject.registryKeys,
    });
    const descriptor = yield* Schema.decodeUnknown(MembershipDescriptor)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "membership_descriptor",
      conversationId: yield* deriveConversationId([
        subject.local.card.agentId,
        card.agentId,
      ]),
      members: [
        yield* Schema.encode(AgentCard)(subject.local.card),
        yield* Schema.encode(AgentCard)(card),
      ],
    });
    const membership = yield* verifyMembershipDescriptor(
      descriptor,
      subject.signer,
    );
    const authors = authoredLocally
      ? { local: { card, authority }, remote: subject.local }
      : { local: subject.local, remote: { card, authority } };
    const record = yield* buildCertifiedGenesis(
      authors.local,
      authors.remote,
      membership,
      anchor.routerInstanceId,
    );
    yield* storeCertifiedGenesis(
      subject.store,
      subject.local.card,
      membership,
      record,
    );
  });
}

function independentConversations() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* addConversation(subject);
    const blocked = yield* Deferred.make<undefined>();
    const middleware = policy((input) =>
      input.event.message.sender === subject.remote.card.agentId
        ? Deferred.succeed(blocked, undefined).pipe(
            Effect.zipRight(Effect.never),
          )
        : Effect.succeed(pass),
    );
    const runtime = yield* incomingFixture(subject, middleware, {
      mode: "guidance",
      maximumConcurrentChecks: 2,
    });
    yield* runtime.runPass;
    yield* Deferred.await(blocked);
    yield* Queue.take(runtime.completed);
    const later = Schema.decodeUnknownSync(InboundItem)({
      kind: "operationFailed",
      id: digest("col_", 84),
      to: "agent:carol",
      error: "Another operation completed.",
    });
    yield* runtime.delivery.queueLocalItem(later);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(
      (yield* runtime.delivery.operations.readInbox({})).items.map(
        (entry) => entry.item,
      ),
    ).toContainEqual(later);
    expect(
      (yield* subject.store.readFirewallFrontiers()).map(
        (entry) => entry.conversation,
      ),
    ).toEqual(["agent:bob"]);
  });
}

function policy(check: MessageMiddleware["check"]): MessageMiddleware {
  return { id: "communication", revision: "test-v1", rules: [rule], check };
}

function pendingMessages(store: EndpointStore) {
  return store.readPendingDeliveries().pipe(
    Effect.flatMap((entries) =>
      Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            return {
              deliveryToken: entry.deliveryToken,
              recordHash: yield* Schema.decodeUnknown(RecordHash)(
                entry.recordHash,
              ),
              message: yield* decodeRuntimeValue(
                InboundMessage,
                entry.canonicalMessage,
              ),
            };
          }),
        { concurrency: 1 },
      ),
    ),
  );
}

it("holds oversized incoming advice without publishing a partial projection", () =>
  oversizedAdvice("enforcement"));
it("admits the original without oversized advice in guidance mode", () =>
  oversizedAdvice("guidance"));
it(
  "does not expose locally authored history without runtime admission",
  ownerHistoryStaysPrivate,
);

function oversizedAdvice(mode: FirewallOptions["mode"]) {
  return Effect.gen(function* () {
    const middleware: MessageMiddleware = {
      id: "large-norm",
      revision: "1",
      rules: [{ ...rule, guidance: "x".repeat(2 * 1024 * 1024) }],
      check: (input) =>
        Effect.succeed({
          findings: pass.findings,
          expectations: [
            {
              ruleId: rule.id,
              expectation: "required",
              subjects: [input.event.message.id],
            },
          ],
        }),
    };
    const runtime = yield* incomingFixture(yield* fixture, middleware, {
      mode,
    });
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(runtime.published).toHaveLength(mode === "guidance" ? 1 : 0);
    expect(
      runtime.published.every((entry) => entry.guidance === undefined),
    ).toBe(true);
    expect(yield* runtime.store.readFirewallFrontiers()).toEqual([]);
  });
}

function ownerHistoryStaysPrivate() {
  return Effect.gen(function* () {
    const subject = yield* fixture;
    yield* addConversation(subject, true);
    const seen: MiddlewareInput[] = [];
    const middleware = policy((input) =>
      Effect.sync(() => {
        seen.push(input);
        return {
          findings: pass.findings,
          expectations: [
            {
              ruleId: rule.id,
              expectation: "required",
              subjects: [input.event.message.id],
            },
          ],
        };
      }),
    );
    const runtime = yield* incomingFixture(subject, middleware);
    yield* runtime.runPass;
    yield* Queue.take(runtime.completed);
    expect(seen).toMatchObject([
      {
        context: {
          history: [
            {
              sender: subject.local.card.agentId,
              visibility: "assessor",
              admission: "admitted",
            },
          ],
        },
      },
    ]);
    const guidance = (yield* runtime.delivery.operations.readInbox({})).items[0]
      ?.guidance;
    expect(guidance?.subjects).toHaveLength(1);
    expect(guidance?.subjects[0]?.sender).toBe(subject.remote.card.agentId);
  });
}

function seedIncoming(subject: Fixture) {
  return Effect.gen(function* () {
    const { local, remote, membership, store } = subject;
    const record = yield* buildCertifiedGenesis(
      local,
      remote,
      membership,
      anchor.routerInstanceId,
    );
    yield* storeCertifiedGenesis(store, local.card, membership, record);
  });
}
