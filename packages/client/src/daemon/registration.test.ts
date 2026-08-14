/** @file Startup recovery and atomic Registry-to-store identity binding tests. */

import {
  AgentCard,
  AgentSigningAuthority,
  Ed25519PublicKey,
} from "@moltzap/identity";
import {
  Registry,
  RegistryConnectionError,
  type RegistryRegisterResult,
} from "@moltzap/identity/registry";
import { type Context, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { DaemonBootstrap } from "./configuration.js";
import { EndpointStoreError, type IdentityBinding } from "../endpoint/store.js";
import {
  DaemonRegistrationPersistenceError,
  DaemonRegistrationRepresentationError,
  type DaemonRegistrationRequest,
  daemonRegistrationRequestSchema,
  type DaemonRegistrationStore,
  DaemonRegistrationUpstreamError,
  readDaemonRegistrationState,
  registerDaemonIdentity,
} from "./registration.js";

/* eslint-disable agent-code-guard/async-keyword -- Static signed fixtures and exact state/error outcomes pin the registration recovery contract. */

const privateKey = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIHsbmQdBGQFs1eXLEWxKDblLeG//B9s8WmWEMQHvw4f8
-----END PRIVATE KEY-----`;
const registryKeyRepresentation = {
  crv: "Ed25519",
  kty: "OKP",
  x: "y1j1FUgbqjCPeQVEnllv-2euwn_s9DeDkfEh3gk_OJ0",
} as const;
const cardRepresentation = {
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
};

interface MemoryStore {
  readonly store: DaemonRegistrationStore;
  readonly binding: Ref.Ref<IdentityBinding | undefined>;
  readonly failWrites: Ref.Ref<boolean>;
}

const makeMemoryStore = Effect.gen(function* () {
  const binding = yield* Ref.make<IdentityBinding | undefined>(undefined);
  const failWrites = yield* Ref.make(false);
  const store: DaemonRegistrationStore = {
    readIdentity: () => Ref.get(binding),
    bindIdentity: (candidate) =>
      Ref.get(failWrites).pipe(
        Effect.flatMap((shouldFail) =>
          shouldFail
            ? Effect.fail(new EndpointStoreError({ reason: "persistence" }))
            : Ref.modify(
                binding,
                (existing) =>
                  [
                    existing === undefined ? "inserted" : "existing",
                    existing ?? candidate,
                  ] as const,
              ),
        ),
      ),
  };
  return { store, binding, failWrites } satisfies MemoryStore;
});

const makeFixture = Effect.gen(function* () {
  const registrySignerPublicKey = yield* Schema.decodeUnknown(Ed25519PublicKey)(
    registryKeyRepresentation,
  );
  const encodedCard =
    yield* Schema.decodeUnknown(AgentCard)(cardRepresentation);
  const agentCard = yield* AgentCard.verify({
    agentCard: encodedCard,
    registrySignerPublicKey,
  });
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
  const request = yield* Schema.decodeUnknown(daemonRegistrationRequestSchema)({
    operationId: "opn_AAAAAAAAAAAAAAAAAAAAAA",
    principalId: "prn_CwsLCwsLCwsLCwsLCwsLCw",
    agentName: "agent-one",
  });
  return { agentCard, bootstrap, request };
});

const registryLayer = (input: {
  readonly result: RegistryRegisterResult;
  readonly calls: Ref.Ref<readonly DaemonRegistrationRequest[]>;
  readonly fail?: boolean;
}) => {
  const service: Context.Tag.Service<typeof Registry> = {
    register: (call) =>
      Ref.update(input.calls, (calls) => [
        ...calls,
        {
          operationId: call.request.operationId,
          principalId: call.request.principalId,
          agentName: call.request.agentName,
        },
      ]).pipe(
        Effect.flatMap(() =>
          input.fail === true
            ? Effect.fail(new RegistryConnectionError())
            : Effect.succeed(input.result),
        ),
      ),
    lookup: () => Effect.succeed({ kind: "not_found" }),
    list: () =>
      Effect.succeed({ kind: "page", agentCards: [], hasMore: false }),
  };
  return Layer.succeed(Registry, service);
};

const provideRegistry = <A, E>(
  effect: Effect.Effect<A, E, Registry>,
  result: RegistryRegisterResult,
  calls: Ref.Ref<readonly DaemonRegistrationRequest[]>,
  fail = false,
) => Effect.provide(effect, registryLayer({ result, calls, fail }));

const registersAndActivates = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const memory = await Effect.runPromise(makeMemoryStore);
  const calls = await Effect.runPromise(
    Ref.make<readonly DaemonRegistrationRequest[]>([]),
  );
  const before = await Effect.runPromise(
    readDaemonRegistrationState({
      store: memory.store,
      bootstrap: fixture.bootstrap,
    }),
  );
  expect(before).toEqual({ kind: "unregistered" });
  const result = await Effect.runPromise(
    provideRegistry(
      registerDaemonIdentity({
        request: fixture.request,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      { kind: "registered", agentCard: fixture.agentCard },
      calls,
    ),
  );
  expect(result).toEqual({ kind: "registered", agentCard: fixture.agentCard });
  const after = await Effect.runPromise(
    readDaemonRegistrationState({
      store: memory.store,
      bootstrap: fixture.bootstrap,
    }),
  );
  expect(after).toEqual({ kind: "active", agentCard: fixture.agentCard });
};

const retriesAfterLocalPersistenceFailure = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const memory = await Effect.runPromise(makeMemoryStore);
  const calls = await Effect.runPromise(
    Ref.make<readonly DaemonRegistrationRequest[]>([]),
  );
  const result = { kind: "registered" as const, agentCard: fixture.agentCard };
  await Effect.runPromise(Ref.set(memory.failWrites, true));
  const firstFailure = await Effect.runPromise(
    Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: fixture.request,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        result,
        calls,
      ),
    ),
  );
  expect(firstFailure).toBeInstanceOf(DaemonRegistrationPersistenceError);
  expect(await Effect.runPromise(Ref.get(memory.binding))).toBeUndefined();

  await Effect.runPromise(Ref.set(memory.failWrites, false));
  const recovered = await Effect.runPromise(
    provideRegistry(
      registerDaemonIdentity({
        request: fixture.request,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      result,
      calls,
    ),
  );
  expect(recovered).toEqual(result);
  expect(await Effect.runPromise(Ref.get(calls))).toEqual([
    fixture.request,
    fixture.request,
  ]);
};

const keepsRegistryRefusalsUncommitted = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const memory = await Effect.runPromise(makeMemoryStore);
  const calls = await Effect.runPromise(
    Ref.make<readonly DaemonRegistrationRequest[]>([]),
  );
  const result = await Effect.runPromise(
    provideRegistry(
      registerDaemonIdentity({
        request: fixture.request,
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
      { kind: "name_taken" },
      calls,
    ),
  );
  expect(result).toEqual({ kind: "name_taken" });
  expect(await Effect.runPromise(Ref.get(memory.binding))).toBeUndefined();
};

const closesUpstreamAndRepresentationFailures = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const memory = await Effect.runPromise(makeMemoryStore);
  const calls = await Effect.runPromise(
    Ref.make<readonly DaemonRegistrationRequest[]>([]),
  );
  const upstream = await Effect.runPromise(
    Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: fixture.request,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        { kind: "name_taken" },
        calls,
        true,
      ),
    ),
  );
  expect(upstream).toBeInstanceOf(DaemonRegistrationUpstreamError);

  const mismatchedRequest = Schema.decodeUnknownSync(
    daemonRegistrationRequestSchema,
  )({ ...fixture.request, agentName: "agent-two" });
  const representation = await Effect.runPromise(
    Effect.flip(
      provideRegistry(
        registerDaemonIdentity({
          request: mismatchedRequest,
          store: memory.store,
          bootstrap: fixture.bootstrap,
        }),
        { kind: "registered", agentCard: fixture.agentCard },
        calls,
      ),
    ),
  );
  expect(representation).toBeInstanceOf(DaemonRegistrationRepresentationError);
};

const rejectsCorruptPreexistingBinding = async () => {
  const fixture = await Effect.runPromise(makeFixture);
  const memory = await Effect.runPromise(makeMemoryStore);
  await Effect.runPromise(
    Ref.set(memory.binding, {
      agentId: fixture.agentCard.agentId,
      canonicalAgentCard: new TextEncoder().encode("{}"),
    }),
  );
  const error = await Effect.runPromise(
    Effect.flip(
      readDaemonRegistrationState({
        store: memory.store,
        bootstrap: fixture.bootstrap,
      }),
    ),
  );
  expect(error).toBeInstanceOf(DaemonRegistrationRepresentationError);
};

// @agent-code-guard/regression-only: these examples pin crash recovery through Registry OperationId and one durable identity binding.
describe("daemon registration", () => {
  it(
    "moves from unregistered to active only after local binding",
    registersAndActivates,
  );
  it(
    "retries the same Registry request after local persistence failure",
    retriesAfterLocalPersistenceFailure,
  );
  it(
    "does not bind Registry domain refusals",
    keepsRegistryRefusalsUncommitted,
  );
  it(
    "closes upstream and cross-field representation failures",
    closesUpstreamAndRepresentationFailures,
  );
  it(
    "fails closed on a corrupt preexisting binding",
    rejectsCorruptPreexistingBinding,
  );
});

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults. */
