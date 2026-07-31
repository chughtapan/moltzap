import { FileSystem, HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import {
  AgentCard,
  AgentName,
  AgentSigningAuthority,
  AuthenticatedHttp,
  MessageId,
  OperationId,
  PrincipalId,
  Registry,
  SignedMessage,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  type RegistryLookupRequest,
  type RegistryRegisterRequest,
  type SignedMessage as SignedMessageValue,
  type VerifiedAgentCard,
} from "@moltzap/v2-identity";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { expect, it } from "vitest";
import {
  Router,
  type RouterPollRequest,
  type RouterPollResult,
  type RouterSendRequest,
  type RouterSendResult,
} from "../index.js";

const LOOPBACK_HOST = "127.0.0.1";
const ADMISSION_CREDENTIAL = "registry-router-e2e-admission";
const REGISTERED_KIND = "registered";
const FOUND_KIND = "found";
const BATCH_KIND = "batch";
const ACCEPTED_KIND = "accepted";
const ROUTER_RESTARTED_KIND = "router_restarted";
const CURSOR_INVALID_RESULT = Object.freeze({ kind: "cursor_invalid" });
const OK_STATUS = 200;
const NO_CONTENT_STATUS = 204;
const AUTHENTICATION_FAILED_STATUS = 401;
const OVERLOADED_STATUS = 429;
const UNAVAILABLE_STATUS = 503;
const EMPTY_BODY = "";
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 25;
const JSON_CONTENT_TYPE = "application/json";
const MESSAGE_INVALID_BODY = '{"kind":"message_invalid"}';
const OVERLOADED_BODY = '{"error":"overloaded"}';
const AUTHENTICATION_FAILED_BODY = '{"error":"authentication_failed"}';
const UNAVAILABLE_BODY = '{"error":"unavailable"}';
const BATCH_BODY_FRAGMENT = '"kind":"batch"';
const WORKSPACE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const PGLITE_BINARY = join(
  WORKSPACE_ROOT,
  "v2/identity/node_modules/.bin/pglite-server",
);
const REGISTRY_BINARY = join(
  WORKSPACE_ROOT,
  "v2/identity/bin/moltzap-registry",
);
const ROUTER_BINARY = join(WORKSPACE_ROOT, "v2/router/bin/moltzap-router");

interface RunningProcess {
  readonly child: ChildProcess;
  readonly logs: () => string;
}

interface RegisteredAgent {
  readonly signingAuthority: AgentSigningAuthorityValue;
  readonly agentCard: VerifiedAgentCard;
}

interface RegisteredAgents {
  readonly sender: RegisteredAgent;
  readonly firstRecipient: RegisteredAgent;
  readonly secondRecipient: RegisteredAgent;
  readonly nonRecipient: RegisteredAgent;
}

interface Infrastructure {
  readonly registryOrigin: URL;
  readonly registryProcess: RunningProcess;
  readonly routerOrigin: URL;
  readonly routerPort: number;
  readonly registrySignerPublicKey: ReturnType<
    typeof AgentSigningAuthority.publicKey
  >;
}

type BatchResult = Extract<RouterPollResult, { readonly kind: "batch" }>;
type AcceptedResult = Extract<RouterSendResult, { readonly kind: "accepted" }>;
type RegistryRunner = <A, E>(
  effect: Effect.Effect<A, E, Registry>,
) => Effect.Effect<A, E>;
type RouterRunner = <A, E>(
  effect: Effect.Effect<A, E, Router>,
) => Effect.Effect<A, E>;

interface PollAnchors {
  readonly firstRecipient: BatchResult;
  readonly secondRecipient: BatchResult;
  readonly nonRecipient: BatchResult;
}

interface SentMessage {
  readonly initialRequest: RouterSendRequest;
  readonly accepted: AcceptedResult;
  readonly firstRecipientDelivery: BatchResult;
}

interface HttpObservation {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

class ProcessTestError extends Data.TaggedError("ProcessTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const processTestError = (message: string, cause?: unknown): ProcessTestError =>
  new ProcessTestError({ message, cause });

const reservePort = Effect.async<number, ProcessTestError>((resume) => {
  const server = createServer();
  const onError = (error: Error): void => {
    resume(Effect.fail(processTestError("could not reserve a port", error)));
  };
  server.once("error", onError);
  server.listen(0, LOOPBACK_HOST, () => {
    server.removeListener("error", onError);
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      resume(
        Effect.fail(processTestError("ephemeral listener exposed no port")),
      );
      return;
    }
    server.close((error) => {
      resume(
        error === undefined
          ? Effect.succeed(address.port)
          : Effect.fail(
              processTestError("could not release reserved port", error),
            ),
      );
    });
  });
  return Effect.sync(() => {
    if (server.listening) {
      server.close();
    }
  });
});

const startProcess = (
  executable: string,
  processArguments: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): RunningProcess => {
  const child = spawn(executable, processArguments, {
    cwd: WORKSPACE_ROOT,
    env: {
      PATH: CHILD_PATH,
      ...environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });
  return {
    child,
    logs: () => output,
  };
};

const canConnect = (port: number) =>
  Effect.async<boolean>((resume) => {
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    const finish = (connected: boolean): void => {
      socket.destroy();
      resume(Effect.succeed(connected));
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    return Effect.sync(() => {
      socket.destroy();
    });
  });

const waitForTcpListener = (runningProcess: RunningProcess, port: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (
        runningProcess.child.exitCode !== null ||
        runningProcess.child.signalCode !== null
      ) {
        return yield* Effect.fail(
          processTestError(
            `process exited before listening\n${runningProcess.logs()}`,
          ),
        );
      }
      if (yield* canConnect(port)) {
        return;
      }
      yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
    }
    return yield* Effect.fail(
      processTestError(
        `process did not listen before timeout\n${runningProcess.logs()}`,
      ),
    );
  });

const waitForHealth = (runningProcess: RunningProcess, origin: URL) =>
  Effect.gen(function* () {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    const healthUrl = new URL("/healthz", origin);
    while (Date.now() < deadline) {
      if (
        runningProcess.child.exitCode !== null ||
        runningProcess.child.signalCode !== null
      ) {
        return yield* Effect.fail(
          processTestError(
            `process exited before readiness\n${runningProcess.logs()}`,
          ),
        );
      }
      const response = yield* HttpClient.get(healthUrl).pipe(
        Effect.flatMap((result) =>
          result.text.pipe(
            Effect.map((body) => ({ status: result.status, body })),
          ),
        ),
        Effect.option,
      );
      if (
        Option.isSome(response) &&
        response.value.status === NO_CONTENT_STATUS
      ) {
        return response.value;
      }
      yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
    }
    return yield* Effect.fail(
      processTestError(
        `process did not become ready\n${runningProcess.logs()}`,
      ),
    );
  });

const assertHealthy = (runningProcess: RunningProcess, origin: URL) =>
  Effect.gen(function* () {
    const health = yield* waitForHealth(runningProcess, origin);
    expect(health.status).toBe(NO_CONTENT_STATUS);
    expect(health.body).toBe(EMPTY_BODY);
  });

const waitForExit = (runningProcess: RunningProcess) => {
  if (
    runningProcess.child.exitCode !== null ||
    runningProcess.child.signalCode !== null
  ) {
    return Effect.void;
  }
  return Effect.async<undefined>((resume) => {
    const onExit = (): void => {
      resume(Effect.succeed(undefined));
    };
    runningProcess.child.once("exit", onExit);
    return Effect.sync(() => {
      runningProcess.child.removeListener("exit", onExit);
    });
  });
};

const stopProcess = (runningProcess: RunningProcess) =>
  Effect.gen(function* () {
    if (
      runningProcess.child.exitCode !== null ||
      runningProcess.child.signalCode !== null
    ) {
      return;
    }
    runningProcess.child.kill("SIGTERM");
    const stopped = yield* Effect.raceFirst(
      waitForExit(runningProcess).pipe(Effect.as(true)),
      Effect.sleep(Duration.millis(SHUTDOWN_TIMEOUT_MS)).pipe(Effect.as(false)),
    );
    if (!stopped) {
      runningProcess.child.kill("SIGKILL");
      yield* waitForExit(runningProcess);
    }
  });

const managedProcess = (
  executable: string,
  processArguments: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.acquireRelease(
    Effect.sync(() => startProcess(executable, processArguments, environment)),
    stopProcess,
  );

const makePrivateKeyPem = (): string => {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ format: "pem", type: "pkcs8" });
};

const makeSigningAuthority = (privateKeyPem?: string) =>
  AgentSigningAuthority.fromPkcs8(
    Redacted.make(privateKeyPem ?? makePrivateKeyPem()),
  );

const randomIdentifierPayload = (): string =>
  randomBytes(16).toString("base64url");

const makeOperationId = () =>
  Schema.decodeUnknownSync(OperationId)(`opn_${randomIdentifierPayload()}`);

const makePrincipalId = () =>
  Schema.decodeUnknownSync(PrincipalId)(`prn_${randomIdentifierPayload()}`);

const makeMessageId = () =>
  Schema.decodeUnknownSync(MessageId)(`msg_${randomIdentifierPayload()}`);

const makeRegistryRunner = (
  origin: URL,
  registrySignerPublicKey: Infrastructure["registrySignerPublicKey"],
): RegistryRunner => {
  const registryLayer = Registry.layer({
    origin,
    registrySignerPublicKey,
    requestTimeout: Duration.seconds(5),
  }).pipe(Layer.provide(NodeHttpClient.layer));
  return (effect) => effect.pipe(Effect.provide(registryLayer));
};

const makeRouterRunner = (origin: URL): RouterRunner => {
  const routerLayer = Router.layer({
    origin,
    sendTimeout: Duration.seconds(5),
    pollTimeout: Duration.seconds(35),
  }).pipe(Layer.provide(NodeHttpClient.layer));
  return (effect) => effect.pipe(Effect.provide(routerLayer));
};

const signAuthenticatedRequest = (
  origin: URL,
  path: string,
  agent: RegisteredAgent,
  encodedRequest: unknown,
) =>
  AuthenticatedHttp.signAgentRequest({
    httpRequest: HttpClientRequest.post(new URL(path, origin)),
    callerAgentId: agent.agentCard.agentId,
    encodedRequest,
    signingAuthority: agent.signingAuthority,
  });

const observeHttpRequest = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    const body = yield* response.text;
    return {
      status: response.status,
      contentType: response.headers["content-type"] ?? "",
      body,
    } satisfies HttpObservation;
  });

