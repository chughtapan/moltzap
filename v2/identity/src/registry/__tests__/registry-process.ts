import { HttpClient, HttpClientRequest } from "@effect/platform";
import { NodeHttpClient } from "@effect/platform-node";
import { httpbis } from "http-message-signatures";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, webcrypto } from "node:crypto";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Exact duplicate and chunked framing requires Node's raw HTTP adapter.
import { request as makeHttpRequest, type IncomingMessage } from "node:http";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentName,
  AgentSigningAuthority,
  PrincipalId,
  type AgentSigningAuthority as AgentSigningAuthorityValue,
  type VerifiedAgentCard,
} from "../../index.js";
import {
  OperationId,
  Registry,
  RegistryRegisterRequest,
  type RegistryRegisterRequest as RegistryRegisterRequestValue,
} from "../../registry.js";
import {
  agentSigningPrivateKey,
  ed25519PublicKeyThumbprintUri,
} from "../../agent-key.js";
import { encodeCanonicalJson } from "../../canonical-json.js";
import { contentDigest } from "../../http-signature.js";
import {
  Clock,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
} from "effect";

const LOOPBACK_HOST = "127.0.0.1";
const ADMISSION_CREDENTIAL = "registry-binary-admission";
const READY_STATUS = 204;
const STARTUP_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 25;
const RAW_REQUEST_TIMEOUT = Duration.seconds(5);
const REGISTRATION_SIGNATURE_FIELDS = [
  "@method",
  "@authority",
  "@path",
  "@query",
  "content-digest",
  "content-type",
  "moltzap-version",
  "authorization",
] as const;
const SIGNATURE_PARAMETERS = [
  "created",
  "expires",
  "keyid",
  "nonce",
  "alg",
  "tag",
] as const;
const WORKSPACE_ROOT = fileURLToPath(
  new URL("../../../../../", import.meta.url),
);
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const PGLITE_BINARY = join(
  WORKSPACE_ROOT,
  "v2/identity/node_modules/.bin/pglite-server",
);
const REGISTRY_BINARY = join(
  WORKSPACE_ROOT,
  "v2/identity/bin/moltzap-registry",
);

interface RunningProcess {
  readonly child: ChildProcess;
  readonly logs: () => string;
}

interface RawHttpResponse {
  readonly status: number;
  readonly body: string;
}

interface RegisteredAgent {
  readonly request: RegistryRegisterRequestValue;
  readonly signingAuthority: AgentSigningAuthority;
  readonly agentCard: VerifiedAgentCard;
}

type RegistryRunner = <A, E>(
  effect: Effect.Effect<A, E, Registry>,
) => Effect.Effect<A, E>;

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
  environment: Readonly<Record<string, string>>,
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

