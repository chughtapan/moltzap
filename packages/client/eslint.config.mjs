import { packageEslintConfig } from "../../eslint.shared.mjs";

export default packageEslintConfig({
  projects: [
    "./tsconfig.json",
    "./tsconfig.test.json",
    "./tsconfig.integration.json",
  ],
  tsconfigRootDir: import.meta.dirname,
});
