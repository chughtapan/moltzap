/** @file Resumable remote-shell enrollment keeps authority in explicit private files and never starts a receiver or sends native messages. */

import { Clock, Effect, Match, Redacted, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  decodeInstall,
  decodeNativeSetup,
  encodeInstall,
  encodeNativeSetup,
  InstallFailure,
  InstallReceipt,
  RegistrationResponse,
  runtimeCredential,
} from "./model.js";
import {
  claimUrl,
  collectRuntimeCredential,
  prepareNativeSetup,
  registerInstallation,
} from "./protocol.js";
import {
  installedArtifact,
  prepareDirectory,
  publishPrivate,
  readPrivate,
  readReceipt,
} from "./receipt.js";

const command = Schema.Union(
  Schema.Tuple(
    Schema.Literal("begin"),
    Schema.String,
    Schema.String,
    Schema.String,
    Schema.Literal(
      "muse",
      "instinct",
      "grokbot",
      "openclaw",
      "openclaw-hosted",
      "dot",
    ),
    Schema.String,
  ),
  Schema.Tuple(Schema.Literal("resume", "collect"), Schema.String),
  Schema.Tuple(
    Schema.Literal("setup"),
    Schema.String,
    Schema.Literal("instinct"),
    Schema.String,
  ),
  Schema.Tuple(
    Schema.Literal("setup"),
    Schema.String,
    Schema.Literal("grokbot"),
    Schema.String,
    Schema.String,
  ),
  Schema.Tuple(Schema.Literal("claim-link"), Schema.String, Schema.String),
);
const registered = Schema.Struct({
  installationId: RegistrationResponse.fields.installationId,
});

/** One invocation makes at most one attempt per required phase; safe JSON output contains no claim link, provider key or daemon grant. */
export const runInstaller = Effect.fn("Installer.run")(function* (
  argv: readonly string[],
) {
  const args = yield* decodeInstall(command, argv, "usage");
  switch (args[0]) {
    case "begin":
      return yield* begin(args);
    case "resume":
      return yield* resume(args[1]);
    case "setup":
      return yield* setup(args);
    case "collect":
      return yield* collect(args[1]);
    case "claim-link":
      return yield* exportClaimLink(args[1], args[2]);
    default:
      return yield* Effect.fail(new InstallFailure({ reason: "usage" }));
  }
});

function begin(
  args: Extract<typeof command.Type, readonly ["begin", ...unknown[]]>,
) {
  return Effect.gen(function* () {
    const directory = args[1];
    yield* prepareDirectory(directory);
    const existing = yield* readPrivate(join(directory, "request.json"));
    const fields = {
      origin: args[2],
      resource: args[3],
      target: selectedTarget(args[4]),
      name: args[5],
    };
    if (existing === undefined) {
      const receipt = yield* decodeInstall(
        InstallReceipt,
        {
          format: 1,
          ...fields,
          expiresAt: (yield* Clock.currentTimeMillis) + 30 * 60 * 1000,
          claimToken: yield* Effect.sync(() => randomBytes(32).toString("hex")),
          artifact: yield* installedArtifact(),
        },
        "usage",
      );
      const bytes = yield* encodeInstall(
        Schema.parseJson(InstallReceipt),
        receipt,
      );
      yield* publishPrivate(join(directory, "request.json"), bytes).pipe(
        Effect.catchTag("InstallFailure", (error) =>
          error.reason === "conflict" ? Effect.void : Effect.fail(error),
        ),
      );
    }
    const receipt = yield* readReceipt(directory);
    if (
      receipt.origin !== fields.origin ||
      receipt.resource !== fields.resource ||
      receipt.name !== fields.name ||
      JSON.stringify(receipt.target) !== JSON.stringify(fields.target)
    ) {
      return yield* Effect.fail(new InstallFailure({ reason: "conflict" }));
    }
    return yield* resume(directory);
  });
}

