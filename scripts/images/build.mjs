/**
 * @file Shared build-time helpers for the controller, OpenClaw, and NanoClaw
 * image builders: the option grammar, the tag shape, and the digest readers
 * they must agree on.
 *
 * A builder either loads its image into the local daemon (the default) or
 * pushes it to the repository's registry (`--push`). In both cases the digest
 * a profile pins is `containerimage.digest` from the buildx metadata file;
 * only a loaded image also has a local image id to report. Both paths assume
 * buildx's default `docker` driver, which shares the daemon's image store: a
 * pushed NanoClaw image is built FROM a base that was only loaded locally.
 */
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);

/** Docker tag grammar: up to 128 characters of `[A-Za-z0-9_.-]`. */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;

/** A sha256 manifest digest or local image id. */
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * Parse `[--repository NAME] [--tag TAG] [--push]`.
 * @param {readonly string[]} args Process arguments after the script path.
 * @param {{ script: string, label: string, defaultRepository: string }} builder
 * The script name for the usage line, the label for error messages, and the
 * repository used when none is given.
 * @returns {{ repository: string, tag: string | undefined, push: boolean }}
 */
export function parseImageBuildArguments(args, builder) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      strict: true,
      allowPositionals: false,
      options: {
        repository: { type: "string", default: builder.defaultRepository },
        tag: { type: "string" },
        push: { type: "boolean", default: false },
      },
    }));
  } catch {
    throw new TypeError(
      `usage: ${builder.script} [--repository NAME] [--tag TAG] [--push]`,
    );
  }
  if (
    values.repository.length === 0 ||
    values.repository.includes("@") ||
    /:[^/]*$/u.test(values.repository)
  ) {
    throw new TypeError(
      `${builder.label} repository must not be empty or carry a tag or digest`,
    );
  }
  if (values.tag !== undefined && !IMAGE_TAG.test(values.tag)) {
    throw new TypeError(`${builder.label} tag must be a valid Docker tag`);
  }
  return { repository: values.repository, tag: values.tag, push: values.push };
}

/**
 * The manifest digest buildx recorded for the image it built.
 * @param {Record<string, unknown>} metadata Parsed `--metadata-file` output.
 * @returns {string} The `sha256:` digest.
 */
export function metadataDigest(metadata) {
  const digest = metadata["containerimage.digest"];
  if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
    throw new Error("docker buildx returned no manifest digest");
  }
  return digest;
}

/**
 * The driver name `docker buildx inspect` reports for the current builder.
 * @param {string} inspectOutput The command's stdout.
 * @returns {string} The driver, for example `docker` or `docker-container`.
 */
export function buildxDriver(inspectOutput) {
  const match = /^Driver:\s*(\S+)/mu.exec(inspectOutput);
  if (match === null) {
    throw new Error("docker buildx inspect reported no driver");
  }
  return match[1];
}

/**
 * Fail before any work when the current builder cannot see the daemon's
 * image store. The NanoClaw image is built FROM a base that is only loaded
 * locally, which the `docker-container` and `kubernetes` drivers cannot
 * resolve; with `--push` that failure would otherwise surface only after the
 * base build.
 * @param {string} label Builder label for the error message.
 * @returns {Promise<void>}
 */
export async function requireDockerBuildxDriver(label) {
  const { stdout } = await exec("docker", ["buildx", "inspect"], {
    timeout: 30_000,
  });
  const driver = buildxDriver(stdout);
  if (driver !== "docker") {
    throw new Error(
      `${label} needs buildx's docker driver, but the current builder uses ${driver}`,
    );
  }
}

/**
 * The local daemon's id for a loaded image.
 * @param {string} image Repository and tag of a loaded image.
 * @param {string} label Builder label for the error message.
 * @returns {Promise<string>} The `sha256:` image id.
 */
export async function localImageId(image, label) {
  const { stdout } = await exec(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", image],
    { timeout: 30_000 },
  );
  const imageId = stdout.trim();
  if (!SHA256_DIGEST.test(imageId)) {
    throw new Error(`docker returned no local ${label} id`);
  }
  return imageId;
}
