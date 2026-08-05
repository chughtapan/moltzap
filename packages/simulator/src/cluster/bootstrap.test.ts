/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals -- Regression-only filesystem cases exercise the Promise-native CLI boundary and keep each hostile fixture next to its containment assertion. */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { materializeBootstrap } from "./bootstrap.js";

const roots: string[] = [];
const execFile = promisify(execFileCallback);

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly output: string;
  readonly overlay: string;
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
  const overlay = join(root, "overlay");
  const manifest = join(root, "manifest.json");
  await Promise.all([mkdir(source), mkdir(overlay)]);
  return { root, source, output, overlay, manifest };
}

async function writeManifest(fixture: Fixture, value: unknown): Promise<void> {
  await writeFile(fixture.manifest, JSON.stringify(value), "utf8");
}

function options(fixture: Fixture) {
  return {
    manifest: fixture.manifest,
    source: fixture.source,
    output: fixture.output,
    overlay: fixture.overlay,
  } as const;
}

afterEach(async () => {
  const stale = roots.splice(0);
  await Promise.all(
    stale.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("materializeBootstrap", () => {
  it("copies the trusted overlay before placing regular Secret files with exact modes", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.overlay, "openclaw-channel"));
    await writeFile(
      join(fixture.overlay, "openclaw-channel", "package.json"),
      "overlay",
      "utf8",
    );
    await writeFile(
      join(fixture.overlay, "openclaw.json"),
      "placeholder",
      "utf8",
    );
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

    await materializeBootstrap(options(fixture));

    await expect(
      readFile(join(fixture.output, "openclaw.json"), "utf8"),
    ).resolves.toBe("secret-config");
    await expect(
      readFile(join(fixture.output, "moltzap", "config.json"), "utf8"),
    ).resolves.toBe("secret-profile");
    await expect(
      readFile(
        join(fixture.output, "openclaw-channel", "package.json"),
        "utf8",
      ),
    ).resolves.toBe("overlay");
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

      await expect(materializeBootstrap(options(fixture))).rejects.toThrow();
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

    await materializeBootstrap(options(fixture));

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
      "--overlay",
      fixture.overlay,
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
  });

  it("rejects a non-regular Secret source before changing output", async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.source, "directory"));
    await writeManifest(fixture, {
      apiVersion: "moltzap.bootstrap/v1",
      files: [{ source: "directory", path: "config", mode: 0o600 }],
    });

    await expect(materializeBootstrap(options(fixture))).rejects.toThrow(
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
      await expect(materializeBootstrap(options(fixture))).rejects.toThrow();
      await expect(lstat(fixture.output)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("does not follow an overlay symlink when placing a Secret", async () => {
    const fixture = await makeFixture();
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(fixture.overlay, "redirect"));
    await writeFile(join(fixture.source, "config"), "secret", "utf8");
    await writeManifest(fixture, {
      apiVersion: "moltzap.bootstrap/v1",
      files: [{ source: "config", path: "redirect/config", mode: 0o600 }],
    });

    await expect(materializeBootstrap(options(fixture))).rejects.toThrow(
      /target parent is not a directory/u,
    );
    await expect(lstat(join(outside, "config"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, @typescript-eslint/no-invalid-void-type, max-lines-per-function, sonarjs/max-lines-per-function, agent-code-guard/no-example-only-tests, agent-code-guard/no-hardcoded-assertion-literals -- Restore strict defaults after the filesystem regression suite. */
