/** @file The native asset project uses the shared package checks. */
import { packageEslintConfig } from "../eslint.shared.js";

export default packageEslintConfig({ tsconfigRootDir: import.meta.dirname });
