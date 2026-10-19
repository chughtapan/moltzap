/** @file Public installer commands preserve enrollment custody across uncertain HTTP outcomes without sending native work. */

import {
  FileSystem,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { SystemError } from "@effect/platform/Error";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Match,
  Schema,
  type Scope,
  TestClock,
  TestContext,
  Tracer,
} from "effect";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runInstaller } from "./command.js";

const origin = "https://enrollment.example/";
const resource = "https://mcp.example/mcp";
const grant = Buffer.alloc(32, 7).toString("base64url");
const providerKey = "synthetic-provider-credential-000001";
const installationId = `inst_${"1".repeat(32)}`;
const registration = Schema.Struct({
  target: Schema.Struct({ hosting: Schema.String, platform: Schema.String }),
  name: Schema.String,
  expiresAt: Schema.Number,
  claimToken: Schema.String,
});
type Reply = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError
>;
interface Fixture {
  readonly directory: string;
  readonly fs: FileSystem.FileSystem;
  readonly requests: HttpClientRequest.HttpClientRequest[];
  reply: Reply;
}

/* eslint-disable agent-code-guard/no-hardcoded-assertion-literals -- Private file modes and empty bootstrap bodies are public custody and HTTP acceptance contracts. */

describe("installer registration custody", () => {
  it(
    "commits private request custody before HTTP and replays the same request after a lost response",
    retainsUncertainRegistration,
  );
  it(
    "adopts a concurrent identical begin without replacing either committed token or installation",
    concurrentBegin,
  );
  it(
    "recovers a committed registration after saving its response fails",
    failedResponseSave,
  );
  it.each(["origin", "resource", "target", "name"] as const)(
    "refuses a changed %s before contacting the service",
    rejectsChangedRequest,
  );
  it(
    "replays the original expired registration instead of generating a fresh identity",
    retainsExpiry,
  );
  it(
    "keeps the claim link private until an explicit no-overwrite file export",
    privateClaimLink,
  );
  it.each(["target", "name", "expiry", "claim-url"] as const)(
    "refuses changed registration response %s",
    refusesRegistration,
  );
  it.each([404, 409, 503])(
    "handles registration HTML refusal %s without decoding or exposing its body",
    registrationHtmlRefusal,
  );
});

describe("installer native setup custody", () => {
  it(
    "persists exact Grok setup before POST and resumes without rereading the original key file",
    retainsSetup,
  );
  it(
    "refuses changed provider metadata or key without replacing saved setup",
    refusesSetupChange,
  );
  it.each([
    "not-an-email",
    "one@localhost",
    "one@bad..example",
    "one two@example.com",
  ])(
    "refuses invalid Instinct metadata before saving or posting setup: %s",
    refusesInvalidRecipient,
  );
  it(
    "sends Instinct metadata without requiring a per-installation sender key",
    preparesInstinct,
  );
  it(
    "refuses an explicit Grok routine port before saving or posting setup",
    refusesRoutinePort,
  );
  it(
    "refuses mismatched native setup receipts without changing the retained key",
    refusesSetupReceipt,
  );
});

describe("installer credential collection", () => {
  it(
    "saves a canonical bounded grant before exposing its file path and never re-fetches held custody",
    collectsGrant,
  );
  it(
    "retains a saved request when grant publication fails and recovers the same grant on retry",
    failedGrantSave,
  );
  it.each([202, 404, 503])(
    "reports %s without collecting or minting a credential",
    reportsProgress,
  );
  it.each([
    "redirect",
    "resource",
    "credential",
    "extra",
    "oversized",
  ] as const)(
    "refuses an invalid %s bootstrap response without saving authority",
    refusesBootstrap,
  );
});

