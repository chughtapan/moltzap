/**
 * Compile-time tests for network handler Context restriction.
 *
 * These are `it.todo` placeholders at the architect stage. The `implement-*`
 * pass fills each with a typed assertion — typically a `// @ts-expect-error`
 * against a handler that yields a forbidden tag — and a `// @ts-expect` pass
 * against a handler that yields only permitted tags.
 */

import { describe, it } from "vitest";

describe("NetworkRequiredContext — compile-time enforcement", () => {
  it.todo(
    "rejects a handler whose Effect requires MessageServiceTag at defineNetworkMethod",
  );
  it.todo(
    "rejects a handler whose Effect requires AppHostTag at defineNetworkMethod",
  );
  it.todo(
    "rejects a handler whose Effect requires ConversationServiceTag at defineNetworkMethod",
  );
  it.todo(
    "rejects a handler whose Effect requires DeliveryServiceTag (task surface) at defineNetworkMethod",
  );
  it.todo(
    "accepts a handler whose Effect requires only NetworkAuthServiceTag + NetworkConnIdTag",
  );
  it.todo(
    "accepts a handler whose Effect requires ContactCheckServiceTag + NetworkDeliveryServiceTag",
  );
});
