/* eslint-disable jsdoc/require-jsdoc, agent-code-guard/no-exported-brand-constructor, agent-code-guard/require-span-on-exported-effect -- Test fixtures exported only to the package's own regressions; each is named for the exact value it builds and has no consumer outside this package's own test files. */

import { assert } from "@effect/vitest";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentId } from "@moltzap/protocol/identity";
import { serverBaseUrlSchema } from "@moltzap/protocol/network";
import {
  conversationId,
  agentId as protocolAgentId,
  messageId,
  redactedAgentKey,
} from "@moltzap/protocol/testing";
import {
  DateTime,
  Deferred,
  Effect,
  Mailbox,
  Ref,
  Schema,
  type Scope,
} from "effect";
import { EventCatalog } from "../events/catalog.js";
import { makeDefinitionEventServices } from "../run/events.js";
import {
  LedgerCompletion,
  ledgerDigest,
  LedgerManifest,
  ledgerRef,
} from "../ledger/schema.js";
import { openLedger } from "../ledger/read.js";
import {
  LedgerStorageError,
  type LedgerArtifact,
  type LedgerStorageService,
} from "../ledger/storage.js";
import {
  type RouterStopped,
  makeAgentHandle,
  makeParticipantHandle,
  makeRouterStopReport,
  type AttachedEndpoint,
  type EndpointTransport,
  type MessageParts,
  type ReceivedMessage,
  type Router,
  type RouterProviderService,
} from "../network.js";
import { runSociety, type SimulatorRunOptions } from "../run/execute.js";
import type { AgentRuntimeLike } from "../agents/agent.js";
import { defineFakeRuntime, makeFakeCluster } from "../cluster/fake.js";
import { Cluster } from "../cluster/cluster.js";
import { makeAgentRosterBinding, type AgentRoster } from "../agents/roster.js";

export class Observation extends Schema.TaggedClass<Observation>()(
  "acme.kernel-observation/v1",
  { value: Schema.String },
) {}

const customerEvents = EventCatalog.make(Observation);
const DEFINITION_ID = "acme.kernel-test/v1";
const eventServices = makeDefinitionEventServices(
  DEFINITION_ID,
  customerEvents,
);
const rosterBinding = makeAgentRosterBinding(DEFINITION_ID);
const runKernel = <
  const Definitions extends Readonly<Record<string, AgentRuntimeLike>>,
  A,
  E,
  R,
>(
  roster: AgentRoster<typeof DEFINITION_ID, Definitions>,
  program: Effect.Effect<A, E, R>,
  options: SimulatorRunOptions = {},
) =>
  runSociety({
    definitionId: DEFINITION_ID,
    eventServices,
    roster,
    program,
    options,
  }).pipe(Effect.provideService(Cluster, makeFakeCluster()));
export const kernelHarness = Object.freeze({
  agents: rosterBinding.agents,
  ledger: eventServices.ledger,
  events: eventServices.events,
  run: runKernel,
  openLedger: (ref: typeof ledgerRef.Type) =>
    openLedger(eventServices.catalog, ref, DEFINITION_ID),
});
const DIGEST = Schema.decodeSync(ledgerDigest)("a".repeat(64));
export const REF = Schema.decodeSync(ledgerRef)("kernel-test-ledger");
export const ROUTER_URL = Schema.decodeSync(serverBaseUrlSchema)(
  "http://127.0.0.1:43100",
);
export const OBSERVED_EXIT_CODE = 7;
export const PRIMARY_AGENT_NAME = "alice";
export const testRuntimeConfiguration = Schema.Struct({
  kind: Schema.String,
});

export function configuration(kind: string) {
  return {
    schema: testRuntimeConfiguration,
    value: { kind },
  };
}