describe("installer local and failure boundaries", () => {
  it(
    "uses the explicit managed OpenClaw target while ordinary OpenClaw remains daemon-hosted",
    selectsManagedOpenClaw,
  );
  it(
    "refuses Dot collection without contacting bootstrap or creating a grant file",
    refusesDot,
  );
  it(
    "refuses symlinked, permissive or changed-artifact state before networking",
    refusesState,
  );
  it(
    "bounds an uncertain request to one attempt and retains its original request",
    boundsAttempt,
  );
  it(
    "keeps private bearer, provider response and malformed grant out of actual Effect spans",
    safeTelemetry,
  );
});

function retainsUncertainRegistration() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      setReply(fixture, uncertainRegistration(fixture));
      const failed = yield* Effect.exit(begin(fixture));
      expect(JSON.stringify(failed)).not.toContain(providerKey);
      setReply(fixture, registeredReply);
      const result = yield* runInstaller(["resume", fixture.directory]);
      expect(result).toMatchObject({ state: "registered", installationId });
      expect(fixture.requests.map(requestRegistration)).toEqual([
        requestRegistration(fixture.requests[0]),
        requestRegistration(fixture.requests[0]),
      ]);
      expect(JSON.stringify(result)).not.toContain(
        requestRegistration(fixture.requests[0]).claimToken,
      );
    }),
  );
}

function uncertainRegistration(fixture: Fixture): Reply {
  return (request) =>
    Effect.gen(function* () {
      const path = join(fixture.directory, "request.json");
      const retained = yield* fixture.fs.readFileString(path);
      const saved = Schema.decodeUnknownSync(
        Schema.parseJson(Schema.Struct({ claimToken: Schema.String })),
      )(retained);
      expect(saved.claimToken).toBe(requestRegistration(request).claimToken);
      expect((yield* fixture.fs.stat(path)).mode & 0o777).toBe(0o600);
      return yield* Effect.fail(
        new HttpClientError.RequestError({
          request,
          reason: "Transport",
          cause: providerKey,
        }),
      );
    }).pipe(
      Effect.catchTags({ SystemError: Effect.die, BadArgument: Effect.die }),
    );
}

function failedResponseSave() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      const refusingFs: FileSystem.FileSystem = {
        ...fixture.fs,
        link: (source, destination) =>
          destination.endsWith("/registration.json")
            ? Effect.fail(
                new SystemError({
                  module: "FileSystem",
                  method: "link",
                  reason: "PermissionDenied",
                  pathOrDescriptor: destination,
                }),
              )
            : fixture.fs.link(source, destination),
      };
      expect(
        yield* Effect.either(
          begin(fixture).pipe(
            Effect.provideService(FileSystem.FileSystem, refusingFs),
          ),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "state" } });
      expect(yield* runInstaller(["resume", fixture.directory])).toMatchObject({
        state: "registered",
        installationId,
      });
      expect(fixture.requests.map(requestRegistration)).toEqual([
        requestRegistration(fixture.requests[0]),
        requestRegistration(fixture.requests[0]),
      ]);
    }),
  );
}

function concurrentBegin() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      const results = yield* Effect.all([begin(fixture), begin(fixture)], {
        concurrency: 2,
      });
      expect(results).toHaveLength(2);
      expect(fixture.requests.map(requestRegistration)).toEqual([
        requestRegistration(fixture.requests[0]),
        requestRegistration(fixture.requests[0]),
      ]);
    }),
  );
}

function rejectsChangedRequest(
  field: "origin" | "resource" | "target" | "name",
) {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture);
      const args = [
        "begin",
        fixture.directory,
        field === "origin" ? "https://other.example/" : origin,
        field === "resource" ? "https://other.example/mcp" : resource,
        field === "target" ? "openclaw" : "muse",
        field === "name" ? "other" : "demo",
      ];
      expect(yield* Effect.either(runInstaller(args))).toMatchObject({
        _tag: "Left",
        left: { reason: "conflict" },
      });
      expect(fixture.requests).toHaveLength(1);
    }),
  );
}

