/** @file Exact daemon management projection and closed-error tests. */

import {
  AgentCard,
  AgentSigningAuthority,
  Ed25519PublicKey,
  MessageId,
  MOLTZAP_VERSION,
  SignedMessage,
  type VerifiedAgentCard,
} from "@moltzap/identity";
import {
  Registry,
  RegistryConnectionError,
  type RegistryListRequest,
  type RegistryLookupRequest,
  type RegistryRegisterResult,
} from "@moltzap/identity/registry";
import { RouterInstanceId } from "@moltzap/router";
import {
  type Context,
  Effect,
  Encoding,
  Layer,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { describe, expect, it } from "vitest";
import type { DaemonBootstrap } from "./configuration.js";
import {
  CertifiedRecord,
  encodeCanonical,
} from "../endpoint/representation.js";
import {
  type EndpointStore,
  EndpointStoreError,
  type IdentityBinding,
  type CertifiedRecord as StoredCertifiedRecord,
} from "../endpoint/store.js";
import {
  managementRegisterRequestSchema,
  managementSearchAgentsRequestSchema,
} from "../management-runtime.js";
import {
  type DaemonManagementOperations,
  makeDaemonManagementOperations,
} from "./management.js";

/* eslint-disable agent-code-guard/async-keyword -- Signed golden fixtures pin the exact private management boundary. */

const privateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHsbmQdBGQFs1eXLEWxKDblLeG//B9s8WmWEMQHvw4f8
-----END PRIVATE KEY-----`;
const registryKeyRepresentation = {
  crv: "Ed25519",
  kty: "OKP",
  x: "y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0",
} as const;
const firstCardRepresentation = {
  payload:
    "eyJhZ2VudElkIjoiYWd0X0FRRUJBUUVCQVFFQkFRRUJBUUVCQVEiLCJhZ2VudE5hbWUiOiJhZ2VudC1vbmUiLCJpc3N1ZWRBdCI6IjIwMjYtMDgtMTNUMDA6MDA6MDFaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi43MjkuMSIsInByaW5jaXBhbElkIjoicHJuX0N3c0xDd3NMQ3dzTEN3c0xDd3NMQ3ciLCJwdWJsaWNLZXkiOnsiY3J2IjoiRWQyNTUxOSIsImt0eSI6Ik9LUCIsIngiOiIzclVKOTJ0SVAwREU0ZWttRVQxem1lNlNJV1RwNUcwS2lGM1pqTC1Bb0tnIn19",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6c2RFN0NFOENLYVFvMDlSYzdYUEVXbVVNN3puOS00RmxZRzR5QlFhODQtNCIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
      signature:
        "7gbf_w3RQVDaiX99yl3XrPAlVUweI_3R8P89ZRqOAB1P6KMP8fK71Ey3QHxEwmo_qnoVnZLVBuZomdnlOFRZAw",
    },
  ],
} as const;
const secondCardRepresentation = {
  payload:
    "eyJhZ2VudElkIjoiYWd0X0FnSUNBZ0lDQWdJQ0FnSUNBZ0lDQWciLCJhZ2VudE5hbWUiOiJhZ2VudC10d28iLCJpc3N1ZWRBdCI6IjIwMjYtMDgtMTNUMDA6MDA6MDJaIiwia2luZCI6ImFnZW50Q2FyZCIsIm1vbHR6YXBWZXJzaW9uIjoiMjAyNi43MjkuMSIsInByaW5jaXBhbElkIjoicHJuX0RBd01EQXdNREF3TURBd01EQXdNREEiLCJwdWJsaWNLZXkiOnsiY3J2IjoiRWQyNTUxOSIsImt0eSI6Ik9LUCIsIngiOiJwZ1liNXhZbW9UVXVKWTRHbktLQnltRnVGSGJuZXRLRG55Vm1uYkZBTU9zIn19",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZDI1NTE5Iiwia2lkIjoidXJuOmlldGY6cGFyYW1zOm9hdXRoOmp3ay10aHVtYnByaW50OnNoYS0yNTY6c2RFN0NFOENLYVFvMDlSYzdYUEVXbVVNN3puOS00RmxZRzR5QlFhODQtNCIsInR5cCI6ImFwcGxpY2F0aW9uL3ZuZC5tb2x0emFwLmFnZW50LWNhcmQrandzIn0",
      signature:
        "srmWhPubdYbD4O2t85NncbzdJcLKkiaKYd3ZZtSees0mGJh_AJblHAJiFpFeNmoxBsoJEWRLnwAZ6S6npQkUBg",
    },
  ],
} as const;

interface RegistryCalls {
  readonly lookups: readonly RegistryLookupRequest[];
  readonly lists: readonly RegistryListRequest[];
}

const hash = (prefix: string, byte: number): string =>
  `${prefix}${Encoding.encodeBase64Url(new Uint8Array(32).fill(byte))}`;

const makeBootstrapFixture = Effect.gen(function* () {
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeyRepresentation,
  );
  const encodedCard = yield* Schema.decodeUnknown(AgentCard)(
    firstCardRepresentation,
  );
  const agentCard = yield* AgentCard.verify({
    agentCard: encodedCard,
    registrySignerPublicKey,
  });
  const secondCard = yield* Schema.decodeUnknown(AgentCard)(
    secondCardRepresentation,
  );
  const signingAuthority = yield* AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKey),
  );
  const bootstrap: DaemonBootstrap = Object.freeze({
    configuration: {
      stateDirectory: "/var/lib/moltzapd",
      mcpPort: 4319,
      registryOrigin: new URL("https://registry.example"),
      registrySignerPublicKey,
      routerOrigin: new URL("https://router.example"),
      agentPrivateKeyFile: Redacted.make("/run/secrets/agent.pem"),
      admissionCredentialFile: Redacted.make("/run/secrets/admission"),
    },
    signingAuthority,
    agentPublicKey: AgentSigningAuthority.publicKey(signingAuthority),
    admissionCredential: Redacted.make("bootstrap-token="),
  });
  return { agentCard, bootstrap, secondCard, signingAuthority };
});

const makeStore = (input: {
  readonly history?: StoredCertifiedRecord;
  readonly historyFailure?: EndpointStoreError;
}) =>
  Effect.gen(function* () {
    const binding = yield* Ref.make<IdentityBinding | undefined>(undefined);
    const store: EndpointStore = {
      readIdentity: () => Ref.get(binding),
      bindIdentity: (candidate) =>
        Ref.modify(
          binding,
          (current) =>
            [
              current === undefined ? "inserted" : "existing",
              current ?? candidate,
            ] as const,
        ),
      bindStartIntent: () => Effect.dieMessage("outside management test"),
      putConversationFoundation: () =>
        Effect.dieMessage("outside management test"),
      stageRecord: () => Effect.dieMessage("outside management test"),
      mergeEvidence: () => Effect.dieMessage("outside management test"),
      promoteRecord: () => Effect.dieMessage("outside management test"),
      applyCatchUpRecord: () => Effect.dieMessage("outside management test"),
      stageReanchor: () => Effect.dieMessage("outside management test"),
      completeReanchor: () => Effect.dieMessage("outside management test"),
      applyCatchUpReanchor: () => Effect.dieMessage("outside management test"),
      consumeAttention: () => Effect.dieMessage("outside management test"),
      hasConsumedAttention: () => Effect.dieMessage("outside management test"),
      searchConversations: () =>
        Effect.succeed({
          conversationIds: ["00000000-0000-4000-8000-000000000001"],
          hasMore: false,
        }),
      readConversation: () =>
        input.historyFailure === undefined
          ? Effect.succeed({
              records: input.history === undefined ? [] : [input.history],
              continuation: null,
            })
          : Effect.fail(input.historyFailure),
      releaseContinuation: () => Effect.void,
      recover: () => Effect.dieMessage("outside management test"),
    };
    return store;
  });

const makeRegistryLayer = (input: {
  readonly registration: RegistryRegisterResult;
  readonly card: VerifiedAgentCard;
  readonly calls: Ref.Ref<RegistryCalls>;
  readonly fail?: boolean;
}) => {
  const service: Context.Tag.Service<typeof Registry> = {
    register: () =>
      input.fail === true
        ? Effect.fail(new RegistryConnectionError())
        : Effect.succeed(input.registration),
    lookup: (request) =>
      Ref.update(input.calls, (calls) => ({
        ...calls,
        lookups: [...calls.lookups, request],
      })).pipe(Effect.as({ kind: "found" as const, agentCard: input.card })),
    list: (request) =>
      Ref.update(input.calls, (calls) => ({
        ...calls,
        lists: [...calls.lists, request],
      })).pipe(
        Effect.as({
          kind: "page" as const,
          agentCards: [input.card],
          hasMore: false,
        }),
      ),
  };
  return Layer.succeed(Registry, service);
};

interface CertifiedRecordFixture {
  readonly agentCard: VerifiedAgentCard;
  readonly secondCard: typeof AgentCard.Type;
  readonly signingAuthority: AgentSigningAuthority;
}

interface RecordBindings {
  readonly actionHash: string;
  readonly anchorHash: string;
  readonly contentHash: string;
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly recordHash: string;
}

const makeRecordBindings = (): RecordBindings => ({
  actionHash: hash("ach_", 4),
  anchorHash: hash("anc_", 2),
  contentHash: hash("cnt_", 5),
  conversationId: "00000000-0000-4000-8000-000000000001",
  membershipHash: hash("mbr_", 1),
  recordHash: hash("rch_", 3),
});

const makeStartAction = (
  bindings: RecordBindings,
  fixture: CertifiedRecordFixture,
) => ({
  moltzapVersion: MOLTZAP_VERSION,
  kind: "start_action" as const,
  conversationId: bindings.conversationId,
  membershipHash: bindings.membershipHash,
  anchorHash: bindings.anchorHash,
  previousRecordHash: null,
  beginDigest: null,
  actionId: "START" as const,
  authorAgentId: fixture.agentCard.agentId,
  content: [{ type: "text" as const, text: "hello" }],
  replyFingerprint: null,
});

const makeMembership = (bindings: RecordBindings) => ({
  moltzapVersion: MOLTZAP_VERSION,
  kind: "membership" as const,
  conversationId: bindings.conversationId,
  membershipEpoch: 0 as const,
  members: [firstCardRepresentation, secondCardRepresentation],
});

const makeActionCertifiedRecord = (input: {
  readonly bindings: RecordBindings;
  readonly encodedEvidence: unknown;
  readonly fixture: CertifiedRecordFixture;
}) => {
  const action = makeStartAction(input.bindings, input.fixture);
  return {
    moltzapVersion: MOLTZAP_VERSION,
    kind: "action_certified_record" as const,
    membership: makeMembership(input.bindings),
    anchorHash: input.bindings.anchorHash,
    action,
    actionHash: input.bindings.actionHash,
    actionCertificate: {
      moltzapVersion: MOLTZAP_VERSION,
      kind: "action_certificate" as const,
      action: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "action_binding" as const,
        actionKind: "START" as const,
        conversationId: input.bindings.conversationId,
        membershipHash: input.bindings.membershipHash,
        anchorHash: input.bindings.anchorHash,
        previousRecordHash: null,
        beginDigest: null,
        actionId: "START" as const,
        authorAgentId: input.fixture.agentCard.agentId,
        contentHash: input.bindings.contentHash,
        replyFingerprint: null,
      },
      signatures: [input.encodedEvidence],
    },
  };
};

const makeCertifiedRecord = (fixture: CertifiedRecordFixture) =>
  Effect.gen(function* () {
    const bindings = makeRecordBindings();
    const routerInstanceId = Schema.decodeUnknownSync(RouterInstanceId)(
      `rti_${Encoding.encodeBase64Url(new Uint8Array(16).fill(6))}`,
    );
    const messageId = Schema.decodeUnknownSync(MessageId)(
      `msg_${Encoding.encodeBase64Url(new Uint8Array(16).fill(7))}`,
    );
    const evidence = yield* SignedMessage.sign({
      agentCard: fixture.agentCard,
      signingAuthority: fixture.signingAuthority,
      recipientAgentIds: new Set([fixture.secondCard.agentId]),
      messageId,
      body: new Uint8Array([8]),
    });
    const encodedEvidence = yield* Schema.encode(SignedMessage)(evidence);
    const record = yield* Schema.decodeUnknown(CertifiedRecord)({
      moltzapVersion: MOLTZAP_VERSION,
      kind: "certified_record",
      recordHash: bindings.recordHash,
      actionCertifiedRecord: makeActionCertifiedRecord({
        bindings,
        encodedEvidence,
        fixture,
      }),
      routerAnchor: {
        moltzapVersion: MOLTZAP_VERSION,
        kind: "genesis_anchor",
        conversationId: bindings.conversationId,
        membershipHash: bindings.membershipHash,
        routerInstanceId,
      },
      durabilityVotes: [encodedEvidence],
    });
    const canonicalCertifiedRecord = yield* encodeCanonical(
      CertifiedRecord,
      record,
    );
    const stored: StoredCertifiedRecord = {
      conversationId: bindings.conversationId,
      recordHash: bindings.recordHash,
      membershipHash: bindings.membershipHash,
      anchorHash: bindings.anchorHash,
      canonicalRecord: new Uint8Array([1]),
      canonicalCertifiedRecord,
    };
    return { record, stored };
  });

const registrationRequest = () =>
  Schema.decodeUnknownSync(managementRegisterRequestSchema)({
    operationId: "opn_AAAAAAAAAAAAAAAAAAAAAA",
    principalId: "prn_CwsLCwsLCwsLCwsLCwsLCw",
    agentName: "agent-one",
  });

const assertLifecycle = async (operations: DaemonManagementOperations) => {
  expect(await Effect.runPromise(operations.readStatus())).toEqual({
    kind: "unregistered",
  });
  expect(
    await Effect.runPromise(operations.register(registrationRequest())),
  ).toEqual({
    kind: "registered",
    agentCard: firstCardRepresentation,
  });
  expect(await Effect.runPromise(operations.readStatus())).toEqual({
    kind: "active",
    agentCard: firstCardRepresentation,
  });
};

const assertRegistrySearches = async (
  operations: DaemonManagementOperations,
  calls: Ref.Ref<RegistryCalls>,
) => {
  const lookup = Schema.decodeUnknownSync(managementSearchAgentsRequestSchema)({
    agentName: "agent-one",
  });
  expect(await Effect.runPromise(operations.searchAgents(lookup))).toEqual({
    kind: "found",
    agentCard: firstCardRepresentation,
  });
  expect(await Effect.runPromise(operations.searchAgents({}))).toEqual({
    kind: "page",
    agentCards: [firstCardRepresentation],
    hasMore: false,
  });
  expect(await Effect.runPromise(Ref.get(calls))).toEqual({
    lookups: [lookup],
    lists: [{}],
  });
};

const projectsLifecycleAndRegistry = async () => {
  const fixture = await Effect.runPromise(makeBootstrapFixture);
  const store = await Effect.runPromise(makeStore({}));
  const calls = await Effect.runPromise(
    Ref.make<RegistryCalls>({ lookups: [], lists: [] }),
  );
  const operations = await Effect.runPromise(
    Effect.provide(
      makeDaemonManagementOperations({ store, bootstrap: fixture.bootstrap }),
      makeRegistryLayer({
        registration: { kind: "registered", agentCard: fixture.agentCard },
        card: fixture.agentCard,
        calls,
      }),
    ),
  );
  await assertLifecycle(operations);
  await assertRegistrySearches(operations, calls);
  expect(await Effect.runPromise(operations.searchConversations({}))).toEqual({
    kind: "page",
    conversationIds: ["00000000-0000-4000-8000-000000000001"],
    hasMore: false,
  });
};

const decodesCanonicalHistory = async () => {
  const fixture = await Effect.runPromise(makeBootstrapFixture);
  const history = await Effect.runPromise(makeCertifiedRecord(fixture));
  const store = await Effect.runPromise(makeStore({ history: history.stored }));
  const calls = await Effect.runPromise(
    Ref.make<RegistryCalls>({ lookups: [], lists: [] }),
  );
  const operations = await Effect.runPromise(
    Effect.provide(
      makeDaemonManagementOperations({ store, bootstrap: fixture.bootstrap }),
      makeRegistryLayer({
        registration: { kind: "registered", agentCard: fixture.agentCard },
        card: fixture.agentCard,
        calls,
      }),
    ),
  );
  expect(
    await Effect.runPromise(
      operations.readConversation({
        conversationId:
          history.record.actionCertifiedRecord.action.conversationId,
      }),
    ),
  ).toEqual({ kind: "page", records: [history.record], continuation: null });
};

const mapsClosedHistoryFailures = async () => {
  const fixture = await Effect.runPromise(makeBootstrapFixture);
  const calls = await Effect.runPromise(
    Ref.make<RegistryCalls>({ lookups: [], lists: [] }),
  );
  const store = await Effect.runPromise(
    makeStore({
      historyFailure: new EndpointStoreError({
        reason: "invalid-continuation",
      }),
    }),
  );
  const operations = await Effect.runPromise(
    Effect.provide(
      makeDaemonManagementOperations({ store, bootstrap: fixture.bootstrap }),
      makeRegistryLayer({
        registration: { kind: "registered", agentCard: fixture.agentCard },
        card: fixture.agentCard,
        calls,
        fail: true,
      }),
    ),
  );
  const historyError = await Effect.runPromise(
    Effect.flip(operations.readConversation({ continuation: "A".repeat(43) })),
  );
  expect(historyError).toMatchObject({ reason: "invalid-continuation" });
  const registryError = await Effect.runPromise(
    Effect.flip(operations.register(registrationRequest())),
  );
  expect(registryError).toMatchObject({ reason: "upstream" });
};

// @agent-code-guard/regression-only: these cases pin the closed management DTO projection and its failure collapse.
describe("daemon management operations", () => {
  it(
    "encodes lifecycle and exact Registry lookup/list results",
    projectsLifecycleAndRegistry,
  );
  it(
    "decodes canonical certified history before MCP projection",
    decodesCanonicalHistory,
  );
  it(
    "maps store and Registry failures to closed management reasons",
    mapsClosedHistoryFailures,
  );
});

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults. */
