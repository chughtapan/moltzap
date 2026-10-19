/** @file The packed installer talks to a synthetic loopback HTTPS service with a child-only CA, retaining real private files between fresh processes. */

import type { IncomingMessage, ServerResponse } from "node:http"; // eslint-disable-line agent-code-guard/prefer-effect-platform -- The synthetic TLS fixture inspects the accepted Node request before deliberate socket-loss injection; production installer networking uses HttpClient.
import { FileSystem } from "@effect/platform";
import { Effect, Either, Schema } from "effect";
import { execFile, type ExecFileException } from "node:child_process";
import { createHash } from "node:crypto";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- A real child-only TLS listener and deliberate accepted-socket loss qualify packaged transport without providers or disabled certificate verification.
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import {
  certificate,
  privateKey,
} from "./native-installer-tls.test-support.ts";
import { PackGateError, requireCondition } from "./packed-workspace.ts";

const providerKey = "synthetic-packed-provider-key-000001";
const grant = Buffer.alloc(32, 21).toString("base64url");
const registration = Schema.Struct({
  target: Schema.Struct({ hosting: Schema.String, platform: Schema.String }),
  name: Schema.String,
  expiresAt: Schema.Number,
  claimToken: Schema.String,
});
const setup = Schema.Struct({
  platform: Schema.Literal("grokbot"),
  routineUrl: Schema.String,
  credential: Schema.String,
});

interface ProcessResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ServerState {
  origin: string;
  resource: string;
  readonly registrations: string[];
  readonly tokens: string[];
  readonly paths: string[];
}

interface Fixture {
  readonly root: string;
  readonly directory: string;
  readonly fs: FileSystem.FileSystem;
  readonly server: ServerState;
  readonly command: (args: readonly string[]) => Effect.Effect<ProcessResult>;
}

/** This proves installed command/transport/custody behavior, not owner login or native provider support. */
export const verifyInstalledInstaller = Effect.fn(
  "nativeInstaller.verifyInstalled",
)(function* (consumerRoot: string) {
  const fixture = yield* installerFixture(consumerRoot);
  const output = [
    ...(yield* verifyRegistration(fixture)),
    ...(yield* verifyCollection(fixture)),
    ...(yield* verifyPrivateLinkAndRefusals(fixture)),
  ]
    .map((value) => value.stdout + value.stderr)
    .join("\n");
  yield* requireCondition(
    [providerKey, grant, ...fixture.server.tokens].every(
      (secret) => !output.includes(secret),
    ),
    "installed diagnostics disclosed synthetic private authority",
  );
}, Effect.scoped);

function installerFixture(consumerRoot: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratch = yield* fs.makeTempDirectoryScoped({
      prefix: "native-installer-pack-",
    });
    const root = yield* fs.realPath(scratch);
    yield* fs.chmod(root, 0o700);
    const ca = join(root, "fixture-ca.pem");
    yield* fs.writeFileString(ca, certificate, { mode: 0o600 });
    const server = yield* fixtureServer();
    return {
      root,
      directory: join(root, "grokbot"),
      fs,
      server,
      command: (args: readonly string[]) =>
        installedCommand(consumerRoot, ca, args),
    } satisfies Fixture;
  });
}

function verifyRegistration({ command, directory, server }: Fixture) {
  return Effect.gen(function* () {
    const first = yield* command([
      "begin",
      directory,
      server.origin,
      server.resource,
      "grokbot",
      "pack-demo",
    ]);
    yield* requireCondition(
      first.status === 1,
      "lost registration response must fail without replacing custody",
    );
    const resumed = yield* command(["resume", directory]);
    yield* checkedCommand(resumed, "registered");
    yield* requireCondition(
      server.registrations.length === 2 &&
        server.registrations[0] === server.registrations[1],
      "installed resume must replay the exact committed request",
    );
    return [first, resumed];
  });
}