function retainsExpiry() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture);
      yield* TestClock.adjust("1 hour");
      yield* runInstaller(["resume", fixture.directory]);
      expect(fixture.requests.map(requestRegistration)).toEqual([
        requestRegistration(fixture.requests[0]),
        requestRegistration(fixture.requests[0]),
      ]);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
}

function privateClaimLink() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      const result = yield* begin(fixture);
      const destination = join(fixture.directory, "owner-link");
      const token = requestRegistration(fixture.requests[0]).claimToken;
      expect(JSON.stringify(result)).not.toContain(token);
      expect(
        yield* runInstaller(["claim-link", fixture.directory, destination]),
      ).toMatchObject({
        state: "claim-link-saved",
        claimLinkFile: destination,
      });
      expect(yield* fixture.fs.readFileString(destination)).toBe(
        `${origin}enrollment/claim#${token}`,
      );
      expect((yield* fixture.fs.stat(destination)).mode & 0o777).toBe(0o600);
      expect(
        yield* Effect.either(
          runInstaller(["claim-link", fixture.directory, destination]),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "conflict" } });
      expect(fixture.requests).toHaveLength(1);
    }),
  );
}

function retainsSetup() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture, "grokbot");
      const keyFile = join(fixture.directory, "supplied-key");
      yield* fixture.fs.writeFileString(keyFile, providerKey, { mode: 0o600 });
      setReply(fixture, uncertainSetup(fixture));
      yield* Effect.exit(
        runInstaller([
          "setup",
          fixture.directory,
          "grokbot",
          "https://grok.example/approved",
          keyFile,
        ]),
      );
      yield* fixture.fs.remove(keyFile);
      setReply(fixture, setupReply);
      const result = yield* runInstaller(["resume", fixture.directory]);
      expect(result).toMatchObject({ nativeSetup: "ready" });
      const setupRequests = fixture.requests.filter((request) =>
        request.url.endsWith("native-setup"),
      );
      expect(setupRequests.map(requestBody)).toEqual([
        requestBody(setupRequests[0]),
        requestBody(setupRequests[0]),
      ]);
      expect(JSON.stringify(result)).not.toContain(providerKey);
    }),
  );
}

function uncertainSetup(fixture: Fixture): Reply {
  return (request) =>
    request.url.endsWith("registrations")
      ? registeredReply(request)
      : Effect.gen(function* () {
          expect(
            yield* fixture.fs.readFileString(
              join(fixture.directory, "setup.json"),
            ),
          ).toContain(providerKey);
          return yield* Effect.fail(
            new HttpClientError.RequestError({ request, reason: "Transport" }),
          );
        }).pipe(
          Effect.catchTags({
            SystemError: Effect.die,
            BadArgument: Effect.die,
          }),
        );
}

function refusesInvalidRecipient(recipient: string) {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture, "instinct");
      expect(
        yield* Effect.either(
          runInstaller(["setup", fixture.directory, "instinct", recipient]),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "usage" } });
      expect(
        yield* fixture.fs.exists(join(fixture.directory, "setup.json")),
      ).toBe(false);
      expect(fixture.requests).toHaveLength(1);
    }),
  );
}

function refusesRoutinePort() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture, "grokbot");
      const keyFile = join(fixture.directory, "supplied-key");
      yield* fixture.fs.writeFileString(keyFile, providerKey, { mode: 0o600 });
      expect(
        yield* Effect.either(
          runInstaller([
            "setup",
            fixture.directory,
            "grokbot",
            "https://grok.example:8443/routine",
            keyFile,
          ]),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "usage" } });
      expect(
        yield* fixture.fs.exists(join(fixture.directory, "setup.json")),
      ).toBe(false);
      expect(fixture.requests).toHaveLength(1);
    }),
  );
}

