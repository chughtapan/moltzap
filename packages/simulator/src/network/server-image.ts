/** @file Content-addressed MoltZap server image and container command contract. */

import { Command } from "@effect/platform";
import type {
  CommandExecutor,
  Process,
} from "@effect/platform/CommandExecutor";
import {
  Chunk,
  Config,
  Duration,
  Effect,
  Schema,
  Stream,
  type Brand,
} from "effect";
import { fileURLToPath } from "node:url";

/** Content-addressed identity of a MoltZap server image. */
export type ImageDigest = string & Brand.Brand<"ImageDigest">;
/** Validates and decodes image digest values. */
const imageDigestSchema: Schema.Schema<ImageDigest, string> =
  Schema.String.pipe(
    Schema.pattern(/^sha256:[0-9a-f]{64}$/u),
    Schema.brand("ImageDigest"),
  );

/** Validate an image digest at a configuration boundary. */
export const imageDigest = Schema.decodeSync(imageDigestSchema);

/** Port exposed by the MoltZap server image. */
export const SERVER_CONTAINER_PORT = 3000;
/** Bind mount containing the server's durable state. */
export const SERVER_DATA_MOUNT = "/data";
/** Provides the server registration secret env runtime value. */
export const SERVER_REGISTRATION_SECRET_ENV = "MOLTZAP_REGISTRATION_SECRET";

/** Provides the server command timeout runtime value. */
export const SERVER_COMMAND_TIMEOUT = Duration.minutes(2);

const LOOPBACK_HOST = "127.0.0.1";
const SERVER_CONTAINER_LABEL = "moltzap-simulator-run=1";
const SERVER_CONTAINER_ID_LABEL = "moltzap-simulator-run-id";
const IMAGE_BUILD_TIMEOUT = Duration.minutes(15);
const SERVER_IMAGE_ENV = "MOLTZAP_SIM_SERVER_IMAGE";
const IMAGE_BUILD_SCRIPT = fileURLToPath(
  new URL("../../scripts/build-server-image.mjs", import.meta.url),
);
const imagePinLine = Schema.parseJson(
  Schema.Struct({ imageDigest: imageDigestSchema }),
);

function failureOutput(result: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

function collectReportedStderr(process: Process) {
  return Stream.decodeText(process.stderr).pipe(
    Stream.splitLines,
    Stream.tap((line) =>
      line.trim().length === 0
        ? Effect.void
        : Effect.logInfo(line).pipe(
            Effect.annotateLogs({
              component: "moltzap-router",
              operation: "build-image",
            }),
          ),
    ),
    Stream.runCollect,
    Effect.map((lines) => Chunk.join(lines, "\n")),
  );
}

function collectQuietStderr(process: Process) {
  return Stream.mkString(Stream.decodeText(process.stderr));
}

function collectCommand<E>(
  executable: string,
  command: Command.Command,
  stderrCollector: (process: Process) => Effect.Effect<string, E>,
) {
  return Effect.scoped(
    Command.start(command).pipe(
      Effect.flatMap((process) =>
        Effect.all(
          {
            stdout: Stream.mkString(Stream.decodeText(process.stdout)),
            stderr: stderrCollector(process),
            exitCode: process.exitCode,
          },
          { concurrency: 3 },
        ),
      ),
      Effect.flatMap((result) =>
        Number(result.exitCode) === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              `${executable} exited ${String(result.exitCode)}: ${failureOutput(result)}`,
            ),
      ),
    ),
  );
}

/**
 * Execute one bounded host command while draining both output streams.
 * @param parts Value supplied to the operation.
 * @param options Options that control the operation.
 * @param options.timeout Value supplied to the operation.
 * @param options.environment Value supplied to the operation.
 * @param options.reportStderr Value supplied to the operation.
 * @returns The run server command result.
 */
export function runServerCommand(
  parts: readonly string[],
  options: {
    readonly timeout?: Duration.Duration;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly reportStderr?: boolean;
  } = {},
): Effect.Effect<string, string, CommandExecutor> {
  const [executable, ...args] = parts;
  if (executable === undefined) {
    return Effect.fail("empty command");
  }
  const command = Command.make(executable, ...args).pipe(
    Command.env(options.environment ?? {}),
    Command.stdout("pipe"),
    Command.stderr("pipe"),
  );
  return collectCommand(
    executable,
    command,
    options.reportStderr === true ? collectReportedStderr : collectQuietStderr,
  ).pipe(
    Effect.timeoutFail({
      duration: options.timeout ?? SERVER_COMMAND_TIMEOUT,
      onTimeout: () =>
        `${executable} did not finish within ${Duration.format(options.timeout ?? SERVER_COMMAND_TIMEOUT)}`,
    }),
    Effect.mapError(String),
  );
}

function buildServerImagePin(): Effect.Effect<
  ImageDigest,
  string,
  CommandExecutor
> {
  return runServerCommand(["node", IMAGE_BUILD_SCRIPT], {
    timeout: IMAGE_BUILD_TIMEOUT,
    reportStderr: true,
  }).pipe(
    Effect.mapError(
      (detail) =>
        `the server image could not be built: ${detail}. Pin a local image id through ${SERVER_IMAGE_ENV} to bypass the package image build`,
    ),
    Effect.flatMap((printed) =>
      Schema.decodeUnknown(imagePinLine)(
        printed.trim().split("\n").at(-1) ?? "",
      ).pipe(
        Effect.mapError(
          (cause) =>
            `the server image build printed no usable pin: ${cause.message}`,
        ),
      ),
    ),
    Effect.map((pin) => pin.imageDigest),
  );
}

/**
 * Resolve an explicit or configured content-addressed server image.
 * @param image Value supplied to the operation.
 * @returns The resolve server image result.
 */
export function resolveServerImage(
  image?: ImageDigest,
): Effect.Effect<ImageDigest, string, CommandExecutor> {
  if (image !== undefined) {
    return Effect.succeed(image);
  }
  return Config.string(SERVER_IMAGE_ENV).pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((pinned) =>
      pinned.length === 0
        ? buildServerImagePin()
        : Schema.decodeUnknown(imageDigestSchema)(pinned).pipe(
            Effect.mapError(
              () =>
                `${SERVER_IMAGE_ENV}="${pinned}" is not an image digest (sha256:…)`,
            ),
          ),
    ),
  );
}

/**
 * Docker arguments for one isolated MoltZap server.
 * @param image Value supplied to the operation.
 * @param volumePath Value supplied to the operation.
 * @param containerName Value supplied to the operation.
 * @returns The molt zap server run args result.
 */
export function moltZapServerRunArgs(
  image: string,
  volumePath: string,
  containerName: string,
): readonly string[] {
  return [
    "docker",
    "run",
    "--detach",
    "--rm",
    "--label",
    SERVER_CONTAINER_LABEL,
    "--label",
    `${SERVER_CONTAINER_ID_LABEL}=${containerName}`,
    "--name",
    containerName,
    "--publish",
    `${LOOPBACK_HOST}:0:${String(SERVER_CONTAINER_PORT)}`,
    "--volume",
    `${volumePath}:${SERVER_DATA_MOUNT}`,
    "--env",
    SERVER_REGISTRATION_SECRET_ENV,
    image,
  ];
}
