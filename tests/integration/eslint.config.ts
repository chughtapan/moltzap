/** @file Shared lint rules for the cross-package process suites. */
import { packageEslintConfig } from "../../eslint.shared.js";

export default packageEslintConfig({
  projects: ["./tsconfig.json", "./tsconfig.adapter-daemon.json"],
  tsconfigRootDir: import.meta.dirname,
});
