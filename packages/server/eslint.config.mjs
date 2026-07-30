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

const generatedDatabaseRules = {
  files: [
    "src/db/database.generated.ts",
    "src/db/database.ts",
    "src/conversation/conversation.service.ts",
    "src/message/message.service.ts",
    "src/task/task.service.ts",
    "src/identity/agents/handlers.ts",
    "src/__tests__/integration/task/encryption.test.ts",
    "src/standalone.ts",
    "src/test-utils/core-schema-sql.ts",
  ],
  rules: {
    // Kysely and SQL row contracts retain the database's exact snake_case
    // identifiers; platform error-tag mocks likewise retain their upstream
    // constructor names.
    "@typescript-eslint/naming-convention": "off",
  },
};

export default [
  ...packageEslintConfig({
    customJsDocTags: ["internal"],
    tsconfigRootDir: import.meta.dirname,
  }),
  generatedDatabaseRules,
  cursorOpacityGuard,
];
