/**
 * @file Writes the "Published images" section of the GKE profile README from
 * the digests a release resolved in Artifact Registry.
 *
 * The release workflow pushes the controller, OpenClaw, and NanoClaw images
 * tagged with the release version, resolves each tag to its manifest digest,
 * and hands the result here as JSON. Rendering the table from that file keeps
 * the digests consumers pin next to the npm version that pushed them; a
 * hand-edited table can name an image that no release built.
 *
 * Usage: write-published-images.mjs --digests <file.json>
 *
 * The digest file carries `{ version, sourceRevision, images }` where `images`
 * holds one `{ name, repository, digest }` entry for each of the three image
 * names below.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const README_PATH = join(workspaceRoot, "packages/simulator/gke/README.md");
const SECTION_HEADING = "## Published images";
const CALENDAR_VERSION = /^\d{4}\.\d{3,4}\.\d+$/u;
const GIT_REVISION = /^[0-9a-f]{40}$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** Image names a release publishes, in table order. */
const PUBLISHED_IMAGE_NAMES = Object.freeze([
  "controller",
  "openclaw-agent",
  "nanoclaw-agent",
]);

function requireCondition(condition, detail) {
  if (!condition) {
    throw new TypeError(detail);
  }
}

/**
 * Validate a parsed digest file and return it with images in table order.
 * @param {unknown} input Parsed JSON.
 * @returns {{ version: string, sourceRevision: string, images: readonly { name: string, repository: string, digest: string }[] }}
 */
export function decodePublishedImages(input) {
  requireCondition(
    typeof input === "object" && input !== null && !Array.isArray(input),
    "published images must be a JSON object",
  );
  const { version, sourceRevision, images } = input;
  requireCondition(
    typeof version === "string" && CALENDAR_VERSION.test(version),
    `version must be YYYY.MDD.N, got ${JSON.stringify(version)}`,
  );
  requireCondition(
    typeof sourceRevision === "string" && GIT_REVISION.test(sourceRevision),
    `sourceRevision must be a full commit SHA, got ${JSON.stringify(sourceRevision)}`,
  );
  requireCondition(Array.isArray(images), "images must be an array");
  const byName = new Map();
  for (const image of images) {
    requireCondition(
      typeof image === "object" && image !== null,
      "each image must be an object",
    );
    const { name, repository, digest } = image;
    requireCondition(
      PUBLISHED_IMAGE_NAMES.includes(name),
      `unknown image name ${JSON.stringify(name)}`,
    );
    requireCondition(!byName.has(name), `image ${name} is listed twice`);
    requireCondition(
      typeof repository === "string" &&
        repository.length > 0 &&
        !repository.includes("@") &&
        !/:[^/]*$/u.test(repository),
      `image ${name} repository must not carry a tag or digest`,
    );
    requireCondition(
      typeof digest === "string" && SHA256_DIGEST.test(digest),
      `image ${name} digest must be sha256:<64 hex>, got ${JSON.stringify(digest)}`,
    );
    byName.set(name, { name, repository, digest });
  }
  const missing = PUBLISHED_IMAGE_NAMES.filter((name) => !byName.has(name));
  requireCondition(
    missing.length === 0,
    `images are missing ${missing.join(", ")}`,
  );
  return {
    version,
    sourceRevision,
    images: PUBLISHED_IMAGE_NAMES.map((name) => byName.get(name)),
  };
}

/**
 * Render the section body that follows the "Published images" heading.
 * @param {ReturnType<typeof decodePublishedImages>} published Validated digests.
 * @returns {string} Markdown without the heading.
 */
export function renderPublishedImages(published) {
  const rows = published.images.map(
    ({ name, repository, digest }) =>
      `| ${name} | \`${published.version}\` | \`${repository}@${digest}\` |`,
  );
  return [
    `Release \`${published.version}\` (source revision`,
    `\`${published.sourceRevision}\`) pushed these images. Pin a run to the digest`,
    "reference; the tag is a lookup key, not an input the profile accepts.",
    "",
    "| Image | Tag | Digest reference |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/**
 * Replace the body of the "Published images" section, up to the next level-two
 * heading or the end of the document.
 * @param {string} markdown README contents.
 * @param {string} body Replacement section body.
 * @returns {string} Updated README contents.
 */
export function replacePublishedImagesSection(markdown, body) {
  const heading = new RegExp(`^${SECTION_HEADING}\\n`, "mu");
  const start = markdown.search(heading);
  requireCondition(
    start !== -1,
    `README has no "${SECTION_HEADING}" section to write into`,
  );
  const bodyStart = start + SECTION_HEADING.length + 1;
  const rest = markdown.slice(bodyStart);
  const nextHeading = rest.search(/^## /mu);
  const tail = nextHeading === -1 ? "" : rest.slice(nextHeading);
  return `${markdown.slice(0, bodyStart)}\n${body}${tail.length > 0 ? `\n${tail}` : ""}`;
}

function parseArguments(args) {
  requireCondition(
    args.length === 2 && args[0] === "--digests",
    "usage: write-published-images.mjs --digests <file.json>",
  );
  return { digests: resolve(args[1]) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [digests, readme] = await Promise.all([
    readFile(options.digests, "utf8"),
    readFile(README_PATH, "utf8"),
  ]);
  const published = decodePublishedImages(JSON.parse(digests));
  await writeFile(
    README_PATH,
    replacePublishedImagesSection(readme, renderPublishedImages(published)),
  );
  process.stdout.write(
    `wrote ${published.images.length} published image digests for ${published.version} to ${README_PATH}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
