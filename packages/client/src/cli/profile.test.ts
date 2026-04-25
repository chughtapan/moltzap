/**
 * Unit tests for the profile layer. Spec items §5.2 (`--profile`,
 * `--no-persist`), Invariants §4.3 (coexistence), §4.4 (no-disk-write).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  emitNoPersist,
  loadLayeredConfig,
  parseProfileName,
  ProfileInvalidNameError,
  ProfileNotFoundError,
  resolveProfileAuth,
  writeProfile,
  type ProfileName,
} from "./profile.js";

/**
 * Helper: create a temp dir, point MOLTZAP_CONFIG_HOME at it for the
 * duration of a test, seed with optional JSON, run fn, clean up.
 */
const withTmpConfigHome = async <T>(
  seed: unknown | undefined,
  fn: (tmp: string) => Promise<T>,
): Promise<T> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moltzap-profile-"));
  const originalHome = process.env.MOLTZAP_CONFIG_HOME;
  process.env.MOLTZAP_CONFIG_HOME = tmp;
  try {
    if (seed !== undefined) {
      fs.writeFileSync(
        path.join(tmp, "config.json"),
        JSON.stringify(seed, null, 2),
      );
    }
    return await fn(tmp);
  } finally {
    if (originalHome === undefined) {
      delete process.env.MOLTZAP_CONFIG_HOME;
    } else {
      process.env.MOLTZAP_CONFIG_HOME = originalHome;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

describe("parseProfileName", () => {
  it("accepts a valid lowercase-alphanumeric name", async () => {
    const name = await Effect.runPromise(parseProfileName("alice-bot"));
    expect(name).toBe("alice-bot");
  });

  it("rejects an empty string with ProfileInvalidNameError", async () => {
    const exit = await Effect.runPromiseExit(parseProfileName(""));
    expect(exit._tag).toBe("Failure");
  });

  it("rejects a name with uppercase letters", async () => {
    const exit = await Effect.runPromiseExit(parseProfileName("Alice"));
    expect(exit._tag).toBe("Failure");
  });

  it("rejects a name starting with a hyphen", async () => {
    const exit = await Effect.runPromiseExit(parseProfileName("-alice"));
    expect(exit._tag).toBe("Failure");
  });

  it("rejects a name ending with a hyphen", async () => {
    const exit = await Effect.runPromiseExit(parseProfileName("alice-"));
    expect(exit._tag).toBe("Failure");
  });

  it("fails with ProfileInvalidNameError type", async () => {
    const exit = await Effect.runPromiseExit(parseProfileName(""));
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause);
      expect(s).toMatch(/ProfileInvalidNameError/);
    }
  });
});

describe("loadLayeredConfig", () => {
  it("missing file resolves with empty view (default undefined, empty profiles)", async () => {
    await withTmpConfigHome(undefined, async () => {
      const view = await Effect.runPromise(loadLayeredConfig);
      expect(view.default).toBeUndefined();
      expect(view.profiles.size).toBe(0);
    });
  });

  it("legacy top-level { apiKey, agentName } populates default", async () => {
    await withTmpConfigHome(
      {
        serverUrl: "wss://x",
        apiKey: "k1",
        agentName: "a1",
      },
      async () => {
        const view = await Effect.runPromise(loadLayeredConfig);
        expect(view.default?.apiKey).toBe("k1");
        expect(view.default?.agentName).toBe("a1");
        expect(view.serverUrl).toBe("wss://x");
      },
    );
  });

  it("{ profiles: { alice: ... } } populates the profiles map", async () => {
    await withTmpConfigHome(
      {
        serverUrl: "wss://x",
        profiles: {
          alice: {
            apiKey: "k-alice",
            agentName: "alice",
            serverUrl: "wss://x",
          },
        },
      },
      async () => {
        const view = await Effect.runPromise(loadLayeredConfig);
        expect(view.profiles.size).toBe(1);
        const rec = view.profiles.get("alice" as ProfileName);
        expect(rec?.apiKey).toBe("k-alice");
      },
    );
  });

  it("tolerates unknown top-level keys", async () => {
    await withTmpConfigHome(
      {
        serverUrl: "wss://x",
        apiKey: "k",
        agentName: "a",
        // future-experimental key; should not cause a parse failure.
        futureExperimentalField: { nested: true },
      },
      async () => {
        const view = await Effect.runPromise(loadLayeredConfig);
        expect(view.default?.apiKey).toBe("k");
      },
    );
  });

  it("missing registeredAt on legacy-shaped profile still decodes", async () => {
    await withTmpConfigHome(
      {
        serverUrl: "wss://x",
        profiles: {
          bob: { apiKey: "k-bob", agentName: "bob", serverUrl: "wss://x" },
        },
      },
      async () => {
        const view = await Effect.runPromise(loadLayeredConfig);
        const rec = view.profiles.get("bob" as ProfileName);
        expect(rec?.registeredAt).toBeUndefined();
      },
    );
  });

  it("parse error surfaces as ProfileConfigReadError (no silent defaults)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moltzap-profile-"));
    const originalHome = process.env.MOLTZAP_CONFIG_HOME;
    process.env.MOLTZAP_CONFIG_HOME = tmp;
    try {
      fs.writeFileSync(path.join(tmp, "config.json"), "{not json}");
      const exit = await Effect.runPromiseExit(loadLayeredConfig);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        const s = JSON.stringify(exit.cause);
        expect(s).toMatch(/ProfileConfigReadError/);
      }
    } finally {
      if (originalHome === undefined) {
        delete process.env.MOLTZAP_CONFIG_HOME;
      } else {
        process.env.MOLTZAP_CONFIG_HOME = originalHome;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveProfileAuth", () => {
  it("undefined name returns the default record", async () => {
    await withTmpConfigHome(
      { serverUrl: "wss://x", apiKey: "k", agentName: "a" },
      async () => {
        const record = await Effect.runPromise(resolveProfileAuth(undefined));
        expect(record.apiKey).toBe("k");
      },
    );
  });

  it("unknown name returns ProfileNotFoundError (no fallback to default)", async () => {
    await withTmpConfigHome(
      { serverUrl: "wss://x", apiKey: "k", agentName: "a" },
      async () => {
        const exit = await Effect.runPromiseExit(
          resolveProfileAuth("ghost" as ProfileName),
        );
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const s = JSON.stringify(exit.cause);
          expect(s).toMatch(/ProfileNotFoundError/);
        }
      },
    );
  });

  it("known name returns the named record", async () => {
    await withTmpConfigHome(
      {
        serverUrl: "wss://x",
        profiles: {
          alice: {
            apiKey: "k-alice",
            agentName: "alice",
            serverUrl: "wss://x",
          },
        },
      },
      async () => {
        const record = await Effect.runPromise(
          resolveProfileAuth("alice" as ProfileName),
        );
        expect(record.apiKey).toBe("k-alice");
      },
    );
  });

  it("ProfileNotFoundError carries the requested name", () => {
    const err = new ProfileNotFoundError({ name: "nobody" });
    expect(err.name).toBe("nobody");
  });
});