const expectHttpObservation = (
  observation: HttpObservation,
  status: number,
  body: string,
): void => {
  expect(observation.status).toBe(status);
  expect(observation.contentType).toBe(JSON_CONTENT_TYPE);
  expect(observation.body).toBe(body);
};

const registerAgent = (name: string, runRegistry: RegistryRunner) =>
  Effect.gen(function* () {
    const signingAuthority = yield* makeSigningAuthority();
    const request = {
      operationId: makeOperationId(),
      principalId: makePrincipalId(),
      agentName: Schema.decodeUnknownSync(AgentName)(name),
      publicKey: AgentSigningAuthority.publicKey(signingAuthority),
    } satisfies RegistryRegisterRequest;
    const result = yield* runRegistry(
      Registry.register({
        request,
        admissionCredential: Redacted.make(ADMISSION_CREDENTIAL),
        signingAuthority,
      }),
    );
    expect(result.kind).toBe(REGISTERED_KIND);
    if (result.kind !== REGISTERED_KIND) {
      return yield* Effect.fail(
        processTestError(`registration returned ${result.kind}`),
      );
    }
    return {
      signingAuthority,
      agentCard: result.agentCard,
    } satisfies RegisteredAgent;
  });

const requireBatch = (result: RouterPollResult): BatchResult => {
  expect(result.kind).toBe(BATCH_KIND);
  if (result.kind !== BATCH_KIND) {
    throw processTestError(`poll returned ${result.kind}`);
  }
  return result;
};

