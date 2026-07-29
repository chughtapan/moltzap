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
export const ImageDigest: Schema.Schema<ImageDigest, string> =
  Schema.String.pipe(
    Schema.pattern(/^sha256:[0-9a-f]{64}$/u),
    Schema.brand("ImageDigest"),
  );

/** Validate an image digest at a configuration boundary. */
export const imageDigest = Schema.decodeSync(ImageDigest);

/** Port exposed by the MoltZap server image. */
export const SERVER_CONTAINER_PORT = 3000;
/** Bind mount containing the server's durable state. */
export const SERVER_DATA_MOUNT = "/data";
export const SERVER_REGISTRATION_SECRET_ENV = "MOLTZAP_REGISTRATION_SECRET";

export const SERVER_COMMAND_TIMEOUT = Duration.minutes(2);

const LOOPBACK_HOST = "127.0.0.1";
const SERVER_CONTAINER_LABEL = "moltzap-simulator-run=1";
const SERVER_CONTAINER_ID_LABEL = "moltzap-simulator-run-id";
const IMAGE_BUILD_TIMEOUT = Duration.minutes(15);
const SERVER_IMAGE_ENV = "MOLTZAP_SIM_SERVER_IMAGE";
const IMAGE_BUILD_SCRIPT = fileURLToPath(
  new URL("../../scripts/build-server-image.mjs", import.meta.url),
);
const ImagePinLine = Schema.parseJson(
  Schema.Struct({ imageDigest: ImageDigest }),
);

function failureOutput(result: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

function collectStderr(process: Process, report: boolean) {
  return report
    ? Stream.decodeText(process.stderr).pipe(
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
      )
    : Stream.mkString(Stream.decodeText(process.stderr));
}

function collectCommand(
  executable: string,
  command: Command.Command,
  reportStderr: boolean,
) {
  return Effect.scoped(
    Command.start(command).pipe(
      Effect.flatMap((process) =>
        Effect.all(
          {
            stdout: Stream.mkString(Stream.decodeText(process.stdout)),
            stderr: collectStderr(process, reportStderr),
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

/** Execute one bounded host command while draining both output streams. */
export function runServerCommand(
  parts: ReadonlyArray<string>,
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
    options.reportStderr === true,
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
      Schema.decodeUnknown(ImagePinLine)(
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

/** Resolve an explicit or configured content-addressed server image. */
export function resolveServerImage(
  image: ImageDigest | undefined,
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
        : Schema.decodeUnknown(ImageDigest)(pinned).pipe(
            Effect.mapError(
              () =>
                `${SERVER_IMAGE_ENV}="${pinned}" is not an image digest (sha256:…)`,
            ),
          ),
    ),
  );
}

/** Docker arguments for one isolated MoltZap server. */
export function moltZapServerRunArgs(
  image: string,
  volumePath: string,
  containerName: string,
): ReadonlyArray<string> {
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
