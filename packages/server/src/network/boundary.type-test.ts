/**
 * Compile-time boundary tests — network may NOT import from task.
 *
 * Architect-stage placeholders (spec #135 AC9). The `implement-*` pass fills
 * each `it.todo` with a typed assertion — typically a `// @ts-expect-error`
 * next to an `import` statement that attempts to reach into `../task/...`.
 * The expected error is a TypeScript module-resolution error (TS2307 or a
 * project-reference diagnostic under `composite: true`), NOT merely an ESLint
 * warning. The ESLint `no-restricted-imports` rule in `eslint.config.mjs` is
 * defense-in-depth for reviewer visibility; this file gates the build.
 *
 * The file itself lives under `packages/server/src/network/` so the boundary
 * it probes is the one its own compilation unit is subject to.
 */

import { describe, it } from "vitest";

describe("network <-> task module boundary — compile-time enforcement", () => {
  it.todo(
    "emits a TypeScript module-resolution error when a network file attempts `import { MessageService } from '../task/services/message-service.js'`",
  );
  it.todo(
    "emits a TypeScript module-resolution error when a network file attempts `import type { MessageService } from '../task/services/message-service.js'` (type-only import)",
  );
  it.todo(
    "emits a TypeScript module-resolution error when a network file attempts `import { AppHost } from '../task/app-host.js'`",
  );
  it.todo(
    "accepts `import { NetworkDeliveryService } from '../network/layer.js'` from within the same subtree",
  );
  it.todo(
    "accepts `import { MessageService } from '../network/layer.js'` from a task file (one-way dep: task may import from network)",
  );
});