const requireAccepted = (result: RouterSendResult): AcceptedResult => {
  expect(result.kind).toBe(ACCEPTED_KIND);
  if (result.kind !== ACCEPTED_KIND) {
    throw processTestError(`send returned ${result.kind}`);
  }
  return result;
};

const encodeAgentCard = (agentCard: VerifiedAgentCard) =>
  Schema.encode(AgentCard)(agentCard);

const encodeSignedMessage = (signedMessage: SignedMessageValue) =>
  Schema.encode(SignedMessage)(signedMessage);

const makeRegistryIdentity = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "moltzap-registry-router-",
  });
  const registryPrivateKeyPath = join(temporaryDirectory, "registry-key.pem");
  const registryPrivateKeyPem = makePrivateKeyPem();
  yield* fileSystem.writeFileString(
    registryPrivateKeyPath,
    registryPrivateKeyPem,
    { mode: 0o600 },
  );
  const registrySigningAuthority = yield* makeSigningAuthority(
    registryPrivateKeyPem,
  );
  const registrySignerPublicKey = AgentSigningAuthority.publicKey(
    registrySigningAuthority,
  );
  return { registryPrivateKeyPath, registrySignerPublicKey };
});

const startInfrastructure = Effect.gen(function* () {
  const { registryPrivateKeyPath, registrySignerPublicKey } =
    yield* makeRegistryIdentity;
  const [postgresqlPort, registryPort, routerPort] = yield* Effect.all(
    [reservePort, reservePort, reservePort] as const,
    { concurrency: 3 },
  );
  const registryOrigin = new URL(`http://${LOOPBACK_HOST}:${registryPort}`);
  const postgresql = yield* managedProcess(PGLITE_BINARY, [
    "--db=memory://",
    `--port=${postgresqlPort}`,
    `--host=${LOOPBACK_HOST}`,
    "--max-connections=20",
  ]);
  yield* waitForTcpListener(postgresql, postgresqlPort);
  const registry = yield* managedProcess(REGISTRY_BINARY, [], {
    MOLTZAP_REGISTRY_HOST: LOOPBACK_HOST,
    MOLTZAP_REGISTRY_PORT: String(registryPort),
    MOLTZAP_REGISTRY_POSTGRESQL_URL: `postgresql://postgres:postgres@${LOOPBACK_HOST}:${postgresqlPort}/postgres`,
    MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL: ADMISSION_CREDENTIAL,
    MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH: registryPrivateKeyPath,
  });
  yield* assertHealthy(registry, registryOrigin);
  return {
    registryOrigin,
    registryProcess: registry,
    routerOrigin: new URL(`http://${LOOPBACK_HOST}:${routerPort}`),
    routerPort,
    registrySignerPublicKey,
  } satisfies Infrastructure;
});