describe("writeProfile", () => {
  it("writing under a named profile leaves top-level apiKey untouched", async () => {
    await withTmpConfigHome(
      { serverUrl: "wss://x", apiKey: "legacy-key", agentName: "legacy" },
      async (tmp) => {
        await Effect.runPromise(
          writeProfile("alice" as ProfileName, {
            apiKey: "k-alice",
            agentName: "alice",
            serverUrl: "wss://x",
          }),
        );
        const written = JSON.parse(
          fs.readFileSync(path.join(tmp, "config.json"), "utf-8"),
        );
        expect(written.apiKey).toBe("legacy-key");
        expect(written.profiles.alice.apiKey).toBe("k-alice");
      },
    );
  });

  it("writing 'default' updates top-level keys (not under profiles)", async () => {
    await withTmpConfigHome(undefined, async (tmp) => {
      await Effect.runPromise(
        writeProfile("default", {
          apiKey: "k",
          agentName: "a",
          serverUrl: "wss://x",
        }),
      );
      const written = JSON.parse(
        fs.readFileSync(path.join(tmp, "config.json"), "utf-8"),
      );
      expect(written.apiKey).toBe("k");
      expect(written.profiles).toBeUndefined();
    });
  });

  it("adding a second profile preserves the first", async () => {
    await withTmpConfigHome(
      {
        serverUrl: "wss://x",
        profiles: {
          alice: {
            apiKey: "k-alice",
            agentName: "alice",
            serverUrl: "wss://x",
          },
        },
      },
      async (tmp) => {
        await Effect.runPromise(
          writeProfile("bob" as ProfileName, {
            apiKey: "k-bob",
            agentName: "bob",
            serverUrl: "wss://x",
          }),
        );
        const written = JSON.parse(
          fs.readFileSync(path.join(tmp, "config.json"), "utf-8"),
        );
        expect(written.profiles.alice.apiKey).toBe("k-alice");
        expect(written.profiles.bob.apiKey).toBe("k-bob");
      },
    );
  });
});

describe("emitNoPersist", () => {
  it("never writes to ~/.moltzap/ (fs diff before/after is empty)", async () => {
    await withTmpConfigHome(undefined, async (tmp) => {
      const before = fs.readdirSync(tmp);
      await Effect.runPromise(
        emitNoPersist({
          apiKey: "k",
          agentName: "a",
          serverUrl: "wss://x",
        }),
      );
      const after = fs.readdirSync(tmp);
      expect(after).toEqual(before);
    });
  });

  it("returns the record unchanged for the caller to print", async () => {
    const record = {
      apiKey: "k",
      agentName: "a",
      serverUrl: "wss://x",
    };
    const result = await Effect.runPromise(emitNoPersist(record));
    expect(result.record).toEqual(record);
  });
});

describe("ProfileInvalidNameError", () => {
  it("carries name and reason", () => {
    const err = new ProfileInvalidNameError({ name: "Bad", reason: "upper" });
    expect(err.name).toBe("Bad");
    expect(err.reason).toBe("upper");
  });
});