function agentId(suffix: number) {
  return protocolAgentId(
    `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
  );
}

function agentKey(suffix: number) {
  return redactedAgentKey(
    `moltzap_agent_${String(suffix).padStart(16, "0")}_${String(suffix).padStart(48, "0")}`,
  );
}

function completion(manifest: LedgerManifest, count: number): LedgerCompletion {
  return LedgerCompletion.make({
    ledgerFormatVersion: 1,
    runId: manifest.runId,
    recordCount: count,
    artifacts: { manifest: DIGEST, records: DIGEST },
  });
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

export function assertDefaultProvenance(manifest: LedgerManifest): void {
  assert.deepStrictEqual(manifest.provenance, {
    agents: [
      {
        name: "alice",
        runtime: "effect",
        configuration: { kind: "in-process" },
      },
      {
        name: "bob",
        runtime: "process",
        configuration: { kind: "external-process" },
      },
    ],
  });
}

export function memoryStorage(failOnEventTag?: string): LedgerStorageService {
  const files = new Map<LedgerArtifact, string>();
  return {
    allocate: (input) => {
      const manifest = LedgerManifest.make({
        ledgerFormatVersion: 1,
        definitionId: input.definitionId,
        runId: "kernel-test-run",
        catalogTags: [...input.catalogTags].sort(compareText),
        createdAt: DateTime.unsafeMake(0),
        provenance: input.provenance,
        metadata: input.metadata,
      });
      const records: string[] = [];
      files.set(
        "manifest",
        JSON.stringify(Schema.encodeSync(LedgerManifest)(manifest)),
      );
      files.set("records", "");
      return Effect.succeed({
        ref: REF,
        runId: manifest.runId,
        manifest,
        append: (record: string) =>
          failOnEventTag !== undefined && record.includes(failOnEventTag)
            ? Effect.fail(
                LedgerStorageError.make({
                  operation: "append",
                  detail: `failed ${failOnEventTag}`,
                }),
              )
            : Effect.sync(() => {
                records.push(record);
                files.set("records", `${records.join("\n")}\n`);
              }),
        complete: (count: number) => {
          const done = completion(manifest, count);
          files.set(
            "completion",
            JSON.stringify(Schema.encodeSync(LedgerCompletion)(done)),
          );
          return Effect.succeed(done);
        },
      });
    },
    read: (...[, artifact]) => Effect.succeed(files.get(artifact) ?? ""),
    digest: () => Effect.succeed(DIGEST),
  };
}

function increment(current: number): number {
  return current + 1;
}

export function observeCompletions(
  storage: LedgerStorageService,
  completions: Ref.Ref<number>,
): LedgerStorageService {
  return {
    ...storage,
    allocate: (input) =>
      storage.allocate(input).pipe(
        Effect.map((allocation) => ({
          ...allocation,
          complete: (count: number) =>
            allocation
              .complete(count)
              .pipe(Effect.zipLeft(Ref.update(completions, increment))),
        })),
      ),
  };
}

function hubMessage(
  endpointId: AgentId,
  currentConversationId: ConversationId,
  parts: MessageParts,
  sequence: number,
) {
  return {
    id: messageId(
      `00000000-0000-4000-8000-${String(400 + sequence).padStart(12, "0")}`,
    ),
    conversationId: currentConversationId,
    senderId: endpointId,
    parts,
    createdAt: "2026-07-28T00:00:00.000Z",
  };
}

interface Counter {
  value: number;
}

// In-memory loopback hub: every endpoint send fans out into every other
// attachment's received stream, so kernel tests observe real deliveries.
interface FakeHubState {
  readonly inboxes: Map<AgentId, Mailbox.Mailbox<ReceivedMessage>>;
  readonly endpoints: Counter;
  readonly messages: Counter;
  readonly committedSends?: Ref.Ref<number>;
}

function hubSend(
  hub: FakeHubState,
  endpointId: AgentId,
): EndpointTransport["send"] {
  return (currentConversationId, parts) =>
    Effect.gen(function* () {
      if (hub.committedSends !== undefined) {
        yield* Ref.update(hub.committedSends, increment);
      }
      hub.messages.value += 1;
      const message = hubMessage(
        endpointId,
        currentConversationId,
        parts,
        hub.messages.value,
      );
      yield* Effect.forEach(
        hub.inboxes,
        ([id, inbox]) =>
          id === endpointId ? Effect.void : inbox.offer({ message }),
        { concurrency: 1, discard: true },
      );
      return message;
    });
}

function hubAttachment<const Name extends string>(
  name: Name,
  endpointId: AgentId,
  mailbox: Mailbox.Mailbox<ReceivedMessage>,
  send: EndpointTransport["send"],
): AttachedEndpoint<Name> {
  return {
    participant: makeParticipantHandle(name, endpointId),
    transport: {
      received: Mailbox.toStream(mailbox),
      openConversation: () =>
        Effect.succeed({
          conversationId: conversationId(
            "00000000-0000-4000-8000-000000000102",
          ),
        }),
      send,
    },
  };
}

function hubAttach<const Name extends string>(
  hub: FakeHubState,
  name: Name,
): Effect.Effect<AttachedEndpoint<Name>, never, Scope.Scope> {
  return Effect.gen(function* () {
    hub.endpoints.value += 1;
    const endpointId = agentId(100 + hub.endpoints.value);
    const mailbox = yield* Mailbox.make<ReceivedMessage>();
    hub.inboxes.set(endpointId, mailbox);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => hub.inboxes.delete(endpointId)),
    );
    return hubAttachment(name, endpointId, mailbox, hubSend(hub, endpointId));
  });
}

export function fakeRouterProvider(
  committedSends?: Ref.Ref<number>,
): RouterProviderService {
  return {
    acquire: Effect.gen(function* () {
      const stopped = yield* Deferred.make<RouterStopped>();
      const hub: FakeHubState = {
        inboxes: new Map(),
        endpoints: { value: 0 },
        messages: { value: 0 },
        committedSends,
      };
      let nextIdentity = 0;
      const router: Router = {
        address: ROUTER_URL,
        stopped: Deferred.await(stopped),
        attachAgent: (name) =>
          Effect.sync(() => {
            nextIdentity += 1;
            return {
              agent: makeAgentHandle(name, agentId(nextIdentity)),
              key: agentKey(nextIdentity),
              routerUrl: ROUTER_URL,
            };
          }),
        attachEndpoint: (name) => hubAttach(hub, name),
      };
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(stopped, makeRouterStopReport([])).pipe(Effect.asVoid),
      );
      return router;
    }),
  };
}

const ongoingRuntime = defineFakeRuntime({
  name: "ongoing",
  configuration: configuration("ongoing"),
  acquire: () =>
    Effect.succeed({ gateway: undefined, termination: Effect.never }),
});

export const ongoingRoster = kernelHarness.agents({
  alice: ongoingRuntime,
});

// @agent-code-guard/regression-only: controlled scopes and deferred termination expose exact lifecycle evidence and cancellation order

/* eslint-enable jsdoc/require-jsdoc, agent-code-guard/no-exported-brand-constructor, agent-code-guard/require-span-on-exported-effect -- Restore the project default after the shared fixtures. */
