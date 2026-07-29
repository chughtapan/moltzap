import { packageEslintConfig } from "../../eslint.shared.mjs";

// Cursor-opacity guard: only `db/list-cursor.ts` may decode a cursor
// token. Banning `atob` / base64url `Buffer.from` elsewhere stops
// consumers from coupling to the encoding the server owns.
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

export default [
  ...packageEslintConfig({
    customJsDocTags: ["internal"],
    tsconfigRootDir: import.meta.dirname,
  }),
  cursorOpacityGuard,
];
