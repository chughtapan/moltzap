import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  EFFECT_COMMIT,
  EFFECT_REPOSITORY_URL,
  EFFECT_TAG,
  EffectSourceMismatchError,
  effectSourcePath,
  prepareEffectSource,
  promoteEffectCheckout,
  verifyEffectCheckout,
} from "./prepare-effect.mjs";

const silent = () => {};

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const makeTempDir = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const makeRemote = (t) => {
  const fixtureRoot = makeTempDir(t, "moltzap-effect-remote-");
  const repositoryDir = join(fixtureRoot, "effect");
  mkdirSync(repositoryDir);
  git(repositoryDir, "init", "--quiet");
  git(repositoryDir, "config", "user.name", "Moltzap Test");
  git(repositoryDir, "config", "user.email", "test@moltzap.invalid");
  writeFileSync(join(repositoryDir, "README.md"), "# local Effect fixture\n");
  git(repositoryDir, "add", "README.md");
  git(repositoryDir, "commit", "--quiet", "-m", "fixture");
  git(repositoryDir, "tag", EFFECT_TAG);

  return {
    commit: git(repositoryDir, "rev-parse", "HEAD"),
    repositoryDir,
    repositoryUrl: pathToFileURL(repositoryDir).href,
  };
};

const makeWorkspace = (t) => makeTempDir(t, "moltzap-effect-workspace-");

const prepareFixture = (t) => {
  const remote = makeRemote(t);
  const workspaceRoot = makeWorkspace(t);
  const result = prepareEffectSource({
    workspaceRoot,
    repositoryUrl: remote.repositoryUrl,
    tag: EFFECT_TAG,
    commit: remote.commit,
    env: {},
    logger: silent,
  });
  return {
    ...remote,
    checkoutDir: result.checkoutDir,
    workspaceRoot,
  };
};

const snapshotCheckout = (checkoutDir) => ({
  head: git(checkoutDir, "rev-parse", "HEAD"),
  origin: git(checkoutDir, "remote", "get-url", "origin"),
  status: git(checkoutDir, "status", "--short", "--untracked-files=all"),
  tags: git(checkoutDir, "tag", "--list"),
});

const assertMismatchWithoutMutation = ({
  checkoutDir,
  expectedMessage,
  prepare,
}) => {
  const before = snapshotCheckout(checkoutDir);
  assert.throws(
    prepare,
    (error) =>
      error instanceof EffectSourceMismatchError &&
      expectedMessage.test(error.message) &&
      error.message.includes("bootstrap never modifies a mismatched checkout"),
  );
  assert.deepEqual(snapshotCheckout(checkoutDir), before);
};

test("exports the pinned stable Effect source", () => {
  assert.equal(
    EFFECT_REPOSITORY_URL,
    "https://github.com/Effect-TS/effect.git",
  );
  assert.equal(EFFECT_TAG, "effect@3.22.0");
  assert.equal(EFFECT_COMMIT, "e670e0f6befb959b84208d5f77631276521020ae");
});

