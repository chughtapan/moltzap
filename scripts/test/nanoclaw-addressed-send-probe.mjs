/** @file Drives NanoClaw's native inbox and outbound queue through its registered channel. */

import { spawn } from "node:child_process";
import { mkdtemp, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_ROOT = "/opt/moltzap/nanoclaw/app/dist";
const RUNNER_ROOT = "/opt/moltzap/nanoclaw/app/container/agent-runner/src";
const CURRENT_WORKSPACE = "/var/lib/moltzap/nanoclaw/current-workspace";

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `NanoClaw send_message probe exited with ${String(code ?? signal)}`,
        ),
      );
    });
  });
}

async function replaceWorkspace(target) {
  try {
    await unlink(CURRENT_WORKSPACE);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await symlink(target, CURRENT_WORKSPACE);
}

async function invokeOutboundPaths(destinations) {
  const source = `
    import '${RUNNER_ROOT}/modules/index.ts';
    import { sendMessage } from '${RUNNER_ROOT}/mcp-tools/core.ts';
    import { dispatchResultText } from '${RUNNER_ROOT}/poll-loop.ts';
    const destinations = JSON.parse(process.env.NANOCLAW_DESTINATIONS_JSON);
    if (destinations.length !== 2) {
      throw new Error('NanoClaw probe requires one tool send and one final-output send');
    }
    const toolResult = await sendMessage.handler(destinations[0]);
    if (toolResult.isError === true) {
      throw new Error(toolResult.content.map(({ text }) => text).join('\\n'));
    }
    const finalDestination = destinations[1];
    const finalResult = await dispatchResultText(
      '<message to="' + finalDestination.to + '">' + finalDestination.text + '</message>',
      {
        platformId: null,
        channelType: null,
        threadId: null,
        inReplyTo: null,
        taskRun: false,
      },
    );
    if (finalResult.sent !== 1) {
      throw new Error('NanoClaw final-output path did not queue exactly one message');
    }
  `;
  const child = spawn("bun", ["--eval", source], {
    env: {
      ...process.env,
      NANOCLAW_DESTINATIONS_JSON: JSON.stringify(destinations),
    },
    stdio: "inherit",
  });
  await waitForChild(child);
}

async function waitForInbound(session, expected, withMailboxSession) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const history = await withMailboxSession("agent", session.id, (mailbox) =>
      mailbox.getInboundHistory(10),
    );
    const observed = history.some(({ content }) => {
      const decoded = JSON.parse(content);
      return (
        decoded.text === expected.text &&
        decoded.address === expected.platformId &&
        decoded.sender === expected.sender &&
        decoded.senderId === expected.sender
      );
    });
    if (observed) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("NanoClaw native inbox did not receive the MoltZap message");
}

async function main() {
  required("MOLTZAP_MCP_URL");
  const destinations = JSON.parse(required("NANOCLAW_DESTINATIONS_JSON"));
  const expectedInbound = JSON.parse(required("NANOCLAW_INBOUND_JSON"));
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new Error("NANOCLAW_DESTINATIONS_JSON must contain sends");
  }

  const stateRoot = await mkdtemp(join(tmpdir(), "nanoclaw-send-probe-"));
  process.chdir(stateRoot);

  await import(`${APP_ROOT}/mailbox/compose.js`);
  await import(`${APP_ROOT}/channels/moltzap.js`);
  const { closeDb, createAgentGroup, initTestDb, runMigrations } = await import(
    `${APP_ROOT}/db/index.js`
  );
  const {
    createChannelDeliveryAdapter,
    getActiveAdapters,
    initChannelAdapters,
    teardownChannelAdapters,
  } = await import(`${APP_ROOT}/channels/channel-registry.js`);
  const { deliverSessionMessages, setDeliveryAdapter } = await import(
    `${APP_ROOT}/delivery.js`
  );
  const { routeInbound } = await import(`${APP_ROOT}/router.js`);
  const { resolveSession, sessionDir, withMailboxSession } = await import(
    `${APP_ROOT}/session-manager.js`
  );

  const database = await initTestDb();
  await runMigrations(database);
  try {
    await createAgentGroup({
      id: "agent",
      name: "NanoClaw integration",
      folder: "agent",
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const { session } = await resolveSession(
      "agent",
      null,
      null,
      "agent-shared",
    );
    await replaceWorkspace(sessionDir("agent", session.id));

    let metadataObserved = false;
    await initChannelAdapters((adapter) => ({
      onInbound: (platformId, threadId, message) => {
        if (!metadataObserved) {
          throw new Error(
            "NanoClaw received content before conversation metadata",
          );
        }
        return routeInbound({
          channelType: adapter.channelType,
          targetAgentGroupId: adapter.targetAgentGroupId,
          instance: adapter.instance ?? adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        });
      },
      onInboundEvent: () => Promise.resolve(),
      onMetadata: (platformId, name, isGroup) => {
        if (
          platformId === expectedInbound.platformId &&
          name === expectedInbound.platformId &&
          isGroup === false
        ) {
          metadataObserved = true;
        }
      },
      onAction: () => {},
    }));
    if (
      !getActiveAdapters().some(({ channelType }) => channelType === "moltzap")
    ) {
      throw new Error("NanoClaw did not start the MoltZap channel adapter");
    }
    setDeliveryAdapter(createChannelDeliveryAdapter());

    await waitForInbound(session, expectedInbound, withMailboxSession);
    await invokeOutboundPaths(destinations);
    await deliverSessionMessages(session);

    const delivered = await withMailboxSession("agent", session.id, (mailbox) =>
      mailbox.getDeliveredIds(),
    );
    if (delivered.size !== destinations.length) {
      throw new Error(
        `NanoClaw delivered ${String(delivered.size)} of ${String(destinations.length)} queued messages`,
      );
    }
  } finally {
    await teardownChannelAdapters();
    await closeDb();
  }
}

await main();
