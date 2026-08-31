/**
 * @file Isolates state written by OpenClaw's public inbound runner.
 * This setup runs before test imports so OpenClaw never resolves a developer's
 * state directory while recording test sessions.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

/** Temporary OpenClaw state directory shared by setup and test configuration. */
export const openClawTestStateDirectory = mkdtempSync(
  join(tmpdir(), "moltzap-openclaw-channel-test-"),
);

vi.stubEnv("OPENCLAW_STATE_DIR", openClawTestStateDirectory);

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(openClawTestStateDirectory, { recursive: true, force: true });
});