function preparesInstinct() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture, "instinct");
      const recipient = "native@instinct.example";
      fixture.reply = (request) => {
        expect(requestBody(request)).toEqual({
          platform: "instinct",
          recipient,
        });
        const identity = createHash("sha256")
          .update(JSON.stringify(["instinct", recipient]))
          .digest("hex");
        return response(request, 200, {
          state: "ready",
          platform: "instinct",
          destination: recipient,
          identity,
        });
      };
      expect(
        yield* runInstaller([
          "setup",
          fixture.directory,
          "instinct",
          recipient,
        ]),
      ).toEqual({ state: "ready" });
    }),
  );
}

function refusesSetupChange() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture, "grokbot");
      const keyFile = join(fixture.directory, "supplied-key");
      yield* fixture.fs.writeFileString(keyFile, providerKey, { mode: 0o600 });
      setReply(fixture, setupReply);
      yield* runInstaller([
        "setup",
        fixture.directory,
        "grokbot",
        "https://grok.example/approved",
        keyFile,
      ]);
      expect(
        yield* Effect.either(
          runInstaller([
            "setup",
            fixture.directory,
            "grokbot",
            "https://grok.example/changed",
            keyFile,
          ]),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "conflict" } });
      yield* fixture.fs.writeFileString(keyFile, "different-private-key");
      expect(
        yield* Effect.either(
          runInstaller([
            "setup",
            fixture.directory,
            "grokbot",
            "https://grok.example/approved",
            keyFile,
          ]),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "conflict" } });
      expect(fixture.requests).toHaveLength(2);
    }),
  );
}

function collectsGrant() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture);
      fixture.reply = (request) =>
        response(request, 200, { state: "ready", resource, credential: grant });
      const result = yield* runInstaller(["collect", fixture.directory]);
      const path = join(fixture.directory, "runtime-credential");
      expect(result).toEqual({
        state: "credential-saved",
        resource,
        credentialFile: path,
      });
      expect(yield* fixture.fs.readFileString(path)).toBe(grant);
      expect((yield* fixture.fs.stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(result)).not.toContain(grant);
      expect(yield* runInstaller(["collect", fixture.directory])).toEqual(
        result,
      );
      expect(fixture.requests).toHaveLength(2);
      const request = fixture.requests[1];
      expect(request?.url).toBe(`${origin}enrollment/bootstrap`);
      expect(request?.body._tag).toBe("Empty");
      expect(request?.headers.authorization).toBe(
        `Bearer ${requestRegistration(fixture.requests[0]).claimToken}`,
      );
    }),
  );
}

function reportsProgress(status: number) {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture);
      const state = Match.value(status).pipe(
        Match.when(202, () => "pending"),
        Match.when(404, () => "unavailable"),
        Match.orElse(() => "retry"),
      );
      fixture.reply = (request) => response(request, status, { state });
      expect(yield* runInstaller(["collect", fixture.directory])).toEqual({
        state,
      });
      expect(
        yield* fixture.fs.exists(join(fixture.directory, "runtime-credential")),
      ).toBe(false);
      expect(fixture.requests).toHaveLength(2);
    }),
  );
}

function failedGrantSave() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture);
      fixture.reply = (request) =>
        response(request, 200, { state: "ready", resource, credential: grant });
      const refusingFs: FileSystem.FileSystem = {
        ...fixture.fs,
        link: (source, destination) =>
          destination.endsWith("/runtime-credential")
            ? Effect.fail(
                new SystemError({
                  module: "FileSystem",
                  method: "link",
                  reason: "PermissionDenied",
                  pathOrDescriptor: destination,
                }),
              )
            : fixture.fs.link(source, destination),
      };
      const result = yield* Effect.either(
        runInstaller(["collect", fixture.directory]).pipe(
          Effect.provideService(FileSystem.FileSystem, refusingFs),
        ),
      );
      expect(result).toMatchObject({ _tag: "Left", left: { reason: "state" } });
      expect(JSON.stringify(result)).not.toContain(grant);
      expect(
        yield* fixture.fs.exists(join(fixture.directory, "runtime-credential")),
      ).toBe(false);
      expect(yield* runInstaller(["collect", fixture.directory])).toMatchObject(
        { state: "credential-saved" },
      );
      expect(
        yield* fixture.fs.readFileString(
          join(fixture.directory, "runtime-credential"),
        ),
      ).toBe(grant);
      expect(fixture.requests).toHaveLength(3);
    }),
  );
}