test("MOLTZAP_SKIP_EFFECT_SOURCE=1 skips before touching .repos", (t) => {
  const workspaceRoot = makeWorkspace(t);
  const result = prepareEffectSource({
    workspaceRoot,
    repositoryUrl: "file:///this/repository/does/not/exist",
    tag: EFFECT_TAG,
    commit: EFFECT_COMMIT,
    env: { MOLTZAP_SKIP_EFFECT_SOURCE: "1" },
    logger: silent,
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.checkoutDir, effectSourcePath(workspaceRoot));
  assert.equal(readdirSync(workspaceRoot).length, 0);
});

test("clones the exact tag atomically and is idempotent", (t) => {
  const remote = makeRemote(t);
  const workspaceRoot = makeWorkspace(t);
  const options = {
    workspaceRoot,
    repositoryUrl: remote.repositoryUrl,
    tag: EFFECT_TAG,
    commit: remote.commit,
    env: {},
    logger: silent,
  };

  const first = prepareEffectSource(options);
  assert.equal(first.status, "cloned");
  assert.equal(
    git(first.checkoutDir, "remote", "get-url", "origin"),
    remote.repositoryUrl,
  );
  assert.equal(git(first.checkoutDir, "rev-parse", "HEAD"), remote.commit);
  assert.equal(
    git(first.checkoutDir, "rev-parse", "--is-shallow-repository"),
    "true",
  );
  assert.equal(
    git(first.checkoutDir, "rev-parse", "--verify", `${EFFECT_TAG}^{commit}`),
    remote.commit,
  );
  assert.deepEqual(
    readdirSync(join(workspaceRoot, ".repos")).filter((name) =>
      name.startsWith(".effect.tmp-"),
    ),
    [],
  );

  const marker = join(first.checkoutDir, "idempotence-marker");
  writeFileSync(marker, "preserve me\n");
  const second = prepareEffectSource(options);
  assert.equal(second.status, "existing");
  assert.equal(readFileSync(marker, "utf8"), "preserve me\n");
});

test("cleans its owned temp checkout when clone fails", (t) => {
  const workspaceRoot = makeWorkspace(t);
  const missingRepository = pathToFileURL(
    join(workspaceRoot, "missing-effect-remote"),
  ).href;

  assert.throws(
    () =>
      prepareEffectSource({
        workspaceRoot,
        repositoryUrl: missingRepository,
        tag: EFFECT_TAG,
        commit: EFFECT_COMMIT,
        env: {},
        logger: silent,
      }),
    /git clone .* failed with exit 128/,
  );

  assert.equal(existsSync(effectSourcePath(workspaceRoot)), false);
  assert.deepEqual(readdirSync(join(workspaceRoot, ".repos")), []);
});

test("rejects a bare repository as an existing checkout", (t) => {
  const workspaceRoot = makeWorkspace(t);
  const checkoutDir = effectSourcePath(workspaceRoot);
  mkdirSync(join(workspaceRoot, ".repos"), { recursive: true });
  git(workspaceRoot, "init", "--bare", "--quiet", checkoutDir);

  assert.throws(
    () =>
      prepareEffectSource({
        workspaceRoot,
        env: {},
        logger: silent,
      }),
    (error) =>
      error instanceof EffectSourceMismatchError &&
      error.message.includes("expected a Git worktree"),
  );
});

test("reports an unavailable Git executable as a checkout mismatch", (t) => {
  const fixture = prepareFixture(t);
  const originalPath = process.env.PATH;

  try {
    process.env.PATH = "";
    assert.throws(
      () =>
        verifyEffectCheckout({
          checkoutDir: fixture.checkoutDir,
          repositoryUrl: fixture.repositoryUrl,
          tag: EFFECT_TAG,
          commit: fixture.commit,
        }),
      (error) =>
        error instanceof EffectSourceMismatchError &&
        error.message.includes("not a readable Git worktree") &&
        error.message.includes("ENOENT"),
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("accepts the exact checkout that wins a concurrent promotion", (t) => {
  const remote = makeRemote(t);
  const winnerWorkspace = makeWorkspace(t);
  const candidateWorkspace = makeWorkspace(t);
  const options = {
    repositoryUrl: remote.repositoryUrl,
    tag: EFFECT_TAG,
    commit: remote.commit,
    env: {},
    logger: silent,
  };
  const winner = prepareEffectSource({
    ...options,
    workspaceRoot: winnerWorkspace,
  });
  const candidate = prepareEffectSource({
    ...options,
    workspaceRoot: candidateWorkspace,
  });
  const before = snapshotCheckout(winner.checkoutDir);

  const status = promoteEffectCheckout({
    tempDir: candidate.checkoutDir,
    checkoutDir: winner.checkoutDir,
    repositoryUrl: remote.repositoryUrl,
    tag: EFFECT_TAG,
    commit: remote.commit,
  });

  assert.equal(status, "existing");
  assert.equal(existsSync(candidate.checkoutDir), true);
  assert.deepEqual(snapshotCheckout(winner.checkoutDir), before);
});

test("rejects a mismatched checkout that wins a concurrent promotion", (t) => {
  const remote = makeRemote(t);
  const candidateWorkspace = makeWorkspace(t);
  const winnerWorkspace = makeWorkspace(t);
  const candidate = prepareEffectSource({
    workspaceRoot: candidateWorkspace,
    repositoryUrl: remote.repositoryUrl,
    tag: EFFECT_TAG,
    commit: remote.commit,
    env: {},
    logger: silent,
  });
  const winnerCheckout = effectSourcePath(winnerWorkspace);
  mkdirSync(join(winnerWorkspace, ".repos"), { recursive: true });
  git(winnerWorkspace, "init", "--quiet", winnerCheckout);
  git(winnerCheckout, "config", "user.name", "Moltzap Test");
  git(winnerCheckout, "config", "user.email", "test@moltzap.invalid");
  writeFileSync(join(winnerCheckout, "README.md"), "# wrong checkout\n");
  git(winnerCheckout, "add", "README.md");
  git(winnerCheckout, "commit", "--quiet", "-m", "wrong checkout");
  git(winnerCheckout, "tag", EFFECT_TAG);
  git(
    winnerCheckout,
    "remote",
    "add",
    "origin",
    "https://example.invalid/effect.git",
  );
  const before = snapshotCheckout(winnerCheckout);

  assert.throws(
    () =>
      promoteEffectCheckout({
        tempDir: candidate.checkoutDir,
        checkoutDir: winnerCheckout,
        repositoryUrl: remote.repositoryUrl,
        tag: EFFECT_TAG,
        commit: remote.commit,
      }),
    (error) =>
      error instanceof EffectSourceMismatchError &&
      error.message.includes("origin expected"),
  );

  assert.equal(existsSync(candidate.checkoutDir), true);
  assert.deepEqual(snapshotCheckout(winnerCheckout), before);
});

test("existing origin, HEAD, and tag mismatches fail without mutation", async (t) => {
  await t.test("origin mismatch", (t) => {
    const fixture = prepareFixture(t);
    git(
      fixture.checkoutDir,
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/effect.git",
    );

    assertMismatchWithoutMutation({
      checkoutDir: fixture.checkoutDir,
      expectedMessage: /origin expected/,
      prepare: () =>
        prepareEffectSource({
          workspaceRoot: fixture.workspaceRoot,
          repositoryUrl: fixture.repositoryUrl,
          tag: EFFECT_TAG,
          commit: fixture.commit,
          env: {},
          logger: silent,
        }),
    });
  });

  await t.test("origin unavailable", (t) => {
    const fixture = prepareFixture(t);
    git(fixture.checkoutDir, "remote", "remove", "origin");
    const before = {
      head: git(fixture.checkoutDir, "rev-parse", "HEAD"),
      status: git(
        fixture.checkoutDir,
        "status",
        "--short",
        "--untracked-files=all",
      ),
      taggedCommit: git(
        fixture.checkoutDir,
        "rev-parse",
        "--verify",
        `${EFFECT_TAG}^{commit}`,
      ),
    };

    assert.throws(
      () =>
        prepareEffectSource({
          workspaceRoot: fixture.workspaceRoot,
          repositoryUrl: fixture.repositoryUrl,
          tag: EFFECT_TAG,
          commit: fixture.commit,
          env: {},
          logger: silent,
        }),
      (error) =>
        error instanceof EffectSourceMismatchError &&
        error.message.includes("origin could not be verified"),
    );

    assert.deepEqual(
      {
        head: git(fixture.checkoutDir, "rev-parse", "HEAD"),
        status: git(
          fixture.checkoutDir,
          "status",
          "--short",
          "--untracked-files=all",
        ),
        taggedCommit: git(
          fixture.checkoutDir,
          "rev-parse",
          "--verify",
          `${EFFECT_TAG}^{commit}`,
        ),
      },
      before,
    );
  });

  await t.test("HEAD mismatch", (t) => {
    const fixture = prepareFixture(t);
    git(fixture.checkoutDir, "config", "user.name", "Moltzap Test");
    git(fixture.checkoutDir, "config", "user.email", "test@moltzap.invalid");
    writeFileSync(join(fixture.checkoutDir, "new-commit"), "new HEAD\n");
    git(fixture.checkoutDir, "add", "new-commit");
    git(fixture.checkoutDir, "commit", "--quiet", "-m", "move HEAD");

    assertMismatchWithoutMutation({
      checkoutDir: fixture.checkoutDir,
      expectedMessage: /HEAD expected/,
      prepare: () =>
        prepareEffectSource({
          workspaceRoot: fixture.workspaceRoot,
          repositoryUrl: fixture.repositoryUrl,
          tag: EFFECT_TAG,
          commit: fixture.commit,
          env: {},
          logger: silent,
        }),
    });
  });

  await t.test("tag mismatch", (t) => {
    const fixture = prepareFixture(t);
    git(fixture.checkoutDir, "tag", "--delete", EFFECT_TAG);

    assertMismatchWithoutMutation({
      checkoutDir: fixture.checkoutDir,
      expectedMessage: /tag "effect@3\.22\.0" could not be verified/,
      prepare: () =>
        prepareEffectSource({
          workspaceRoot: fixture.workspaceRoot,
          repositoryUrl: fixture.repositoryUrl,
          tag: EFFECT_TAG,
          commit: fixture.commit,
          env: {},
          logger: silent,
        }),
    });
  });

  await t.test("tag resolves to the wrong commit", (t) => {
    const fixture = prepareFixture(t);
    git(fixture.checkoutDir, "config", "user.name", "Moltzap Test");
    git(fixture.checkoutDir, "config", "user.email", "test@moltzap.invalid");
    git(
      fixture.checkoutDir,
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "wrong tag target",
    );
    const wrongTaggedCommit = git(fixture.checkoutDir, "rev-parse", "HEAD");
    git(fixture.checkoutDir, "tag", "--force", EFFECT_TAG, wrongTaggedCommit);
    git(fixture.checkoutDir, "reset", "--hard", "--quiet", fixture.commit);

    assert.throws(
      () =>
        prepareEffectSource({
          workspaceRoot: fixture.workspaceRoot,
          repositoryUrl: fixture.repositoryUrl,
          tag: EFFECT_TAG,
          commit: fixture.commit,
          env: {},
          logger: silent,
        }),
      (error) =>
        error instanceof EffectSourceMismatchError &&
        error.message.includes(`tag "${EFFECT_TAG}" expected`) &&
        error.message.includes(wrongTaggedCommit),
    );

    assert.equal(git(fixture.checkoutDir, "rev-parse", "HEAD"), fixture.commit);
    assert.equal(
      git(
        fixture.checkoutDir,
        "rev-parse",
        "--verify",
        `${EFFECT_TAG}^{commit}`,
      ),
      wrongTaggedCommit,
    );
  });
});

test("cleans its owned temp checkout when fresh verification fails", (t) => {
  const remote = makeRemote(t);
  const workspaceRoot = makeWorkspace(t);

  assert.throws(
    () =>
      prepareEffectSource({
        workspaceRoot,
        repositoryUrl: remote.repositoryUrl,
        tag: EFFECT_TAG,
        commit: "0000000000000000000000000000000000000000",
        env: {},
        logger: silent,
      }),
    EffectSourceMismatchError,
  );

  assert.equal(existsSync(effectSourcePath(workspaceRoot)), false);
  assert.deepEqual(readdirSync(join(workspaceRoot, ".repos")), []);
});
