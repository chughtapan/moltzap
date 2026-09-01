/** @file Bootstrap materialization containment, symlink, mode, and CLI regressions. */

import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { execFile as execFileCallback } from "node:child_process";
import * as NodeFs from "node:fs/promises"; // eslint-disable-line agent-code-guard/prefer-effect-platform -- Hostile fixtures use Node's own filesystem so tests exercise the syscalls the materializer must contain.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { materializeBootstrap } from "./bootstrap.js";

/* eslint-disable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type, max-lines-per-function, sonarjs/max-lines-per-function -- Hostile fixtures are built with Node's own filesystem so the suite exercises the exact syscalls the materializer must survive, and each fixture stays next to its containment assertion. */

const { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } =
  NodeFs;
const roots: string[] = [];
const execFile = promisify(execFileCallback);

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly output: string;
  readonly manifest: string;
}

interface ExecFileFailure {
  readonly code: number;
  readonly stderr: string;
}

function isExecFileFailure(value: unknown): value is ExecFileFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("code" in value) || typeof value.code !== "number") {
    return false;
  }
  return "stderr" in value && typeof value.stderr === "string";
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "moltzap-bootstrap-test-"));
  roots.push(root);
  const source = join(root, "source");
  const output = join(root, "output");
  const manifest = join(root, "manifest.json");
  await mkdir(source);
  return { root, source, output, manifest };
}

async function writeManifest(fixture: Fixture, value: unknown): Promise<void> {
  await writeFile(fixture.manifest, JSON.stringify(value), "utf8");
}

function materialize(fixture: Fixture): Promise<void> {
  return Effect.runPromise(
    materializeBootstrap(options(fixture)).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );
}

function options(fixture: Fixture) {
  return {
    manifest: fixture.manifest,
    source: fixture.source,
    output: fixture.output,
  } as const;
}

