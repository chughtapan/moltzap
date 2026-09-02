/** @file The history export appends decodable lines and stops explicitly. */

import { FileSystem, Error as PlatformError } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { DateTime, Effect, Encoding, Schema } from "effect";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HistoryExportRecord,
  InboundMessage,
  PostId,
  SendInput,
} from "../../contract.js";
import { makeHistoryExport } from "./history-export.js";

/* eslint-disable agent-code-guard/async-keyword -- Vitest test bodies drive Effect programs from a Promise boundary. */

const decodeLine = Schema.decodeUnknownSync(
  Schema.parseJson(HistoryExportRecord),
);
const POST_ID = Schema.decodeUnknownSync(PostId)(
  `pst_${Encoding.encodeBase64Url(new Uint8Array(32).fill(5))}`,
);
const AT = DateTime.unsafeMake("2026-09-01T12:00:00.000Z");
const NO_SPACE = "ENOSPC: no space left on device";

function inbound(): HistoryExportRecord {
  return {
    kind: "inbound",
    message: Schema.decodeUnknownSync(InboundMessage)({
      kind: "direct",
      postId: POST_ID,
      address: "agent:bob",
      sender: "agent:bob",
      content: [{ type: "text", text: "hello" }],
    }),
    at: AT,
  };
}

function outbound(): HistoryExportRecord {
  const input = Schema.decodeUnknownSync(SendInput)({
    to: "agent:bob",
    content: [{ type: "text", text: "hi" }],
  });
  return {
    kind: "outbound",
    to: input.to,
    content: input.content,
    outcome: { kind: "certified", postId: POST_ID },
    at: AT,
  };
}

function decodeFile(text: string): readonly HistoryExportRecord[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decodeLine(line));
}

/**
 * A file system whose first append fails and whose later appends are kept,
 * so the one failure line the export writes afterwards can be observed.
 * @param writes Where every append that the file system accepted lands.
 * @returns The layer, failing exactly once.
 */
function failingOnce(writes: string[]) {
  let failuresLeft = 1;
  return FileSystem.layerNoop({
    writeFileString: (...[, data]) =>
      Effect.suspend(() => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Effect.fail(
            new PlatformError.SystemError({
              reason: "Unknown",
              module: "FileSystem",
              method: "writeFileString",
              description: NO_SPACE,
            }),
          );
        }
        writes.push(data);
        return Effect.void;
      }),
  });
}

const appendsDecodableLines = async () => {
  const text = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "moltzap-history-export-",
        });
        const path = join(directory, "history.ndjson");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sink = yield* makeHistoryExport(path);
            yield* sink.record(inbound());
            yield* sink.record(outbound());
          }),
        );
        return yield* fileSystem.readFileString(path);
      }),
    ).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  expect(text.endsWith("\n")).toBe(true);
  expect(decodeFile(text)).toEqual([inbound(), outbound()]);
};

const stopsAfterOneFailureLine = async () => {
  const writes: string[] = [];
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sink = yield* makeHistoryExport(
          "/var/run/moltzap/history.ndjson",
        );
        yield* sink.record(inbound());
        yield* sink.record(outbound());
        yield* sink.record(outbound());
      }),
    ).pipe(Effect.provide(failingOnce(writes))),
  );

  const lines = decodeFile(writes.join(""));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ kind: "export-failed" });
  expect(lines[0]?.kind === "export-failed" ? lines[0].reason : "").toContain(
    NO_SPACE,
  );
};

describe("history export", () => {
  it("appends one decodable line per record", appendsDecodableLines);
  it(
    "records one failure line, then stops exporting and keeps serving",
    stopsAfterOneFailureLine,
  );
});

/* eslint-enable agent-code-guard/async-keyword -- Restore repository defaults. */