function refusesSetupReceipt() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture, "grokbot");
      const keyFile = join(fixture.directory, "supplied-key");
      yield* fixture.fs.writeFileString(keyFile, providerKey, { mode: 0o600 });
      fixture.reply = (request) =>
        response(request, 200, {
          state: "ready",
          platform: "grokbot",
          destination: "https://other.example/routine",
          identity: "0".repeat(64),
        });
      expect(
        yield* Effect.either(
          runInstaller([
            "setup",
            fixture.directory,
            "grokbot",
            "https://grok.example/approved",
            keyFile,
          ]),
        ),
      ).toMatchObject({ _tag: "Left", left: { reason: "response" } });
      setReply(fixture, setupReply);
      expect(yield* runInstaller(["resume", fixture.directory])).toMatchObject({
        nativeSetup: "ready",
      });
    }),
  );
}

function refusesBootstrap(
  kind: "redirect" | "resource" | "credential" | "extra" | "oversized",
) {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture);
      fixture.reply = (request) =>
        response(request, kind === "redirect" ? 302 : 200, {
          state: "ready",
          resource:
            kind === "resource" ? "https://other.example/mcp" : resource,
          credential: kind === "credential" ? `${grant}\n` : grant,
          ...(kind === "extra" ? { private: providerKey } : {}),
          ...(kind === "oversized" ? { private: providerKey.repeat(300) } : {}),
        });
      const result = yield* Effect.either(
        runInstaller(["collect", fixture.directory]),
      );
      expect(result).toMatchObject({
        _tag: "Left",
        left: { reason: "response" },
      });
      expect(JSON.stringify(result)).not.toContain(providerKey);
      expect(JSON.stringify(result)).not.toContain(grant);
      expect(
        yield* fixture.fs.exists(join(fixture.directory, "runtime-credential")),
      ).toBe(false);
      expect(fixture.requests).toHaveLength(2);
    }),
  );
}

function refusesRegistration(
  field: "target" | "name" | "expiry" | "claim-url",
) {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      fixture.reply = (request) => {
        const input = requestRegistration(request);
        return response(request, 200, {
          installationId,
          target:
            field === "target"
              ? { hosting: "daemon", platform: "openclaw" }
              : input.target,
          name: field === "name" ? "changed" : input.name,
          expiresAt: input.expiresAt + (field === "expiry" ? 1 : 0),
          claimed: false,
          claimUrl:
            field === "claim-url"
              ? `https://other.example/#${input.claimToken}`
              : `${origin}enrollment/claim#${input.claimToken}`,
        });
      };
      expect(yield* Effect.either(begin(fixture))).toMatchObject({
        _tag: "Left",
        left: { reason: "response" },
      });
      expect(
        yield* fixture.fs.exists(join(fixture.directory, "registration.json")),
      ).toBe(false);
    }),
  );
}

function selectsManagedOpenClaw() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture, "openclaw-hosted");
      expect(requestRegistration(fixture.requests[0]).target).toEqual({
        hosting: "agent",
        platform: "openclaw",
      });
      yield* runInstaller([
        "begin",
        join(fixture.directory, "ordinary"),
        origin,
        resource,
        "openclaw",
        "ordinary",
      ]);
      expect(requestRegistration(fixture.requests[1]).target).toEqual({
        hosting: "daemon",
        platform: "openclaw",
      });
    }),
  );
}

