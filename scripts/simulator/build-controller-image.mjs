/**
 * @file Builds the shared controller and application-overlay image, then
 * prints both its local tag and manifest-digest identity.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = dirname(dirname(scriptRoot));
const simulatorRoot = join(workspaceRoot, "packages", "simulator");
const dockerfile = join(scriptRoot, "controller-image", "Dockerfile");
const registrar = join(
  workspaceRoot,
  "scripts/simulator/controller-image/register-daemon.mjs",
);
const qualificationProgram = join(
  workspaceRoot,
  "scripts",
  "test",
  "simulator-fault-program.mjs",
);
const DEFAULT_REPOSITORY = "moltzap-simulator-controller";
const BUILD_TIMEOUT_MS = 30 * 60 * 1_000;
const PACK_TIMEOUT_MS = 5 * 60 * 1_000;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const workspacePackages = {
  "@moltzap/client": join(workspaceRoot, "packages", "client"),
  "@moltzap/evals": join(workspaceRoot, "packages", "evals"),
  "@moltzap/openclaw-channel": join(
    workspaceRoot,
    "packages",
    "openclaw-channel",
  ),
  "@moltzap/identity": join(workspaceRoot, "packages", "identity"),
  "@moltzap/router": join(workspaceRoot, "packages", "router"),
  "@moltzap/simulator": simulatorRoot,
};
/** Workspace packages packed into the root-owned controller image context. */
export const controllerWorkspacePackageNames = Object.freeze(
  Object.keys(workspacePackages),
);
/** Workspace tarballs installed directly into the controller image. */
export const controllerPackageDependencies = [
  "@moltzap/client",
  "@moltzap/evals",
  "@moltzap/identity",
  "@moltzap/router",
  "@moltzap/simulator",
];
/** Non-workspace helpers installed in the production-stack image. */
export const controllerExternalDependencies = {
  "@electric-sql/pglite": "0.4.4",
  "@electric-sql/pglite-socket": "0.1.4",
  "@modelcontextprotocol/client": "2.0.0-beta.5",
};
/** Host installed only in the application overlay for the optional adapter peer. */
export const controllerOverlayExternalDependencies = {
  openclaw: "2026.6.34",
};

function report(message) {
  process.stderr.write(`[moltzap controller image] ${message}\n`);
}

function parseArguments(args) {
  if (args.length === 0) {
    return { repository: DEFAULT_REPOSITORY };
  }
  if (args.length !== 2 || args[0] !== "--repository") {
    throw new TypeError(
      "usage: build-controller-image.mjs [--repository NAME]",
    );
  }
  const repository = args[1];
  if (repository.length === 0 || repository.includes("@")) {
    throw new TypeError(
      "controller image repository must not be empty or contain a digest",
    );
  }
  return { repository };
}

async function pack(packageDirectory, destination) {
  const { stdout } = await exec(
    "pnpm",
    ["pack", "--pack-destination", destination],
    { cwd: packageDirectory, timeout: PACK_TIMEOUT_MS },
  );
  const path = stdout.trim().split("\n").at(-1);
  if (path === undefined || !path.endsWith(".tgz")) {
    throw new Error(`pnpm pack returned no archive for ${packageDirectory}`);
  }
  return basename(path);
}

function packageManifest(
  name,
  dependencies,
  archives,
  externalDependencies = {},
) {
  return {
    name,
    version: "0.0.0-local",
    private: true,
    dependencies: Object.fromEntries([
      ...dependencies.map((dependency) => [
        dependency,
        `file:./tarballs/${archives[dependency]}`,
      ]),
      ...Object.entries(externalDependencies),
    ]),
    overrides: Object.fromEntries(
      Object.entries(archives)
        .filter(([packageName]) => !dependencies.includes(packageName))
        .map(([packageName, archive]) => [
          packageName,
          `file:./tarballs/${archive}`,
        ]),
    ),
  };
}

/** Build the install manifest copied into the OpenClaw application overlay. */
export function controllerOverlayPackageManifest(archives) {
  return packageManifest(
    "moltzap-openclaw-overlay",
    ["@moltzap/openclaw-channel"],
    archives,
    controllerOverlayExternalDependencies,
  );
}

async function stage() {
  const root = await mkdtemp(join(tmpdir(), "moltzap-controller-image-"));
  const tarballs = join(root, "tarballs");
  await mkdir(tarballs);
  const packed = await Promise.all(
    Object.entries(workspacePackages).map(async ([name, directory]) => [
      name,
      await pack(directory, tarballs),
    ]),
  );
  const archives = Object.fromEntries(packed);
  await Promise.all([
    copyFile(dockerfile, join(root, "Dockerfile")),
    copyFile(registrar, join(root, "register-daemon.mjs")),
    copyFile(qualificationProgram, join(root, "simulator-fault-program.mjs")),
    writeFile(
      join(root, "controller-package.json"),
      `${JSON.stringify(
        packageManifest(
          "moltzap-controller-image",
          controllerPackageDependencies,
          archives,
          controllerExternalDependencies,
        ),
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(root, "overlay-package.json"),
      `${JSON.stringify(
        controllerOverlayPackageManifest(archives),
        null,
        2,
      )}\n`,
    ),
  ]);
  return root;
}

async function fingerprint(root) {
  const hash = createHash("sha256");
  const inputs = [
    "Dockerfile",
    "controller-package.json",
    "overlay-package.json",
    "register-daemon.mjs",
    "simulator-fault-program.mjs",
    ...(await readdir(join(root, "tarballs"))).map(
      (name) => `tarballs/${name}`,
    ),
  ];
  for (const path of inputs.sort()) {
    hash.update(path);
    hash.update(await readFile(join(root, path)));
  }
  hash.update(await readFile(fileURLToPath(import.meta.url)));
  return hash.digest("hex").slice(0, 16);
}

function buildDigest(metadata) {
  const digest = metadata["containerimage.digest"];
  if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) {
    throw new Error("docker buildx returned no manifest digest");
  }
  return digest;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  report("building controller-image workspace packages");
  await exec(
    "pnpm",
    [
      "nx",
      "run-many",
      "--target=build",
      `--projects=${controllerWorkspacePackageNames.join(",")}`,
    ],
    {
      cwd: workspaceRoot,
      timeout: BUILD_TIMEOUT_MS,
    },
  );
  report("packing the controller and application-overlay dependencies");
  const staging = await stage();
  try {
    const image = `${options.repository}:${await fingerprint(staging)}`;
    const metadataPath = join(staging, "build-metadata.json");
    report(`building ${image}`);
    await exec(
      "docker",
      [
        "buildx",
        "build",
        "--load",
        "--metadata-file",
        metadataPath,
        "--tag",
        image,
        staging,
      ],
      { timeout: BUILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    const imageDigest = buildDigest(metadata);
    const { stdout } = await exec(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", image],
      { timeout: 30_000 },
    );
    const imageId = stdout.trim();
    if (!SHA256_DIGEST.test(imageId)) {
      throw new Error("docker returned no local controller image id");
    }
    process.stdout.write(
      `${JSON.stringify({
        image,
        pinnedImage: `${options.repository}@${imageDigest}`,
        imageDigest,
        imageId,
        controllerEntrypoint: "/opt/moltzap/dist/cluster/controller/main.js",
        supportBootstrap: "/opt/moltzap/dist/cluster/bootstrap.js",
        applicationOverlay: "/opt/moltzap/application-overlay",
        qualificationProgram:
          "/opt/moltzap/qualification/simulator-fault-program.mjs",
      })}\n`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