const waitForHealthStatus = (input: {
  readonly runningProcess: RunningProcess;
  readonly origin: URL;
  readonly expectedStatus: number;
}) =>
  Effect.gen(function* () {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    const healthUrl = new URL("/healthz", input.origin);
    while (Date.now() < deadline) {
      if (
        input.runningProcess.child.exitCode !== null ||
        input.runningProcess.child.signalCode !== null
      ) {
        return yield* Effect.fail(
          processTestError(
            `process exited before health response\n${input.runningProcess.logs()}`,
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
        response.value.status === input.expectedStatus
      ) {
        return response.value;
      }
      yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
    }
    return yield* Effect.fail(
      processTestError(
        `process did not reach health ${input.expectedStatus}\n${input.runningProcess.logs()}`,
      ),
    );
  });

const readRawResponse = (
  response: IncomingMessage,
  resume: (effect: Effect.Effect<RawHttpResponse, ProcessTestError>) => void,
): void => {
  const chunks: Uint8Array[] = [];
  response.on("data", (chunk: Uint8Array) => {
    chunks.push(chunk);
  });
  response.once("error", (error) => {
    resume(
      Effect.fail(processTestError("could not read Registry response", error)),
    );
  });
  response.once("end", () => {
    resume(
      Effect.succeed({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
};

const requestHeaders = (
  port: number,
  headers?: ReadonlyArray<readonly [string, string]>,
) => {
  if (headers === undefined) {
    return undefined;
  }
  const names = new Set<string>();
  let hasDuplicate = false;
  for (const header of headers) {
    const normalized = header.at(0)?.toLowerCase() ?? "";
    hasDuplicate ||= names.has(normalized);
    names.add(normalized);
  }
  if (!hasDuplicate) {
    return Object.fromEntries([
      ["host", `${LOOPBACK_HOST}:${port}`],
      ...headers,
    ]);
  }
  return [
    "host",
    `${LOOPBACK_HOST}:${port}`,
    ...headers.flatMap(([name, value]) => [name, value]),
  ];
};
const sendRawRequest = (input: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
  readonly body?: string;
  readonly description?: string;
}) =>
  Effect.async<RawHttpResponse, ProcessTestError>((resume) => {
    const description = input.description ?? `${input.method} ${input.path}`;
    const request = makeHttpRequest(
      {
        host: LOOPBACK_HOST,
        port: input.port,
        method: input.method,
        path: input.path,
        headers: requestHeaders(input.port, input.headers),
      },
      (response) => {
        readRawResponse(response, resume);
      },
    );
    request.once("error", (error) => {
      resume(
        Effect.fail(
          processTestError(`${description} failed: ${String(error)}`, error),
        ),
      );
    });
    if (input.body !== undefined) {
      request.write(input.body);
    }
    request.end();
    return Effect.sync(() => {
      request.destroy();
    });
  });

const parseRawSocketResponse = (
  description: string,
  bytes: Uint8Array,
): Effect.Effect<RawHttpResponse, ProcessTestError> => {
  const response = Buffer.from(bytes).toString("utf8");
  const separator = response.indexOf("\r\n\r\n");
  if (separator < 0) {
    return Effect.fail(
      processTestError(`${description} returned no HTTP header block`),
    );
  }
  const statusLine = response.slice(0, separator).split("\r\n")[0] ?? "";
  const statusMatch = /^HTTP\/1\.[01] (\d{3}) /.exec(statusLine);
  if (statusMatch?.[1] === undefined) {
    return Effect.fail(
      processTestError(`${description} returned an invalid status line`),
    );
  }
  return Effect.succeed({
    status: Number(statusMatch[1]),
    body: response.slice(separator + 4),
  });
};

const beginRawSocketRequest = (
  port: number,
  description: string,
  request: string,
) =>
  Effect.async<RawHttpResponse, ProcessTestError>((resume) => {
    const chunks: Uint8Array[] = [];
    const socket = createConnection({ host: LOOPBACK_HOST, port });
    socket.on("data", (chunk: Uint8Array) => {
      chunks.push(chunk);
    });
    socket.once("connect", () => {
      socket.end(request);
    });
    socket.once("error", (cause) => {
      resume(Effect.fail(processTestError(`${description} failed`, cause)));
    });
    socket.once("end", () => {
      resume(parseRawSocketResponse(description, Buffer.concat(chunks)));
    });
    return Effect.sync(() => {
      socket.destroy();
    });
  });

const rawSocketRequest = (port: number, description: string, request: string) =>
  beginRawSocketRequest(port, description, request).pipe(
    Effect.timeoutFail({
      duration: RAW_REQUEST_TIMEOUT,
      onTimeout: () => processTestError(`${description} timed out`),
    }),
  );

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
  // eslint-disable-next-line agent-code-guard/acquire-release-requires-scope -- Every importing integration behavior encloses this fixture in Effect.scoped.
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

const makeRegistryRunner = (
  origin: URL,
  registrySignerPublicKey: ReturnType<typeof AgentSigningAuthority.publicKey>,
): RegistryRunner => {
  const registryLayer = Registry.layer({
    origin,
    registrySignerPublicKey,
    requestTimeout: Duration.seconds(5),
  }).pipe(Layer.provide(NodeHttpClient.layer));
  return (effect) => effect.pipe(Effect.provide(registryLayer));
};

const makeCapturedRegistryRunner = (
  origin: URL,
  registrySignerPublicKey: ReturnType<typeof AgentSigningAuthority.publicKey>,
) =>
  Effect.gen(function* () {
    const capturedRequest = yield* Ref.make<
      Option.Option<HttpClientRequest.HttpClientRequest>
    >(Option.none());
    const nodeClient = yield* HttpClient.HttpClient;
    const client = nodeClient.pipe(
      HttpClient.tapRequest((request) =>
        Ref.update(capturedRequest, (current) =>
          Option.isNone(current) ? Option.some(request) : current,
        ),
      ),
    );
    const registryLayer = Registry.layer({
      origin,
      registrySignerPublicKey,
      requestTimeout: Duration.seconds(5),
    }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));
    const run: RegistryRunner = (effect) =>
      effect.pipe(Effect.provide(registryLayer));
    return { capturedRequest, run };
  });

const prepareAgent = (name: string) =>
  Effect.gen(function* () {
    const signingAuthority = yield* makeSigningAuthority();
    const request = {
      operationId: makeOperationId(),
      principalId: makePrincipalId(),
      agentName: Schema.decodeUnknownSync(AgentName)(name),
      publicKey: AgentSigningAuthority.publicKey(signingAuthority),
    } satisfies RegistryRegisterRequestValue;
    return { request, signingAuthority };
  });

/* eslint-disable agent-code-guard/promise-type, agent-code-guard/then-chain -- The HTTP Message Signatures adapter requires this Promise callback. */
const signBootstrapBytes = (
  signingAuthority: AgentSigningAuthorityValue,
  bytes: Buffer,
): Promise<Buffer> =>
  webcrypto.subtle
    .sign(
      "Ed25519",
      agentSigningPrivateKey(signingAuthority),
      Uint8Array.from(bytes),
    )
    .then((signature) => Buffer.from(signature));
/* eslint-enable agent-code-guard/promise-type, agent-code-guard/then-chain -- Restore Effect-first Promise rules. */

const signBootstrapMessage = (input: {
  readonly request: HttpClientRequest.HttpClientRequest;
  readonly signingAuthority: AgentSigningAuthorityValue;
  readonly created: Date;
  readonly expires: Date;
  readonly keyid: string;
  readonly nonce: string;
}) =>
  Effect.tryPromise({
    try: () =>
      httpbis.signMessage(
        {
          name: "moltzap",
          fields: [...REGISTRATION_SIGNATURE_FIELDS],
          params: [...SIGNATURE_PARAMETERS],
          paramValues: {
            created: input.created,
            expires: input.expires,
            keyid: input.keyid,
            nonce: input.nonce,
            alg: "ed25519",
            tag: "moltzap-registration-v1",
          },
          key: {
            id: input.keyid,
            alg: "ed25519",
            sign: (bytes) => signBootstrapBytes(input.signingAuthority, bytes),
          },
        },
        {
          method: input.request.method,
          url: input.request.url,
          headers: { ...input.request.headers },
        },
      ),
    catch: (cause) =>
      processTestError("could not sign bootstrap request", cause),
  });

const makeVersionedBootstrapRequest = (
  origin: URL,
  prepared: Pick<RegisteredAgent, "request" | "signingAuthority">,
  version: string,
) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encode(RegistryRegisterRequest)(
      prepared.request,
    );
    const bodyBytes = yield* encodeCanonicalJson({ request: encoded });
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const keyid = yield* ed25519PublicKeyThumbprintUri(
      prepared.request.publicKey,
    );
    const request = HttpClientRequest.post(
      new URL("/v1/identities:register", origin),
    ).pipe(
      HttpClientRequest.bodyUint8Array(bodyBytes, "application/json"),
      HttpClientRequest.setHeader(
        "authorization",
        `MoltZap-Admission ${ADMISSION_CREDENTIAL}`,
      ),
      HttpClientRequest.setHeader("content-digest", contentDigest(bodyBytes)),
      HttpClientRequest.setHeader("moltzap-version", version),
    );
    const signed = yield* signBootstrapMessage({
      request,
      signingAuthority: prepared.signingAuthority,
      created: new Date(now * 1_000),
      expires: new Date((now + 300) * 1_000),
      keyid,
      nonce: randomIdentifierPayload(),
    });
    return request.pipe(
      HttpClientRequest.setHeader(
        "signature-input",
        String(signed.headers["Signature-Input"]),
      ),
      HttpClientRequest.setHeader(
        "signature",
        String(signed.headers.Signature),
      ),
    );
  });

const callRegister = (
  runRegistry: RegistryRunner,
  prepared: Pick<RegisteredAgent, "request" | "signingAuthority">,
  credential = ADMISSION_CREDENTIAL,
) =>
  runRegistry(
    Registry.register({
      ...prepared,
      admissionCredential: Redacted.make(credential),
    }),
  );

const registerAgent = (name: string, runRegistry: RegistryRunner) =>
  Effect.gen(function* () {
    const prepared = yield* prepareAgent(name);
    const result = yield* callRegister(runRegistry, prepared);
    if (result.kind !== "registered") {
      return yield* Effect.fail(
        processTestError(`registration returned ${result.kind}`),
      );
    }
    return { ...prepared, agentCard: result.agentCard };
  });

const registryEnvironment = (input: {
  readonly port: number;
  readonly postgresqlUrl: string;
  readonly registryKeyPath: string;
  readonly overrides?: Readonly<Record<string, string>>;
}) => ({
  MOLTZAP_REGISTRY_HOST: LOOPBACK_HOST,
  MOLTZAP_REGISTRY_PORT: String(input.port),
  MOLTZAP_REGISTRY_POSTGRESQL_URL: input.postgresqlUrl,
  MOLTZAP_REGISTRY_ADMISSION_CREDENTIAL: ADMISSION_CREDENTIAL,
  MOLTZAP_REGISTRY_SIGNING_PRIVATE_KEY_PATH: input.registryKeyPath,
  MOLTZAP_REGISTRY_LIST_PAGE_SIZE: "2",
  ...input.overrides,
});

const requireCapturedRequest = (
  captured: Option.Option<HttpClientRequest.HttpClientRequest>,
): Effect.Effect<HttpClientRequest.HttpClientRequest, ProcessTestError> =>
  Option.match(captured, {
    onNone: () =>
      Effect.fail(processTestError("registration request was not captured")),
    onSome: Effect.succeed,
  });

const startReadyRegistry = (
  environment: Readonly<Record<string, string>>,
  origin: URL,
) =>
  Effect.gen(function* () {
    const registry = yield* managedProcess(REGISTRY_BINARY, [], environment);
    yield* waitForHealthStatus({
      runningProcess: registry,
      origin,
      expectedStatus: READY_STATUS,
    });
    return registry;
  });

/** Shared process and Registry fixtures for executable acceptance tests. */
export {
  ADMISSION_CREDENTIAL,
  LOOPBACK_HOST,
  PGLITE_BINARY,
  REGISTRY_BINARY,
  callRegister,
  canConnect,
  makeCapturedRegistryRunner,
  makeOperationId,
  makePrincipalId,
  makePrivateKeyPem,
  makeRegistryRunner,
  makeSigningAuthority,
  makeVersionedBootstrapRequest,
  managedProcess,
  prepareAgent,
  processTestError,
  rawSocketRequest,
  registerAgent,
  registryEnvironment,
  requireCapturedRequest,
  reservePort,
  sendRawRequest,
  startReadyRegistry,
  stopProcess,
  waitForExit,
  waitForHealthStatus,
  waitForTcpListener,
};
/** Values passed between process-level acceptance helpers. */
export type {
  RawHttpResponse,
  RegisteredAgent,
  RegistryRunner,
  RunningProcess,
};