function registrationHtmlRefusal(status: number) {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      fixture.reply = (request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(`<html>${providerKey}</html>`, {
              status,
              headers: { "content-type": "text/html" },
            }),
          ),
        );
      const result = yield* Effect.either(begin(fixture));
      expect(result).toMatchObject(
        status === 409
          ? { _tag: "Left", left: { reason: "conflict" } }
          : {
              _tag: "Right",
              right: { state: status === 404 ? "unavailable" : "retry" },
            },
      );
      expect(JSON.stringify(result)).not.toContain(providerKey);
      expect(
        yield* fixture.fs.exists(join(fixture.directory, "request.json")),
      ).toBe(true);
      expect(fixture.requests).toHaveLength(1);
    }),
  );
}

function refusesDot() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture, "dot");
      expect(
        yield* Effect.either(runInstaller(["collect", fixture.directory])),
      ).toMatchObject({ _tag: "Left", left: { reason: "oauth-required" } });
      expect(fixture.requests).toHaveLength(1);
      expect(
        yield* fixture.fs.exists(join(fixture.directory, "runtime-credential")),
      ).toBe(false);
    }),
  );
}

function refusesState() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture);
      const requestPath = join(fixture.directory, "request.json");
      const original = yield* fixture.fs.readFileString(requestPath);
      // eslint-disable-next-line sonarjs/file-permissions -- This isolated synthetic fixture deliberately violates custody to prove refusal.
      yield* fixture.fs.chmod(requestPath, 0o644);
      expect(
        yield* Effect.either(runInstaller(["resume", fixture.directory])),
      ).toMatchObject({ _tag: "Left" });
      yield* fixture.fs.chmod(requestPath, 0o600);
      yield* fixture.fs.rename(
        requestPath,
        join(fixture.directory, "original"),
      );
      yield* fixture.fs.symlink(
        join(fixture.directory, "original"),
        requestPath,
      );
      expect(
        yield* Effect.either(runInstaller(["resume", fixture.directory])),
      ).toMatchObject({ _tag: "Left" });
      yield* fixture.fs.remove(requestPath);
      yield* fixture.fs.writeFileString(
        requestPath,
        original.replace('"unqualified"', '"qualified"'),
        { mode: 0o600 },
      );
      expect(
        yield* Effect.either(runInstaller(["resume", fixture.directory])),
      ).toMatchObject({ _tag: "Left" });
      expect(fixture.requests).toHaveLength(1);
    }),
  );
}

function boundsAttempt() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      fixture.reply = () => Effect.never;
      const fiber = yield* Effect.forkScoped(Effect.either(begin(fixture)));
      yield* Effect.yieldNow().pipe(
        Effect.repeat({ until: () => fixture.requests.length === 1 }),
      );
      yield* TestClock.adjust("15 seconds");
      expect(yield* Fiber.join(fiber)).toMatchObject({
        _tag: "Left",
        left: { reason: "transport" },
      });
      expect(fixture.requests).toHaveLength(1);
      setReply(fixture, registeredReply);
      yield* runInstaller(["resume", fixture.directory]);
      expect(fixture.requests.map(requestRegistration)).toEqual([
        requestRegistration(fixture.requests[0]),
        requestRegistration(fixture.requests[0]),
      ]);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
}

function safeTelemetry() {
  return inFixture((fixture) =>
    Effect.gen(function* () {
      yield* begin(fixture);
      const spans: string[] = [];
      const parent = yield* Effect.tracer;
      const tracer = capturingTracer(parent, spans);
      fixture.reply = (request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                state: "ready",
                resource,
                credential: `${grant}${providerKey}`,
              }),
              {
                headers: {
                  "content-type": "application/json",
                  "x-private": providerKey,
                },
              },
            ),
          ),
        );
      const result = yield* Effect.either(
        runInstaller(["collect", fixture.directory]).pipe(
          Effect.withTracer(tracer),
        ),
      );
      expect(result).toMatchObject({
        _tag: "Left",
        left: { reason: "response" },
      });
      expect(spans.length).toBeGreaterThan(0);
      const output = spans.join("\n");
      for (const secret of [
        providerKey,
        grant,
        requestRegistration(fixture.requests[0]).claimToken,
      ]) {
        expect(output).not.toContain(secret);
      }
    }),
  );
}