function resume(directory: string) {
  return Effect.gen(function* () {
    const receipt = yield* readReceipt(directory);
    const registration = yield* registerInstallation(receipt);
    if (registration.state !== "registered") {
      return registration;
    }
    yield* publishPrivate(
      join(directory, "registration.json"),
      JSON.stringify({ installationId: registration.installationId }),
    );
    const nativeSetup = yield* resumeSetup(directory, receipt);
    return {
      state: "registered",
      installationId: registration.installationId,
      claimed: registration.claimed,
      ownerUrl: new URL(
        `/enrollment/installation?id=${registration.installationId}`,
        receipt.origin,
      ).href,
      nativeSetup,
      artifact: receipt.artifact,
    };
  });
}

function resumeSetup(directory: string, receipt: InstallReceipt) {
  return Effect.gen(function* () {
    const saved = yield* readPrivate(join(directory, "setup.json"));
    if (saved === undefined) {
      return "not-submitted";
    }
    const input = yield* decodeInstall(
      Schema.parseJson(),
      Redacted.value(saved),
      "state",
    );
    const native = yield* decodeNativeSetup(input, "state");
    if (
      receipt.target.hosting !== "daemon" ||
      receipt.target.platform !== native.platform
    ) {
      return yield* Effect.fail(new InstallFailure({ reason: "state" }));
    }
    return (yield* prepareNativeSetup(receipt, native)).state;
  });
}

function setup(
  args: Extract<typeof command.Type, readonly ["setup", ...unknown[]]>,
) {
  return Effect.gen(function* () {
    const receipt = yield* readReceipt(args[1]);
    if (
      receipt.target.hosting !== "daemon" ||
      receipt.target.platform !== args[2]
    ) {
      return yield* Effect.fail(new InstallFailure({ reason: "conflict" }));
    }
    const input =
      args[2] === "instinct"
        ? { platform: args[2], recipient: args[3] }
        : {
            platform: args[2],
            routineUrl: args[3],
            credential: yield* readPrivate(args[4]).pipe(
              Effect.map((value) =>
                value === undefined ? undefined : Redacted.value(value),
              ),
            ),
          };
    const value = yield* decodeNativeSetup(input, "usage");
    const encoded = yield* encodeNativeSetup(value);
    yield* publishPrivate(join(args[1], "setup.json"), JSON.stringify(encoded));
    return yield* prepareNativeSetup(receipt, value);
  });
}

function collect(directory: string) {
  return Effect.gen(function* () {
    const receipt = yield* readReceipt(directory);
    if (receipt.target.platform === "openai-dot") {
      return yield* Effect.fail(
        new InstallFailure({ reason: "oauth-required" }),
      );
    }
    const registration = yield* readPrivate(
      join(directory, "registration.json"),
    );
    yield* decodeInstall(
      Schema.parseJson(registered),
      registration === undefined ? undefined : Redacted.value(registration),
      "state",
    );
    const path = join(directory, "runtime-credential");
    const saved = yield* readPrivate(path);
    if (saved !== undefined) {
      yield* decodeInstall(runtimeCredential, Redacted.value(saved), "state");
      return {
        state: "credential-saved",
        resource: receipt.resource,
        credentialFile: path,
      };
    }
    const response = yield* collectRuntimeCredential(receipt);
    if (response.state !== "ready") {
      return response;
    }
    yield* publishPrivate(path, Redacted.value(response.credential));
    return {
      state: "credential-saved",
      resource: receipt.resource,
      credentialFile: path,
    };
  });
}

function exportClaimLink(directory: string, destination: string) {
  return Effect.gen(function* () {
    const receipt = yield* readReceipt(directory);
    if ((yield* readPrivate(destination)) !== undefined) {
      return yield* Effect.fail(new InstallFailure({ reason: "conflict" }));
    }
    yield* publishPrivate(destination, claimUrl(receipt));
    return { state: "claim-link-saved", claimLinkFile: destination };
  });
}

function selectedTarget(
  value:
    | "muse"
    | "instinct"
    | "grokbot"
    | "openclaw"
    | "openclaw-hosted"
    | "dot",
) {
  return Match.value(value).pipe(
    Match.when(
      "openclaw-hosted",
      () => ({ hosting: "agent", platform: "openclaw" }) as const,
    ),
    Match.when(
      "dot",
      () => ({ hosting: "daemon", platform: "openai-dot" }) as const,
    ),
    Match.orElse((platform) => ({ hosting: "daemon", platform }) as const),
  );
}
