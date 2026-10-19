/** @file Real storage and prepared send fixtures shared by firewall admission tests. */

import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import {
  AgentCard,
  Ed25519PublicKey,
  MOLTZAP_VERSION,
} from "@moltzap/identity";
import { RouterInstanceId } from "@moltzap/router";
import { Deferred, Effect, Queue, Schema, Scope } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import type { HarnessMessageReadyEvent } from "../delivery/operations.js";
import type {
  MessageMiddleware,
  MiddlewareResult,
} from "../firewall/values.js";
import { beginFirewallAudit } from "../delivery/firewall-audit.js";
import {
  type FirewallOptions,
  installFirewall,
  sendWithFirewall,
} from "../delivery/firewall.js";
import { noHistoryExport } from "../delivery/history-export.js";
import { makeHostDelivery } from "../delivery/host-delivery.js";
import {
  decodeRuntimeValue,
  type EndpointStore,
  openEndpointStore,
} from "../store/index.js";
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
import {
  identifier,
  issueTestCard,
  makeTestAuthority,
} from "./agent-card-fixtures.js";
import {
  buildCertifiedGenesis,
  storeCertifiedGenesis,
} from "./certified-history-fixtures.js";
import { decodeAudit } from "./firewall-audit-fixtures.js";
import { pollCursor } from "./router-worker-fixtures.js";
import { stateDirectory } from "./store-schema-fixtures.js";

/** A communication norm shares its guidance and repair text across traces. */
export const rule = {
  id: "communication",
  kind: "norm",
  guidance: "Answer the open scheduling question.",
  feedback: {
    nextAction: "revise",
    text: "Include all required participants.",
  },
} as const;
/** A complete policy permits admission without advice. */
export const pass: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "pass" }],
  expectations: [],
};
/** A semantic rejection with no response obligation. */
export const block: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "block" }],
  expectations: [],
};
/** A norm violation that returns the registered repair advice. */
export const revise: MiddlewareResult = {
  findings: [{ ruleId: rule.id, outcome: "revise" }],
  expectations: [],
};
/** An unresolved check tells the runtime to wait. */
export const waitAction = "wait";
/** The textual error projection retains the next action. */
export const renderedWaitAction = `Next action: ${waitAction}.`;
/** Budgets leave room for real storage and scheduling on loaded test hosts. */
export const settings = {
  timeoutMilliseconds: 10_000,
  middlewareTimeoutMilliseconds: 8_000,
  maximumInputBytes: 1_000_000,
  maximumResultBytes: 100_000,
};
/** Bob is the peer of the default direct conversation. */
export const destination = Schema.decodeUnknownSync(AgentAddress)("agent:bob");
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

/** Real storage and send preparation run with a suspended Router send. */
export const fixture = Effect.gen(function* () {
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
}).pipe(Effect.withSpan("fixture"));
/** The acquired identities and storage remain live for the test scope. */
export type Fixture = Effect.Effect.Success<typeof fixture>;

/** Decode the public operator snapshot after all writes settle. */
export const auditChecks = (subject: Fixture) =>
  Effect.gen(function* () {
    const path = join(subject.directory, "audit.ndjson");
    yield* (yield* beginFirewallAudit(path, subject.store)).finish;
    const fileSystem = yield* FileSystem.FileSystem;
    return decodeAudit(yield* fileSystem.readFileString(path)).records.filter(
      (record) => record.kind === "check",
    );
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.withSpan("auditChecks"));

/** Fixed registration and settings are captured before delivery operations run. */
export const installation = (
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

/** A seeded incoming candidate runs through the admission worker and inbox. */
export const incomingFixture = (
  subject: Fixture,
  middleware: MessageMiddleware,
  overrides: Partial<FirewallOptions> = {},
  seed = true,
) =>
  Effect.gen(function* () {
    yield* Effect.when(seedIncoming(subject), () => seed);
    const { environment, delivery, collectives } = yield* incomingDelivery(
      subject,
      yield* installation(middleware, overrides),
    );
    const published: HarnessMessageReadyEvent[] = [];
    const readPending = pendingMessages(subject.store);
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
  }).pipe(Effect.withSpan("incomingFixture"));

/** Runtime send operations use the real checked-send path before the Router barrier. */
export function outgoingFixture(
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
  }).pipe(Effect.withSpan("outgoingFixture"));
}

/** Carol supplies an independent conversation using the same endpoint store. */
export function addConversation(subject: Fixture, authoredLocally = false) {
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
    return { membership, record, remote: { card, authority } };
  }).pipe(Effect.withSpan("addConversation"));
}

/** A complete registered norm delegates only its assessment to the test. */
export function policy(check: MessageMiddleware["check"]): MessageMiddleware {
  return { id: "communication", revision: "test-v1", rules: [rule], check };
}

/** A signed GENESIS seeds the default conversation without network traffic. */
export function seedIncoming(subject: Fixture, authoredLocally = false) {
  return Effect.gen(function* () {
    const { local, remote, membership, store } = subject;
    const record = yield* buildCertifiedGenesis(
      authoredLocally ? remote : local,
      authoredLocally ? local : remote,
      membership,
      anchor.routerInstanceId,
    );
    yield* storeCertifiedGenesis(store, local.card, membership, record);
    return record;
  }).pipe(Effect.withSpan("seedIncoming"));
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