const startRouterAt = (
  infrastructure: Infrastructure,
  port: number,
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const router = yield* managedProcess(ROUTER_BINARY, [], {
      MOLTZAP_ROUTER_HOST: LOOPBACK_HOST,
      MOLTZAP_ROUTER_PORT: String(port),
      MOLTZAP_ROUTER_REGISTRY_ORIGIN: infrastructure.registryOrigin.origin,
      MOLTZAP_ROUTER_REGISTRY_SIGNER_PUBLIC_KEY: JSON.stringify({
        crv: infrastructure.registrySignerPublicKey.crv,
        kty: infrastructure.registrySignerPublicKey.kty,
        x: infrastructure.registrySignerPublicKey.x,
      }),
      ...environment,
    });
    yield* assertHealthy(router, new URL(`http://${LOOPBACK_HOST}:${port}`));
    return router;
  });

const startRouter = (infrastructure: Infrastructure) =>
  startRouterAt(infrastructure, infrastructure.routerPort);

const registerAgents = (runRegistry: RegistryRunner) =>
  Effect.gen(function* () {
    const [sender, firstRecipient, secondRecipient, nonRecipient] =
      yield* Effect.all(
        [
          registerAgent("sender-agent", runRegistry),
          registerAgent("recipient-one", runRegistry),
          registerAgent("recipient-two", runRegistry),
          registerAgent("non-recipient", runRegistry),
        ] as const,
        { concurrency: 1 },
      );
    return {
      sender,
      firstRecipient,
      secondRecipient,
      nonRecipient,
    } satisfies RegisteredAgents;
  });

