/** @file Private no-overwrite phase files let uncertain HTTP outcomes resume without replacing enrollment authority. */

import type { PlatformError } from "@effect/platform/Error";
import { FileSystem } from "@effect/platform";
import { Effect, Option, Redacted, Schema } from "effect";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeInstall,
  InstallFailure,
  InstallReceipt,
  sha256,
} from "./model.js";

const MAX_RECEIPT_BYTES = 16 * 1024;
const manifest = Schema.Struct({
  name: Schema.Literal("@moltzap/native-plugins"),
  private: Schema.Literal(true),
  version: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^\d{4}\.\d{3,4}\.\d+$/u)),
  ),
  dependencies: Schema.Struct({ "@moltzap/client": Schema.String }),
});

/** The same installer bytes must resume custody; changing artifacts requires an explicit future migration, not implicit replacement. */
export const installedArtifact = Effect.fn("Installer.installedArtifact")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const bytes = yield* fs.readFileString(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
    );
    const metadata = yield* Schema.decodeUnknown(Schema.parseJson(manifest))(
      bytes,
    ).pipe(
      Effect.catchTag("ParseError", () =>
        Effect.fail(new InstallFailure({ reason: "artifact" })),
      ),
    );
    const version = metadata.version ?? null;
    const expectedClient = version ?? "workspace:*";
    if (metadata.dependencies["@moltzap/client"] !== expectedClient) {
      return yield* Effect.fail(new InstallFailure({ reason: "artifact" }));
    }
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const sources = yield* Effect.forEach(
      ["model", "receipt", "protocol", "command"],
      (name) =>
        fs
          .readFileString(
            fileURLToPath(new URL(`./${name}.${extension}`, import.meta.url)),
          )
          .pipe(Effect.map((source) => [name, source])),
      { concurrency: 1 },
    );
    return yield* decodeInstall(
      InstallReceipt.fields.artifact,
      {
        kind: version === null ? "source" : "private-archive",
        version,
        manifestSha256: sha256(bytes),
        installerSha256: sha256(JSON.stringify(sources)),
        qualification: "unqualified",
      },
      "artifact",
    );
  },
  scrubFileErrors,
);

/** Directory custody is explicit and POSIX-only; symlink aliases and permissive or foreign-owned paths are refused, never repaired. */
export const prepareDirectory = Effect.fn("Installer.prepareDirectory")(
  function* (directory: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* absolutePath(directory);
    yield* fs
      .makeDirectory(directory, { mode: 0o700 })
      .pipe(
        Effect.catchTag("SystemError", (error) =>
          error.reason === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
    yield* checkedPath(directory, "Directory");
  },
  scrubFileErrors,
);

/** Readers bound allocation and reject private-state files whose custody no longer matches the executing owner. */
export const readPrivate = Effect.fn("Installer.readPrivate")(function* (
  path: string,
) {
  yield* checkedPath(dirname(path), "Directory");
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(path);
  if (!exists) {
    return undefined;
  }
  yield* checkedPath(path, "File");
  return yield* readBytes(path).pipe(Effect.scoped);
}, scrubFileErrors);

/** A synced temporary file is linked exclusively into place; concurrent or resumed writers must observe identical committed bytes. */
export const publishPrivate = Effect.fn("Installer.publishPrivate")(function* (
  path: string,
  bytes: string,
) {
  yield* checkedPath(dirname(path), "Directory");
  if (new TextEncoder().encode(bytes).length > MAX_RECEIPT_BYTES) {
    return yield* Effect.fail(new InstallFailure({ reason: "state" }));
  }
  yield* linkBytes(path, bytes).pipe(Effect.scoped);
  const retained = yield* readPrivate(path);
  if (retained === undefined || Redacted.value(retained) !== bytes) {
    return yield* Effect.fail(new InstallFailure({ reason: "conflict" }));
  }
}, scrubFileErrors);

/** Receipt decoding checks both retained routing authority and the actual executing artifact before any network use. */
export const readReceipt = Effect.fn("Installer.readReceipt")(function* (
  directory: string,
) {
  const bytes = yield* readPrivate(join(directory, "request.json"));
  const receipt = yield* decodeInstall(
    Schema.parseJson(InstallReceipt),
    bytes === undefined ? undefined : Redacted.value(bytes),
    "state",
  );
  const artifact = yield* installedArtifact();
  if (JSON.stringify(receipt.artifact) !== JSON.stringify(artifact)) {
    return yield* Effect.fail(new InstallFailure({ reason: "artifact" }));
  }
  return receipt;
});

function readBytes(path: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.open(path, { flag: "r" });
    const bytes = yield* file.readAlloc(MAX_RECEIPT_BYTES + 1);
    if (Option.isNone(bytes)) {
      return Redacted.make("");
    }
    if (bytes.value.length > MAX_RECEIPT_BYTES) {
      return yield* Effect.fail(new InstallFailure({ reason: "state" }));
    }
    return yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.value,
        ),
      catch: () => new InstallFailure({ reason: "state" }),
    }).pipe(Effect.map(Redacted.make));
  });
}

function linkBytes(path: string, bytes: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staging = yield* fs.makeTempDirectoryScoped({
      directory: dirname(path),
      prefix: ".install-",
    });
    const source = join(staging, "value");
    const file = yield* fs.open(source, { flag: "wx", mode: 0o600 });
    yield* file.writeAll(new TextEncoder().encode(bytes));
    yield* file.sync;
    yield* fs
      .link(source, path)
      .pipe(
        Effect.catchTag("SystemError", (error) =>
          error.reason === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
    const parent = yield* fs.open(dirname(path), { flag: "r" });
    yield* parent.sync;
  });
}

function checkedPath(path: string, type: "Directory" | "File") {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* absolutePath(path);
    const info = yield* fs.stat(path);
    if (
      !privateCustody(info, type) ||
      (yield* fs.realPath(path)) !== path ||
      (type === "File" && info.size > BigInt(MAX_RECEIPT_BYTES))
    ) {
      return yield* Effect.fail(new InstallFailure({ reason: "state" }));
    }
  });
}

function privateCustody(
  info: FileSystem.File.Info,
  type: "Directory" | "File",
) {
  const owner = process.getuid?.();
  const mode = type === "Directory" ? 0o700 : 0o600;
  return (
    owner !== undefined &&
    Option.getOrUndefined(info.uid) === owner &&
    info.type === type &&
    (info.mode & 0o777) === mode
  );
}

function absolutePath(path: string) {
  return isAbsolute(path) && normalize(path) === path
    ? Effect.void
    : Effect.fail(new InstallFailure({ reason: "state" }));
}

function scrubFileErrors<A, R>(
  effect: Effect.Effect<A, InstallFailure | PlatformError, R>,
) {
  return effect.pipe(
    Effect.catchTags({
      SystemError: () => Effect.fail(new InstallFailure({ reason: "state" })),
      BadArgument: () => Effect.fail(new InstallFailure({ reason: "state" })),
    }),
  );
}