function verifyCollection({ command, directory, root, fs, server }: Fixture) {
  return Effect.gen(function* () {
    const keyFile = join(root, "routine-key");
    yield* fs.writeFileString(keyFile, providerKey, { mode: 0o600 });
    const prepared = yield* command([
      "setup",
      directory,
      "grokbot",
      "https://provider.example/routine",
      keyFile,
    ]);
    yield* checkedCommand(prepared, "ready");
    const redirected = yield* command(["collect", directory]);
    yield* requireCondition(
      redirected.status === 1 &&
        redirected.stderr.includes("response") &&
        !server.paths.includes("/must-not-follow") &&
        !(yield* fs.exists(join(directory, "runtime-credential"))),
      "installed transport must refuse a redirect without following Location or saving authority",
    );
    const collected = yield* command(["collect", directory]);
    yield* checkedCommand(collected, "credential-saved");
    const path = join(directory, "runtime-credential");
    yield* requireCondition(
      (yield* fs.readFileString(path)) === grant &&
        ((yield* fs.stat(path)).mode & 0o777) === 0o600,
      "installed collection must commit the exact private runtime grant",
    );
    return [prepared, redirected, collected];
  });
}

function verifyPrivateLinkAndRefusals({
  command,
  directory,
  root,
  fs,
  server,
}: Fixture) {
  return Effect.gen(function* () {
    const link = join(root, "owner-link");
    const exported = yield* command(["claim-link", directory, link]);
    yield* checkedCommand(exported, "claim-link-saved");
    yield* requireCondition(
      (yield* fs.readFileString(link)).includes(
        server.tokens[0] ?? "missing-token",
      ) && ((yield* fs.stat(link)).mode & 0o777) === 0o600,
      "explicit claim delivery must use private file custody",
    );
    const dot = join(root, "dot");
    const registered = yield* command([
      "begin",
      dot,
      server.origin,
      server.resource,
      "dot",
      "dot-demo",
    ]);
    yield* checkedCommand(registered, "registered");
    const dotRefused = yield* command(["collect", dot]);
    yield* requireCondition(
      dotRefused.status === 1 &&
        dotRefused.stderr.includes("oauth-required") &&
        !(yield* fs.exists(join(dot, "runtime-credential"))),
      "installed Dot command must refuse ordinary credential collection",
    );
    const refused = yield* command(["unknown", providerKey]);
    yield* requireCondition(
      refused.status === 64 && refused.stdout === "",
      "installed command must refuse unknown arguments",
    );
    return [exported, registered, dotRefused, refused];
  });
}

function checkedCommand(result: ProcessResult, state: string) {
  return Effect.gen(function* () {
    yield* requireCondition(
      result.status === 0 && result.stderr === "",
      `installed ${state} command failed`,
    );
    const value = yield* Schema.decodeUnknown(
      Schema.parseJson(Schema.Struct({ state: Schema.String })),
    )(result.stdout);
    yield* requireCondition(
      value.state === state,
      `installed command did not report ${state}`,
    );
  });
}

/** The child inherits no caller credentials or Node options; timeout and output bounds apply independently of its own HTTP budget. */
function installedCommand(cwd: string, ca: string, args: readonly string[]) {
  return Effect.async<ProcessResult>((resume) => {
    const child = execFile(
      process.execPath,
      [
        join(cwd, "node_modules/@moltzap/native-plugins/bin/install.mjs"),
        ...args,
      ],
      {
        cwd,
        env: { NODE_EXTRA_CA_CERTS: ca },
        encoding: "utf8",
        timeout: 35_000,
        maxBuffer: 32 * 1024,
      },
      (error, stdout, stderr) => {
        resume(
          Effect.succeed({ status: processStatus(error), stdout, stderr }),
        );
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });
}

function processStatus(error: ExecFileException | null) {
  if (error === null) {
    return 0;
  }
  return typeof error.code === "number" ? error.code : null;
}

function fixtureServer() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const state: ServerState = {
        origin: "",
        resource: "",
        registrations: [],
        tokens: [],
        paths: [],
      };
      const server = createServer(
        { key: privateKey, cert: certificate },
        (request, response) => {
          fixtureRequest(state, request, response);
        },
      );
      yield* listen(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        return yield* Effect.fail(
          new PackGateError({ message: "synthetic HTTPS port is unavailable" }),
        );
      }
      state.origin = `https://127.0.0.1:${address.port}/`;
      state.resource = `${state.origin}mcp`;
      return { ...state, server };
    }).pipe(
      Effect.timeoutFail({
        duration: "5 seconds",
        onTimeout: () =>
          new PackGateError({ message: "synthetic HTTPS startup timed out" }),
      }),
    ),
    ({ server }) =>
      Effect.async<undefined>((resume) => {
        server.closeAllConnections();
        server.close(() => {
          resume(Effect.succeed(undefined));
        });
      }),
  );
}