const assertAgentLookups = (
  agents: RegisteredAgents,
  runRegistry: RegistryRunner,
) =>
  Effect.forEach(
    [
      agents.sender,
      agents.firstRecipient,
      agents.secondRecipient,
      agents.nonRecipient,
    ],
    (registeredAgent) =>
      Effect.gen(function* () {
        const request = {
          agentId: registeredAgent.agentCard.agentId,
        } satisfies RegistryLookupRequest;
        const lookup = yield* runRegistry(Registry.lookup(request));
        expect(lookup.kind).toBe(FOUND_KIND);
        if (lookup.kind !== FOUND_KIND) {
          return yield* Effect.fail(
            processTestError("registered identity was not found"),
          );
        }
        const [actual, expected] = yield* Effect.all(
          [
            encodeAgentCard(lookup.agentCard),
            encodeAgentCard(registeredAgent.agentCard),
          ] as const,
          { concurrency: 2 },
        );
        expect(actual).toStrictEqual(expected);
      }),
    { concurrency: 1, discard: true },
  );

const anchorFeeds = (agents: RegisteredAgents, runRouter: RouterRunner) =>
  Effect.gen(function* () {
    const anchor = (agent: RegisteredAgent) =>
      runRouter(
        Router.poll({
          request: {} satisfies RouterPollRequest,
          callerAgentId: agent.agentCard.agentId,
          signingAuthority: agent.signingAuthority,
        }),
      ).pipe(Effect.map(requireBatch));
    const [firstRecipient, secondRecipient, nonRecipient] = yield* Effect.all(
      [
        anchor(agents.firstRecipient),
        anchor(agents.secondRecipient),
        anchor(agents.nonRecipient),
      ] as const,
      { concurrency: 3 },
    );
    expect(firstRecipient.signedMessages).toHaveLength(0);
    expect(secondRecipient.routerInstanceId).toBe(
      firstRecipient.routerInstanceId,
    );
    expect(nonRecipient.routerInstanceId).toBe(firstRecipient.routerInstanceId);
    return {
      firstRecipient,
      secondRecipient,
      nonRecipient,
    } satisfies PollAnchors;
  });

const invalidSignedMessageShapes: readonly unknown[] = Object.freeze([
  "not-a-signed-message",
  null,
  Object.freeze([]),
]);

const assertInvalidSignedMessageShapes = (
  infrastructure: Infrastructure,
  sender: RegisteredAgent,
  routerInstanceId: BatchResult["routerInstanceId"],
) =>
  Effect.forEach(
    invalidSignedMessageShapes,
    (signedMessage) =>
      Effect.gen(function* () {
        const request = yield* signAuthenticatedRequest(
          infrastructure.routerOrigin,
          "/v1/messages:send",
          sender,
          {
            expectedRouterInstanceId: routerInstanceId,
            mode: "initial",
            signedMessage,
          },
        );
        const observation = yield* observeHttpRequest(request);
        expectHttpObservation(observation, OK_STATUS, MESSAGE_INVALID_BODY);
      }),
    { concurrency: 1, discard: true },
  );

const signMessage = (
  agents: RegisteredAgents,
): Effect.Effect<SignedMessageValue, unknown> =>
  SignedMessage.sign({
    agentCard: agents.sender.agentCard,
    signingAuthority: agents.sender.signingAuthority,
    recipientAgentIds: new Set([
      agents.firstRecipient.agentCard.agentId,
      agents.secondRecipient.agentCard.agentId,
    ]),
    messageId: makeMessageId(),
    body: new TextEncoder().encode("opaque-registry-router-e2e"),
  });

