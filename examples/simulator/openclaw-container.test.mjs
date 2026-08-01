import assert from "node:assert/strict";
import test from "node:test";

import imageConfig from "./openclaw-image.json" with { type: "json" };
import {
  buildDockerRunArguments,
  openClawContainerName,
  removeContainer,
} from "./openclaw-container.mjs";

const runtime = { agentName: "alice", runId: "run-123" };
const stateDir = "/tmp/openclaw-alice";
const environment = {
  HOME: stateDir,
  MOLTZAP_CONFIG_HOME: `${stateDir}/.moltzap`,
  MOLTZAP_SERVER_URL: "http://127.0.0.1:43123",
  OPENCLAW_CONFIG_PATH: `${stateDir}/openclaw.json`,
  OPENCLAW_STATE_DIR: stateDir,
  OPENAI_API_KEY: "operator-model-secret",
  SHOULD_NOT_ESCAPE: "secret",
};

test("builds a digest-pinned, non-root, least-privilege agent container", () => {
  const args = buildDockerRunArguments({
    environment,
    gid: 1003,
    openClawArguments: [
      "gateway",
      "run",
      "--allow-unconfigured",
      "--port",
      "43124",
    ],
    readOnlyMounts: ["/workspace/node_modules", "/workspace/packages/client"],
    runtime,
    stateDir,
    uid: 1003,
  });
  const rendered = args.join(" ");

  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--network=host"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges:true"));
  assert.ok(args.includes("1003:1003"));
  assert.ok(args.includes(imageConfig.image));
  assert.match(
    rendered,
    /src=\/tmp\/openclaw-alice,dst=\/tmp\/openclaw-alice(?: |$)/u,
  );
  assert.match(
    rendered,
    /src=\/workspace\/node_modules,dst=\/workspace\/node_modules,readonly/u,
  );
  assert.match(rendered, /com\.moltzap\.simulator\.run=run-123/u);
  assert.match(rendered, /node \/app\/openclaw\.mjs gateway run/u);
  assert.doesNotMatch(
    rendered,
    /OPENAI_API_KEY|SHOULD_NOT_ESCAPE|operator-model-secret|secret|docker\.sock|--privileged/u,
  );
});

test("keeps run and agent identity in the scoped container name", () => {
  assert.equal(openClawContainerName(runtime), "moltzap-sim-run-123-alice");
});

test("refuses to run an agent container as root", () => {
  assert.throws(
    () =>
      buildDockerRunArguments({
        environment,
        gid: 0,
        openClawArguments: ["gateway", "run"],
        readOnlyMounts: [],
        runtime,
        stateDir,
        uid: 0,
      }),
    /non-root/u,
  );
});

test("confirms an already absent container after force-remove fails", () => {
  const calls = [];
  const execute = (command, args) => {
    calls.push({ args, command });
    return {
      status: 1,
      stderr:
        args[0] === "rm" ? "remove failed" : "Error: No such object: agent",
    };
  };

  assert.deepEqual(
    removeContainer("agent", { dockerBin: "/custom/docker", execute }),
    { removed: true },
  );
  assert.deepEqual(calls, [
    { command: "/custom/docker", args: ["rm", "--force", "agent"] },
    {
      command: "/custom/docker",
      args: ["container", "inspect", "agent"],
    },
  ]);
});

test("reports an unconfirmed container removal after bounded retries", () => {
  const calls = [];
  const execute = (_command, args) => {
    calls.push(args);
    return { status: 1, stderr: "docker daemon unavailable" };
  };

  const result = removeContainer("agent", { execute });
  assert.equal(result.removed, false);
  assert.match(result.detail, /daemon unavailable/u);
  assert.equal(calls.length, 6);
});
