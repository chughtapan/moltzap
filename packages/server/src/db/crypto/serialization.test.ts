import { describe, expect, it } from "vitest";
import { deserializePayload } from "./serialization.js";

const SHAPE_ERROR_MESSAGE =
  "Encrypted payload must contain base64 c, i, and t fields.";
const malformedPayloadCases = [
  {
    description: "invalid JSON syntax",
    serialized: "{",
    message: "Encrypted payload must be valid JSON.",
  },
  {
    description: "a non-object value",
    serialized: "null",
    message: SHAPE_ERROR_MESSAGE,
  },
  {
    description: "a missing field",
    serialized: '{"c":"","i":""}',
    message: SHAPE_ERROR_MESSAGE,
  },
  {
    description: "a non-string field",
    serialized: '{"c":"","i":"","t":1}',
    message: SHAPE_ERROR_MESSAGE,
  },
];

describe("deserializePayload", () => {
  it.each(malformedPayloadCases)(
    "tags $description as an encrypted-payload parse error",
    ({ serialized, message }) => {
      const error = captureDeserializeError(serialized);
      expect(error).toMatchObject({
        _tag: "EncryptedPayloadParseError",
        message,
      });
    },
  );
});

function captureDeserializeError(serialized: string): unknown {
  try {
    deserializePayload(serialized);
    return undefined;
  } catch (error) {
    return error;
  }
}