function capturingTracer(parent: Tracer.Tracer, spans: string[]) {
  return Tracer.make({
    context: (use, fiber) => parent.context(use, fiber),
    span: (...args) => {
      const span = parent.span(...args);
      const end = span.end.bind(span);
      span.end = (time, exit) => {
        spans.push(
          JSON.stringify({
            name: span.name,
            attributes: [...span.attributes],
            error: Exit.isFailure(exit) ? Cause.pretty(exit.cause) : undefined,
          }),
        );
        end(time, exit);
      };
      return span;
    },
  });
}

function setReply(fixture: Fixture, reply: Reply) {
  fixture.reply = reply;
}

function begin(fixture: Fixture, target = "muse") {
  return runInstaller([
    "begin",
    fixture.directory,
    origin,
    resource,
    target,
    "demo",
  ]);
}

function inFixture<A, E>(
  use: (
    fixture: Fixture,
  ) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | HttpClient.HttpClient | Scope.Scope
  >,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temporary = yield* fs.makeTempDirectoryScoped({
        prefix: "native-install-",
      });
      const directory = yield* fs.realPath(temporary);
      yield* fs.chmod(directory, 0o700);
      const fixture: Fixture = {
        directory,
        fs,
        requests: [],
        reply: registeredReply,
      };
      const client = HttpClient.make((request) => {
        fixture.requests.push(request);
        return fixture.reply(request);
      });
      return yield* use(fixture).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
    }),
  ).pipe(Effect.provide(NodeFileSystem.layer), Effect.runPromise);
}

function setupReply(request: HttpClientRequest.HttpClientRequest) {
  if (request.url.endsWith("registrations")) {
    return registeredReply(request);
  }
  const input = Schema.decodeUnknownSync(
    Schema.Struct({
      platform: Schema.Literal("grokbot"),
      routineUrl: Schema.String,
      credential: Schema.String,
    }),
  )(requestBody(request));
  const credentialDigest = createHash("sha256")
    .update(input.credential)
    .digest("hex");
  const identity = createHash("sha256")
    .update(
      JSON.stringify([input.platform, input.routineUrl, credentialDigest]),
    )
    .digest("hex");
  return response(request, 200, {
    state: "ready",
    platform: input.platform,
    destination: input.routineUrl,
    identity,
  });
}

function registeredReply(request: HttpClientRequest.HttpClientRequest) {
  const input = requestRegistration(request);
  return response(request, 200, {
    installationId,
    target: input.target,
    name: input.name,
    expiresAt: input.expiresAt,
    claimed: false,
    claimUrl: `${origin}enrollment/claim#${input.claimToken}`,
  });
}

function requestRegistration(request?: HttpClientRequest.HttpClientRequest) {
  if (request === undefined) {
    throw new Error("Expected a fixture registration request");
  }
  return Schema.decodeUnknownSync(registration)(requestBody(request));
}

function requestBody(request?: HttpClientRequest.HttpClientRequest): unknown {
  if (request === undefined) {
    throw new Error("Expected a fixture request");
  }
  return Match.value(request.body).pipe(
    Match.tag("Uint8Array", ({ body }) =>
      Schema.decodeUnknownSync(Schema.parseJson())(
        new TextDecoder().decode(body),
      ),
    ),
    Match.orElse(() => {
      throw new Error("Expected a fixture JSON request");
    }),
  );
}

function response(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
) {
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

/* eslint-enable agent-code-guard/no-hardcoded-assertion-literals -- Acceptance-contract expectations above are complete. */