function listen(server: Server) {
  return Effect.async<undefined, PackGateError>((resume) => {
    server.once("error", () => {
      resume(
        Effect.fail(
          new PackGateError({
            message: "synthetic installer HTTPS fixture failed",
          }),
        ),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed(undefined));
    });
    return Effect.sync(() => {
      server.closeAllConnections();
      server.close();
    });
  });
}

/** Request bytes are synthetic and bounded; this fixture deliberately implements only the three public enrollment routes. */
function fixtureRequest(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
) {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
    if (Buffer.byteLength(body) > 16 * 1024) {
      request.destroy();
    }
  });
  request.on("end", () => {
    routeFixtureRequest(state, request, response, body);
  });
}

function routeFixtureRequest(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) {
  state.paths.push(request.url ?? "");
  if (request.method !== "POST") {
    finish(response, 405, {});
    return;
  }
  if (request.url === "/enrollment/registrations") {
    fixtureRegistration(state, request, response, body);
    return;
  }
  if (
    !state.tokens.some(
      (token) => request.headers.authorization === `Bearer ${token}`,
    )
  ) {
    finish(response, 404, { state: "unavailable" });
    return;
  }
  if (request.url === "/enrollment/native-setup") {
    fixtureSetup(response, body);
    return;
  }
  if (request.url === "/enrollment/bootstrap" && body === "") {
    fixtureBootstrap(state, response);
    return;
  }
  finish(response, 404, { state: "unavailable" });
}

function fixtureRegistration(
  state: ServerState,
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) {
  Schema.decodeUnknownEither(Schema.parseJson(registration))(body).pipe(
    Either.match({
      onLeft: () => {
        finish(response, 400, {});
      },
      onRight: (value) => {
        state.registrations.push(body);
        state.tokens.push(value.claimToken);
        if (state.registrations.length === 1) {
          request.destroy();
          return;
        }
        const installationId = `inst_${createHash("sha256").update(value.claimToken).digest("hex").slice(0, 32)}`;
        finish(response, 200, {
          installationId,
          target: value.target,
          name: value.name,
          expiresAt: value.expiresAt,
          claimed: true,
          claimUrl: `${state.origin}enrollment/claim#${value.claimToken}`,
        });
      },
    }),
  );
}

function fixtureSetup(response: ServerResponse, body: string) {
  Schema.decodeUnknownEither(Schema.parseJson(setup))(body).pipe(
    Either.match({
      onLeft: () => {
        finish(response, 404, { state: "unavailable" });
      },
      onRight: (value) => {
        const credentialDigest = createHash("sha256")
          .update(value.credential)
          .digest("hex");
        const identity = createHash("sha256")
          .update(
            JSON.stringify([
              value.platform,
              value.routineUrl,
              credentialDigest,
            ]),
          )
          .digest("hex");
        finish(response, 200, {
          state: "ready",
          platform: value.platform,
          destination: value.routineUrl,
          identity,
        });
      },
    }),
  );
}

function fixtureBootstrap(state: ServerState, response: ServerResponse) {
  if (
    state.paths.filter((path) => path === "/enrollment/bootstrap").length === 1
  ) {
    response.writeHead(302, {
      location: `${state.origin}must-not-follow`,
      connection: "close",
    });
    response.end();
    return;
  }
  finish(response, 200, {
    state: "ready",
    resource: state.resource,
    credential: grant,
  });
}

function finish(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(JSON.stringify(body));
}
