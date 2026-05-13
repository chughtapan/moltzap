import { FileSystem } from "@effect/platform";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Data, Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

class CoreSchemaSqlAccessError extends Data.TaggedError(
  "CoreSchemaSqlAccessError",
)<{
  readonly message: string;
  readonly attemptedPaths: readonly [string, string];
  readonly cause?: unknown;
}> {}

class CoreSchemaSqlReadError extends Data.TaggedError(
  "CoreSchemaSqlReadError",
)<{
  readonly message: string;
  readonly path: string;
  readonly reason?: string;
  readonly cause?: unknown;
}> {}

export type CoreSchemaSqlLoadError =
  | CoreSchemaSqlAccessError
  | CoreSchemaSqlReadError;

const __dirname = dirname(fileURLToPath(import.meta.url));
let cachedSchemaSql: string | null = null;

function platformAccessError(attemptedPaths: readonly [string, string]): {
  readonly BadArgument: (
    cause: unknown,
  ) => Effect.Effect<never, CoreSchemaSqlAccessError>;
  readonly SystemError: (cause: {
    readonly reason?: string;
  }) => Effect.Effect<never, CoreSchemaSqlAccessError>;
} {
  return {
    BadArgument: (cause) =>
      Effect.fail(
        new CoreSchemaSqlAccessError({
          message: "core-schema.sql path probe used an invalid path",
          attemptedPaths,
          cause,
        }),
      ),
    SystemError: (cause) =>
      Effect.fail(
        new CoreSchemaSqlAccessError({
          message: `core-schema.sql path probe failed: ${cause.reason ?? "Unknown"}`,
          attemptedPaths,
          cause,
        }),
      ),
  };
}

function platformReadError(path: string): {
  readonly BadArgument: (
    cause: unknown,
  ) => Effect.Effect<never, CoreSchemaSqlReadError>;
  readonly SystemError: (cause: {
    readonly reason?: string;
  }) => Effect.Effect<never, CoreSchemaSqlReadError>;
} {
  return {
    BadArgument: (cause) =>
      Effect.fail(
        new CoreSchemaSqlReadError({
          message: "core-schema.sql read used an invalid path",
          path,
          cause,
        }),
      ),
    SystemError: (cause) =>
      Effect.fail(
        new CoreSchemaSqlReadError({
          message: `core-schema.sql read failed: ${cause.reason ?? "Unknown"}`,
          path,
          reason: cause.reason,
          cause,
        }),
      ),
  };
}

export function loadCoreSchemaSql(): Effect.Effect<
  string,
  CoreSchemaSqlLoadError
> {
  if (cachedSchemaSql !== null) return Effect.succeed(cachedSchemaSql);

  const srcPath = join(__dirname, "..", "app", "core-schema.sql");
  const distPath = join(__dirname, "..", "..", "src", "app", "core-schema.sql");
  const attemptedPaths = [srcPath, distPath] as const;

  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.exists(srcPath).pipe(
        Effect.catchTags(platformAccessError(attemptedPaths)),
        Effect.flatMap((srcExists) => {
          const schemaPath = srcExists ? srcPath : distPath;
          return fs
            .readFileString(schemaPath, "utf-8")
            .pipe(Effect.catchTags(platformReadError(schemaPath)));
        }),
      ),
    ),
    Effect.tap((schema) =>
      Effect.sync(() => {
        cachedSchemaSql = schema;
      }),
    ),
    Effect.provide(NodeFileSystem.layer),
    Effect.withSpan("loadCoreSchemaSql"),
  );
}
