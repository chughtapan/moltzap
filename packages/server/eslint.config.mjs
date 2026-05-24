import { packageEslintConfig } from "../../eslint.shared.mjs";

// Cursor-opacity guard (spec #693 Invariant 2 / Invariant 3): an opaque
// `ListCursor` token is decoded ONLY by the `db/list-cursor.ts` codec.
// No other module may `atob(...)` it or `Buffer.from(token, "base64url")`
// it — a consumer that hand-parses the token couples to the encoding the
// server owns. The codec file itself is the single sanctioned decoder.
const cursorOpacityGuard = {
  files: ["src/**/*.ts"],
  ignores: ["src/db/list-cursor.ts", "**/*.test.ts", "**/*.spec.ts"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "CallExpression[callee.name='atob']",
        message:
          "Cursor tokens are opaque (spec #693 Invariant 2). Decode them only via db/list-cursor.ts → decodeListCursor.",
      },
      {
        selector:
          "CallExpression[callee.object.name='Buffer'][callee.property.name='from'][arguments.1.value='base64url']",
        message:
          "Cursor tokens are opaque (spec #693 Invariant 2). Decode them only via db/list-cursor.ts → decodeListCursor.",
      },
    ],
  },
};

export default [...packageEslintConfig(), cursorOpacityGuard];