const assertNonceCapacityWithoutEviction = (
  infrastructure: Infrastructure,
  sender: RegisteredAgent,
) =>
  Effect.gen(function* () {
    const port = yield* reservePort;
    const origin = new URL(`http://${LOOPBACK_HOST}:${port}`);
    const router = yield* startRouterAt(infrastructure, port, {
      MOLTZAP_ROUTER_LIVE_NONCE_CAPACITY: "1",
    });
    const firstRequest = yield* signAuthenticatedRequest(
      origin,
      "/v1/messages:poll",
      sender,
      {},
    );
    const first = yield* observeHttpRequest(firstRequest);
    expect(first.status).toBe(OK_STATUS);
    expect(first.contentType).toBe(JSON_CONTENT_TYPE);
    expect(first.body).toContain(BATCH_BODY_FRAGMENT);

    const novelRequest = yield* signAuthenticatedRequest(
      origin,
      "/v1/messages:poll",
      sender,
      {},
    );
    expectHttpObservation(
      yield* observeHttpRequest(novelRequest),
      OVERLOADED_STATUS,
      OVERLOADED_BODY,
    );
    expectHttpObservation(
      yield* observeHttpRequest(firstRequest),
      AUTHENTICATION_FAILED_STATUS,
      AUTHENTICATION_FAILED_BODY,
    );
    yield* stopProcess(router);
  });

const sendInitial = (
  signedMessage: SignedMessageValue,
  sender: RegisteredAgent,
  expectedRouterInstanceId: BatchResult["routerInstanceId"],
  runRouter: RouterRunner,
) =>
  Effect.gen(function* () {
    const initialRequest = {
      expectedRouterInstanceId,
      mode: "initial",
      signedMessage,
    } satisfies RouterSendRequest;
    const accepted = requireAccepted(
      yield* runRouter(
        Router.send({
          request: initialRequest,
          callerAgentId: sender.agentCard.agentId,
          signingAuthority: sender.signingAuthority,
        }),
      ),
    );
    expect(accepted.routerInstanceId).toBe(expectedRouterInstanceId);
    return { initialRequest, accepted };
  });

const pollDeliveries = (
  agents: RegisteredAgents,
  anchors: PollAnchors,
  runRouter: RouterRunner,
) => {
  const continuePoll = (
    agent: RegisteredAgent,
    pollCursor: NonNullable<RouterPollRequest["pollCursor"]>,
  ) =>
    runRouter(
      Router.poll({
        request: { pollCursor } satisfies RouterPollRequest,
        callerAgentId: agent.agentCard.agentId,
        signingAuthority: agent.signingAuthority,
      }),
    ).pipe(Effect.map(requireBatch));
  return Effect.all(
    [
      continuePoll(agents.firstRecipient, anchors.firstRecipient.pollCursor),
      continuePoll(agents.secondRecipient, anchors.secondRecipient.pollCursor),
      continuePoll(agents.nonRecipient, anchors.nonRecipient.pollCursor),
    ] as const,
    { concurrency: 3 },
  );
};

const assertExactDeliveries = (
  signedMessage: SignedMessageValue,
  agents: RegisteredAgents,
  firstDelivery: BatchResult,
  secondDelivery: BatchResult,
) =>
  Effect.gen(function* () {
    const firstMessage = firstDelivery.signedMessages[0];
    const secondMessage = secondDelivery.signedMessages[0];
    if (firstMessage === undefined || secondMessage === undefined) {
      return yield* Effect.fail(
        processTestError("explicit recipient did not receive the message"),
      );
    }
    yield* Effect.all(
      [
        SignedMessage.verify({
          signedMessage: firstMessage,
          agentCard: agents.sender.agentCard,
        }),
        SignedMessage.verify({
          signedMessage: secondMessage,
          agentCard: agents.sender.agentCard,
        }),
      ] as const,
      { concurrency: 2 },
    );
    const [expected, firstActual, secondActual] = yield* Effect.all(
      [
        encodeSignedMessage(signedMessage),
        encodeSignedMessage(firstMessage),
        encodeSignedMessage(secondMessage),
      ] as const,
      { concurrency: 3 },
    );
    expect(firstActual).toStrictEqual(expected);
    expect(secondActual).toStrictEqual(expected);
  });

