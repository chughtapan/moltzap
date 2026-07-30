import { describe, expect, it } from "vitest";
import { ConfigProvider } from "effect";
import { getClientEventLogDir } from "./service-event-trace.js";

const EVENT_LOG_DIRECTORY_KEY = "MOLTZAP_CLIENT_EVENT_LOG_DIR";
const CONFIGURED_DIRECTORY = "configured-event-log-directory";

describe("client event trace configuration", () => {
  it("treats an explicitly empty directory as disabled", () => {
    const provider = ConfigProvider.fromMap(
      new Map([[EVENT_LOG_DIRECTORY_KEY, ""]]),
    );

    expect(getClientEventLogDir(provider)).toBeUndefined();
  });

  it("preserves a configured nonempty directory", () => {
    const provider = ConfigProvider.fromMap(
      new Map([[EVENT_LOG_DIRECTORY_KEY, CONFIGURED_DIRECTORY]]),
    );

    expect(getClientEventLogDir(provider)).toBe(CONFIGURED_DIRECTORY);
  });
});