afterEach(async () => {
  const stale = roots.splice(0);
  for (const root of stale) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("materializeBootstrap", () => {
  it("places regular Secret files with exact modes", async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.source, "config"), "secret-config", "utf8");
    await writeFile(join(fixture.source, "profile"), "secret-profile", "utf8");
    await chmod(join(fixture.source, "config"), 0o644);
    await writeManifest(fixture, {
      apiVersion: "moltzap.bootstrap/v1",
      files: [
        { source: "config", path: "openclaw.json", mode: 0o600 },
        { source: "profile", path: "moltzap/config.json", mode: 0o640 },
      ],
    });

    await materialize(fixture);

    await expect(
      readFile(join(fixture.output, "openclaw.json"), "utf8"),
    ).resolves.toBe("secret-config");
    await expect(
      readFile(join(fixture.output, "moltzap", "config.json"), "utf8"),
    ).resolves.toBe("secret-profile");
    expect(
      (await stat(join(fixture.output, "openclaw.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(fixture.output, "moltzap", "config.json"))).mode & 0o777,
    ).toBe(0o640);
  });

  const invalidManifests: ReadonlyArray<readonly [string, unknown]> = [
    [
      "an absolute target",
      {
        apiVersion: "moltzap.bootstrap/v1",
        files: [{ source: "config", path: "/outside", mode: 0o600 }],
      },
    ],
    [
      "a traversal target",
      {
        apiVersion: "moltzap.bootstrap/v1",
        files: [
          { source: "config", path: "nested/../../outside", mode: 0o600 },
        ],
      },
    ],
    [
      "duplicate targets",
      {
        apiVersion: "moltzap.bootstrap/v1",
        files: [
          { source: "config", path: "same", mode: 0o600 },
          { source: "profile", path: "same", mode: 0o600 },
        ],
      },
    ],
    [
      "a slash-containing source",
      {
        apiVersion: "moltzap.bootstrap/v1",
        files: [{ source: "nested/config", path: "config", mode: 0o600 }],
      },
    ],
    [
      "permission bits outside mode",
      {
        apiVersion: "moltzap.bootstrap/v1",
        files: [{ source: "config", path: "config", mode: 0o1000 }],
      },
    ],
    [
      "an unknown file key",
      {
        apiVersion: "moltzap.bootstrap/v1",
        files: [
          { source: "config", path: "config", mode: 0o600, content: "secret" },
        ],
      },
    ],
    [
      "an unknown root key",
      { apiVersion: "moltzap.bootstrap/v1", files: [], extra: true },
    ],
  ];

  for (const [name, manifest] of invalidManifests) {
    it(`rejects ${name}`, async () => {
      const fixture = await makeFixture();
      await writeFile(join(fixture.source, "config"), "secret", "utf8");
      await writeFile(join(fixture.source, "profile"), "secret", "utf8");
      await writeManifest(fixture, manifest);

      await expect(materialize(fixture)).rejects.toThrow();
      await expect(lstat(fixture.output)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  }

  it("accepts a contained Kubernetes atomic-writer Secret entry", async () => {
    const fixture = await makeFixture();
    const generation = "..2026_08_03_21_48_00";
    await mkdir(join(fixture.source, generation));
    await writeFile(
      join(fixture.source, generation, "config"),
      "secret",
      "utf8",
    );
    await symlink(generation, join(fixture.source, "..data"));
    await symlink("..data/config", join(fixture.source, "config"));
    await writeManifest(fixture, {
      apiVersion: "moltzap.bootstrap/v1",
      files: [{ source: "config", path: "config", mode: 0o600 }],
    });

    await materialize(fixture);

    await expect(
      readFile(join(fixture.output, "config"), "utf8"),
    ).resolves.toBe("secret");
  });

  it("runs the CLI through a real symlink and preserves nonzero failures", async () => {
    const fixture = await makeFixture();
    const script = join(fixture.root, "bootstrap.ts");
    await symlink(
      fileURLToPath(new URL("./bootstrap.ts", import.meta.url)),
      script,
    );
    await writeFile(join(fixture.source, "config"), "materialized", "utf8");
    await writeManifest(fixture, {
      apiVersion: "moltzap.bootstrap/v1",
      files: [{ source: "config", path: "config", mode: 0o600 }],
    });

    await execFile(process.execPath, [
      script,
      "--manifest",
      fixture.manifest,
      "--source",
      fixture.source,
      "--output",
      fixture.output,
    ]);

    await expect(
      readFile(join(fixture.output, "config"), "utf8"),
    ).resolves.toBe("materialized");
    let failure: unknown;
    try {
      await execFile(process.execPath, [script]);
    } catch (cause) {
      failure = cause;
    }
    expect(isExecFileFailure(failure)).toBe(true);
    if (isExecFileFailure(failure)) {
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain("bootstrap materialization failed");
    }
    // Two real Node processes, each loading the Effect runtime the initializer
    // shares with the controller: roughly 2.5s of module graph per spawn.
  }, 30_000);

  it("rejects a non-regular Secret source before changing output", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.source, "directory"));
    await writeManifest(fixture, {
      apiVersion: "moltzap.bootstrap/v1",
      files: [{ source: "directory", path: "config", mode: 0o600 }],
    });

    await expect(materialize(fixture)).rejects.toThrow(
      /resolve to a regular file/u,
    );
    await expect(lstat(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects dangling and escaping Secret symlinks", async () => {
    const fixture = await makeFixture();
    const outside = join(fixture.root, "outside-secret");
    await writeFile(outside, "secret", "utf8");
    await symlink("missing", join(fixture.source, "dangling"));
    await symlink(outside, join(fixture.source, "escaping"));

    for (const source of ["dangling", "escaping"]) {
      await writeManifest(fixture, {
        apiVersion: "moltzap.bootstrap/v1",
        files: [{ source, path: "config", mode: 0o600 }],
      });
      await expect(materialize(fixture)).rejects.toThrow();
      await expect(lstat(fixture.output)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("does not follow an existing output symlink when placing a Secret", async () => {
    const fixture = await makeFixture();
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await mkdir(fixture.output);
    await symlink(outside, join(fixture.output, "redirect"));
    await writeFile(join(fixture.source, "config"), "secret", "utf8");
    await writeManifest(fixture, {
      apiVersion: "moltzap.bootstrap/v1",
      files: [{ source: "config", path: "redirect/config", mode: 0o600 }],
    });

    await expect(materialize(fixture)).rejects.toThrow(
      /target parent is not a directory/u,
    );
    await expect(lstat(join(outside, "config"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

/* eslint-enable agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type, max-lines-per-function, sonarjs/max-lines-per-function -- Restore strict defaults after the filesystem regression suite. */