const sendAndReceive = (
  agents: RegisteredAgents,
  anchors: PollAnchors,
  runRouter: RouterRunner,
) =>
  Effect.gen(function* () {
    const signedMessage = yield* signMessage(agents);
    const { initialRequest, accepted } = yield* sendInitial(
      signedMessage,
      agents.sender,
      anchors.firstRecipient.routerInstanceId,
      runRouter,
    );
    const [firstDelivery, secondDelivery, nonRecipientDelivery] =
      yield* pollDeliveries(agents, anchors, runRouter);
    expect(firstDelivery.signedMessages).toHaveLength(1);
    expect(secondDelivery.signedMessages).toHaveLength(1);
    expect(nonRecipientDelivery.signedMessages).toHaveLength(0);
    expect(firstDelivery.routerInstanceId).toBe(accepted.routerInstanceId);
    expect(secondDelivery.routerInstanceId).toBe(accepted.routerInstanceId);
    yield* assertExactDeliveries(
      signedMessage,
      agents,
      firstDelivery,
      secondDelivery,
    );
    const retry = yield* runRouter(
      Router.send({
        request: { ...initialRequest, mode: "retry" },
        callerAgentId: agents.sender.agentCard.agentId,
        signingAuthority: agents.sender.signingAuthority,
      }),
    );
    expect(retry).toStrictEqual(accepted);
    return {
      initialRequest,
      accepted,
      firstRecipientDelivery: firstDelivery,
    } satisfies SentMessage;
  });

const assertRestartFence = (
  sentMessage: SentMessage,
  sender: RegisteredAgent,
  runRouter: RouterRunner,
) =>
  Effect.gen(function* () {
    const fencedSend = yield* runRouter(
      Router.send({
        request: sentMessage.initialRequest,
        callerAgentId: sender.agentCard.agentId,
        signingAuthority: sender.signingAuthority,
      }),
    );
    expect(fencedSend.kind).toBe(ROUTER_RESTARTED_KIND);
    if (fencedSend.kind !== ROUTER_RESTARTED_KIND) {
      return yield* Effect.fail(
        processTestError(`restart fence returned ${fencedSend.kind}`),
      );
    }
    expect(fencedSend.routerInstanceId).not.toBe(
      sentMessage.accepted.routerInstanceId,
    );
    return fencedSend.routerInstanceId;
  });

const assertMalformedMessageRemainsFenced = (
  infrastructure: Infrastructure,
  sentMessage: SentMessage,
  sender: RegisteredAgent,
  currentRouterInstanceId: BatchResult["routerInstanceId"],
) =>
  Effect.gen(function* () {
    const request = yield* signAuthenticatedRequest(
      infrastructure.routerOrigin,
      "/v1/messages:send",
      sender,
      {
        expectedRouterInstanceId: sentMessage.accepted.routerInstanceId,
        mode: "initial",
        signedMessage: null,
      },
    );
    expectHttpObservation(
      yield* observeHttpRequest(request),
      OK_STATUS,
      JSON.stringify({
        kind: ROUTER_RESTARTED_KIND,
        routerInstanceId: currentRouterInstanceId,
      }),
    );
  });

const assertCursorInvalidation = (
  sentMessage: SentMessage,
  firstRecipient: RegisteredAgent,
  currentRouterInstanceId: BatchResult["routerInstanceId"],
  runRouter: RouterRunner,
) =>
  Effect.gen(function* () {
    const invalidatedCursor = yield* runRouter(
      Router.poll({
        request: {
          pollCursor: sentMessage.firstRecipientDelivery.pollCursor,
        },
        callerAgentId: firstRecipient.agentCard.agentId,
        signingAuthority: firstRecipient.signingAuthority,
      }),
    );
    expect(invalidatedCursor).toStrictEqual(CURSOR_INVALID_RESULT);
    const newAnchor = requireBatch(
      yield* runRouter(
        Router.poll({
          request: {},
          callerAgentId: firstRecipient.agentCard.agentId,
          signingAuthority: firstRecipient.signingAuthority,
        }),
      ),
    );
    expect(newAnchor.routerInstanceId).toBe(currentRouterInstanceId);
    expect(newAnchor.signedMessages).toHaveLength(0);
  });

const assertCachedCallerSurvivesRegistryOutage = (
  infrastructure: Infrastructure,
  agents: RegisteredAgents,
  currentRouterInstanceId: BatchResult["routerInstanceId"],
  runRouter: RouterRunner,
) =>
  Effect.gen(function* () {
    yield* stopProcess(infrastructure.registryProcess);

    const cachedPoll = requireBatch(
      yield* runRouter(
        Router.poll({
          request: {},
          callerAgentId: agents.sender.agentCard.agentId,
          signingAuthority: agents.sender.signingAuthority,
        }),
      ),
    );
    expect(cachedPoll.routerInstanceId).toBe(currentRouterInstanceId);

    const signedMessage = yield* signMessage(agents);
    const cachedSend = yield* sendInitial(
      signedMessage,
      agents.sender,
      currentRouterInstanceId,
      runRouter,
    );
    expect(cachedSend.accepted.kind).toBe(ACCEPTED_KIND);

    const uncachedRequest = yield* signAuthenticatedRequest(
      infrastructure.routerOrigin,
      "/v1/messages:poll",
      agents.secondRecipient,
      {},
    );
    expectHttpObservation(
      yield* observeHttpRequest(uncachedRequest),
      UNAVAILABLE_STATUS,
      UNAVAILABLE_BODY,
    );
  });

const runEndToEndBehavior = Effect.gen(function* () {
  const infrastructure = yield* startInfrastructure;
  const firstRouterProcess = yield* startRouter(infrastructure);
  const runRegistry = makeRegistryRunner(
    infrastructure.registryOrigin,
    infrastructure.registrySignerPublicKey,
  );
  const firstRouter = makeRouterRunner(infrastructure.routerOrigin);
  const agents = yield* registerAgents(runRegistry);
  yield* assertAgentLookups(agents, runRegistry);
  const anchors = yield* anchorFeeds(agents, firstRouter);
  yield* assertInvalidSignedMessageShapes(
    infrastructure,
    agents.sender,
    anchors.firstRecipient.routerInstanceId,
  );
  const sentMessage = yield* sendAndReceive(agents, anchors, firstRouter);
  yield* assertNonceCapacityWithoutEviction(infrastructure, agents.sender);

  yield* stopProcess(firstRouterProcess);
  yield* startRouter(infrastructure);
  const restartedRouter = makeRouterRunner(infrastructure.routerOrigin);
  const currentRouterInstanceId = yield* assertRestartFence(
    sentMessage,
    agents.sender,
    restartedRouter,
  );
  yield* assertMalformedMessageRemainsFenced(
    infrastructure,
    sentMessage,
    agents.sender,
    currentRouterInstanceId,
  );
  yield* assertCursorInvalidation(
    sentMessage,
    agents.firstRecipient,
    currentRouterInstanceId,
    restartedRouter,
  );
  yield* assertCachedCallerSurvivesRegistryOutage(
    infrastructure,
    agents,
    currentRouterInstanceId,
    restartedRouter,
  );
}).pipe(
  Effect.scoped,
  Effect.provide(NodeFileSystem.layer),
  Effect.provide(NodeHttpClient.layer),
);

it("registers identities and preserves opaque multicast behavior across Router restart", () => {
  expect.hasAssertions();
  return Effect.runPromise(runEndToEndBehavior);
}, 120_000);
